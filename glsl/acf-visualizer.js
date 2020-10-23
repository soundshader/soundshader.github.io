import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { shaderUtils } from "./basics.js";
import { GpuStatsProgram } from "./stats.js";

export class GpuAcfVisualizerProgram {
  constructor(webgl, { size }) {
    this.webgl = webgl;
    this.image1 = new GpuFrameBuffer(webgl, { size: size * 2 });
    this.image2 = new GpuFrameBuffer(webgl, { size: size * 2 });
    this.recorder = new GpuRecorder(webgl, { size: size * 2 });
    this.heightMap = new GpuHeightMapProgram(webgl, { size });
    this.heightMapStats = new GpuStatsProgram(webgl, { size });
    this.colorizer = new GpuColorizer(webgl, { size: size * 2 });

    // canvas = size x size
    // FFT = 2*size x (re, im)
    // ACF = 2*size x (re)

    this.fftData = new Float32Array(size * 4);
    this.acfData = new Float32Array(size * 4);
    this.temp = new Float32Array(size * 4);
    this.reData = new Float32Array(size * 2);

    this.acfBuffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size * 2,
      source: this.reData,
    });
  }

  exec({ uWaveForm, uMousePos }, output) {
    FFT.forward(uWaveForm, this.fftData);
    FFT.sqr_abs_reim(this.fftData, this.temp);
    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    FFT.forward(this.temp, this.acfData);
    FFT.re(this.acfData, this.reData);

    [this.image1, this.image2] =
      [this.image2, this.image1];

    this.recorder.exec({
      uImage: this.image1,
      uSlice: this.acfBuffer,
    }, this.image2);

    this.heightMap.exec({
      uMousePos,
      uACF: this.image2,
    });

    this.heightMapStats.exec({
      uData: this.heightMap.output,
    });

    this.colorizer.exec({
      uMousePos,
      uHeightMap: this.heightMap.output,
      uHeightMapStats: this.heightMapStats.output,
    }, output);
  }
}

// Maps ACF values to a disk height map.
class GpuHeightMapProgram extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      size,
      fshader: `
        in vec2 v;

        uniform sampler2D uACF;
        uniform vec2 uMousePos;

        const float N = float(${size});
        const float PI = ${Math.PI};

        vec4 textureSmooth(sampler2D tex, vec2 ptr) {
          float dx = fract(ptr.x * N - 0.5);
          float dy = fract(ptr.y * N - 0.5);
          vec2 p1 = ptr - vec2(0.0 + dx, 0.0) / N;
          vec2 p2 = ptr + vec2(1.0 - dx, 0.0) / N;
          vec2 q1 = ptr - vec2(0.0, 0.0 + dy) / N;
          vec2 q2 = ptr + vec2(0.0, 1.0 - dy) / N;
          vec4 tp1 = texture(tex, p1);
          vec4 tp2 = texture(tex, p2);
          vec4 tq1 = texture(tex, q1);
          vec4 tq2 = texture(tex, q2);
          vec4 p = mix(tp1, tp2, 1.0 - dx);
          vec4 q = mix(tq1, tq2, 1.0 - dy);
          return mix(p, q, 0.5);
        }

        float h_acf(float a) {
          float zoom = 1.0 + exp(uMousePos.y * 3.0);
          float r = length(v);
          float t = 1.0 - r * 0.5 / zoom;
          return textureSmooth(uACF, vec2(t, a)).x;
        }

        void main () {
          float a = atan(v.y, v.x) / PI * 0.5;
          float h = h_acf(a - 0.25);
          v_FragColor = vec4(h);
        }
      `,
    });
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;
        in vec2 v;

        uniform vec2 uMousePos;
        uniform sampler2D uHeightMap;
        uniform sampler2D uHeightMapStats;

        const float N = float(${size});
        const float PI = ${Math.PI};
        const vec3 COLOR = vec3(1.0, 2.0, 4.0);

        ${shaderUtils}

        float hmap(vec2 vTex) {
          return texture(uHeightMap, vTex).x;
        }

        float grad(vec2 vTex) {
          float ds = 1.0 / N;
          float hx1 = hmap(vTex - vec2(ds, 0.0));
          float hx2 = hmap(vTex + vec2(ds, 0.0));
          float hy1 = hmap(vTex - vec2(0.0, ds));
          float hy2 = hmap(vTex + vec2(0.0, ds));
          float gx = hx2 - hx1;
          float gy = hy2 - hy1;
          return sqrt(gx*gx + gy*gy) * 0.5/ds;
        }

        void main () {
          vec4 stats = texture(uHeightMapStats, vec2(0.0));

          float h_min = stats.x; // -5*sigma
          float h_max = stats.y; // +5*sigma
          float h_avg = stats.z; // +/- 0.0
          float sigma = stats.w; // 0.3..0.5

          float h = hmap(vTex);
          // float g = grad(vTex);

          // float volume = 3.0 / (5.0 * sigma);
          // float h_norm = tanh((h - h_avg) * volume);
          // float g_norm = tanh(g * volume);

          vec3 rgb = COLOR * (abs(h) / 3.0 / sigma);
          rgb *= exp(-3.0 * dot(v, v));
          rgb *= 1.0 - exp(-1e2 * dot(v, v));

          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}

// Saves all vertical slices into a 2D buffer.
class GpuRecorder extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uImage;
        uniform sampler2D uSlice;

        const float N = float(${size});

        void main() {
          float dx = 1.0 / N;
          v_FragColor = vTex.x > 1.0 - 1.0 * dx ?
            texture(uSlice, vec2(0.5, vTex.y)) :
            texture(uImage, vTex + vec2(dx, 0.0));
        }
      `,
    });
  }
}
