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
    this.colorizer = new GpuColorizer(webgl);

    // canvas = size x size
    // FFT = 2*size x (re, im)
    // ACF = 2*size x (re)

    this.gpuACF = new GpuACF(webgl, { size: size * 2 });

    this.acfBuffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size * 2,
    });
  }

  exec({ uWaveForm, uMousePos }, output) {
    this.gpuACF.exec({ uWaveForm }, this.acfBuffer);

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

class GpuACF {
  constructor(webgl, { size }) {
    this.size = size;
    this.fft = new FFT(size, { webgl });

    let width = this.fft.shader.width;
    let height = this.fft.shader.height;

    this.temp = new Float32Array(size * 2);
    this.temp1 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });
    this.temp2 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });

    this.sqrabs = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;
        void main() {
          vec2 z = texture(uInput, vTex).xy;
          v_FragColor = vec4(dot(z, z), 0.0, 0.0, 0.0);
        }
      `,
    });

    this.justre = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;
        void main() {
          float re = texture(uInput, vTex).x;
          v_FragColor = vec4(re, 0.0, 0.0, 0.0);
        }
      `,
    });

    this.reshape = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;

        void main() {
          ivec2 size = textureSize(uInput, 0);
          int i = int(vTex.y * float(size.x * size.y) - 0.5);
          int x = i % size.x;
          int y = i / size.x;
          v_FragColor = texelFetch(uInput, ivec2(x, y), 0);
        }
      `,
    });
  }

  exec({ uWaveForm }, uACF) {
    if (uACF.width != 1 || uACF.height != this.size)
      throw new Error('ACF output must be a 1xN buffer');
    this.fft.transform(uWaveForm, this.temp2);
    this.sqrabs.exec({ uInput: this.temp2 }, this.temp1);
    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    this.fft.transform(this.temp1, this.temp2);
    this.justre.exec({ uInput: this.temp2 }, this.temp1);
    this.reshape.exec({ uInput: this.temp1 }, uACF);
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
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 vTex;
        in vec2 v;

        const vec3 COLOR = vec3(1.0, 2.0, 4.0);

        uniform vec2 uMousePos;
        uniform sampler2D uHeightMap;
        uniform sampler2D uHeightMapStats;

        void main () {
          float h = texture(uHeightMap, vTex).x;
          vec4 stats = texture(uHeightMapStats, vec2(0.0));

          float h_min = stats.x; // -5*sigma
          float h_max = stats.y; // +5*sigma
          float h_avg = stats.z; // +/- 0.0
          float sigma = stats.w; // 0.3..0.5

          vec3 rgb = COLOR * (abs(h - h_avg) / 3.0 / sigma);
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
