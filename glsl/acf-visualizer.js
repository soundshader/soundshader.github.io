import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { textureUtils, shaderUtils } from "./basics.js";
import { GpuStatsProgram } from "./stats.js";
import { ACF_COLOR_SCHEME } from "../vargs.js";

const MAX_ACF_SIZE = 2048; // too slow otherwise

export class GpuAcfVisualizerProgram {
  constructor(webgl, { waveformLen, canvasSize }) {
    this.webgl = webgl;

    // N = waveform.length
    // FFT = N x (re, im)
    // ACF = N x (re)

    let size = Math.min(waveformLen, MAX_ACF_SIZE);
    let aa = Math.log2(size / canvasSize);

    console.log('ACF initializing with config:',
      'wave =', waveformLen,
      'fft =', size,
      'canvas =', canvasSize);

    if (aa != Math.floor(aa))
      throw new Error('ACF MSAA 2^N != ' + aa);

    this.gpuACF = new GpuACF(webgl, { size: waveformLen });
    this.recorder = new GpuRecorder(webgl, { size });
    this.heightMap = new GpuHeightMapProgram(webgl, { size });
    this.stats = new GpuStatsProgram(webgl, { size });
    this.downsampler1 = new GpuDownsampler(webgl, { width: size, height: size, aa });
    this.downsampler2 = new GpuDownsampler(webgl,
      { width: 1, height: waveformLen, aa: Math.log2(waveformLen / size) });
    this.colorizer = new GpuColorizer(webgl, { size, sigma: 3.5 });

    this.acfBuffer = new GpuFrameBuffer(webgl, { width: 1, height: waveformLen });
    this.acfBufferAA = new GpuFrameBuffer(webgl, { width: 1, height: size });
    this.acfImage1 = new GpuFrameBuffer(webgl, { size });
    this.acfImage2 = new GpuFrameBuffer(webgl, { size });
    this.heightMapAA = new GpuFrameBuffer(webgl, { size: size >> aa });
    this.heightMapStats = new GpuFrameBuffer(webgl, { size, channels: 4 });
  }

  exec({ uWaveFormRaw, uMousePos }, output) {
    this.gpuACF.exec({
      uWaveFormRaw,
    }, this.acfBuffer);

    this.downsampler2.exec({
      uImage: this.acfBuffer,
    }, this.acfBufferAA);

    [this.acfImage1, this.acfImage2] =
      [this.acfImage2, this.acfImage1];

    this.recorder.exec({
      uImage: this.acfImage1,
      uSlice: this.acfBufferAA,
    }, this.acfImage2);

    let [mx, my] = uMousePos;
    let zoom = 1.0 + Math.exp(my * 5.0);

    this.heightMap.exec({
      uZoom: zoom,
      uACF: this.acfImage2,
    });

    this.stats.exec({
      uData: this.heightMap.output,
    }, this.heightMapStats);

    this.downsampler1.exec({
      uImage: this.heightMap.output,
    }, this.heightMapAA);

    this.colorizer.exec({
      uMX: mx * 0.5 + 0.5,
      uHeightMap: this.heightMapAA,
      uHeightMapStats: this.heightMapStats,
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
    this.temp0 = new GpuFrameBuffer(webgl, { width, height });
    this.temp1 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });
    this.temp2 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });

    this.expand = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;
        void main() {
          float re = texture(uInput, vTex).x;
          v_FragColor = vec4(re, 0.0, 0.0, 0.0);
        }
      `,
    });

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

  exec({ uWaveFormRaw }, uACF) {
    if (uACF.width != 1 || uACF.height != this.size)
      throw new Error('ACF output must be a 1xN buffer');
    if (uWaveFormRaw.length != this.size)
      throw new Error('ACF waveform must have N samples');
    this.temp0.source = uWaveFormRaw;
    this.expand.exec({ uInput: this.temp0 }, this.temp1);
    this.fft.transform(this.temp1, this.temp2);
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
        uniform float uZoom;

        const float N = float(${size});
        const float PI = ${Math.PI};

        ${textureUtils}

        float h_acf(vec2 ta) {
          return textureSmooth(uACF, ta).x;
        }

        float t_grad(vec2 ta) {
          const vec2 dt = vec2(1.0, 0.0) / N;
          float h1 = h_acf(ta - dt);
          float h2 = h_acf(ta + dt);
          return (h2 - h1) * 0.5 * N;
        }

        float a_grad(vec2 ta) {
          const vec2 da = vec2(0.0, 1.0) / N;
          float h1 = h_acf(ta - da);
          float h2 = h_acf(ta + da);
          return (h2 - h1) * 0.5 * N;
        }

        vec4 fetch() {
          float r = length(v);
          float t = 1.0 - r * 0.5 / uZoom;
          float a = -0.25 + 0.5 * atan(v.y, v.x) / PI;
          vec2 ta = vec2(t, a);
          return vec4(h_acf(ta), 0.0, 0.0, 0.0);
        }

        void main () {
          v_FragColor = length(v) < 1.0 ?
            fetch() : vec4(0.0);
        }
      `,
    });
  }
}

class GpuGradientProgram extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      size,
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uACF;

        void main () {
          vec4 acf = texture(uACF, vTex);
          // float g = length(acf.yz);
          float g = acf.z;
          v_FragColor = vec4(g);
        }
      `,
    });
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { size, sigma }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        const float N = ${size}.0;
        const float R_MIN = 0.05;
        const float R_MAX = 0.75;
        const float R_GAIN = 1.5;
        const float N_SIGMA = float(${sigma});
        const vec3 COLOR_1 = vec3(4.0, 2.0, 1.0);
        const vec3 COLOR_2 = vec3(1.0, 2.0, 4.0);

        const vec2 dx = vec2(1.0, 0.0) / N;
        const vec2 dy = vec2(0.0, 1.0) / N;

        uniform float uMX;
        uniform sampler2D uHeightMap;
        uniform sampler2D uHeightMapStats;

        ${shaderUtils}

        float h_acf(vec2 vTex) {
          float h = texture(uHeightMap, vTex).x;
          vec4 stats = texture(uHeightMapStats, vec2(0.0));

          float h_min = stats.x; // -5*sigma
          float h_max = stats.y; // +5*sigma
          float h_avg = stats.z; // +/- 0.0
          float sigma = stats.w; // 0.3..0.5

          return h / N_SIGMA / sigma;
        }

        vec3 grad(vec2 vTex) {
          float h1 = h_acf(vTex - dx);
          float h2 = h_acf(vTex + dx);
          float h3 = h_acf(vTex - dy);
          float h4 = h_acf(vTex + dy);

          float hx = (h2 - h1) * 0.5 * N;
          float hy = (h4 - h3) * 0.5 * N;

          vec3 g = vec3(hx, hy, 1.0);
          return normalize(g);
        }

        vec3 grad2(vec2 vTex) {
          vec3 g1 = grad(vTex - dx);
          vec3 g2 = grad(vTex + dx);
          vec3 g3 = grad(vTex - dy);
          vec3 g4 = grad(vTex + dy);
          return 0.25 * (g1 + g2 + g3 + g4);
        }

        float fadeoff(float r) {
          float r0 = 0.5 * (1.0 + R_MAX);
          float dr = 0.5 * (1.0 - R_MAX);
          return 0.5 + 0.5 * gain((r0 - r) / dr, R_GAIN);
        }

        float fadein(float r) {
          float r0 = 0.5 * R_MIN;
          return 0.5 + 0.5 * gain((r - r0) / r0, R_GAIN);
        }

        vec3 hcolor_1(float h) {
          return clamp(abs(h) * COLOR_2, 0.0, 1.0);
        }        

        vec3 hcolor_2(float h) {
          float s = sign(h) * 0.5 + 0.5;
          vec3 rgb = mix(COLOR_2, COLOR_1, s);
          return clamp(abs(h) * rgb, 0.0, 1.0);
        }

        vec3 hcolor_3(float h) {
          vec3 c1 = 0.2 * hcolor_1(h);
          vec3 c2 = 0.2 * hcolor_1(h * 1.5);
          vec3 c3 = 0.2 * hcolor_1(h * 2.0);
          vec3 c4 = 0.2 * hcolor_1(h * 2.5);
          vec3 c5 = 0.2 * hcolor_1(h * 3.0);
          return c1 + c2 + c3 + c4 + c5;
        }

        vec3 hcolor_4(float h) {
          vec3 n = grad2(vTex);
          vec3 l = vec3(1.0 - vTex * 2.0, 1.0);
          vec3 v = reflect(-l, n);
          vec3 b = normalize(v + l);

          // Blinn-Phong reflection model:
          // vr.cs.uiuc.edu/node198.html

          float lambert = abs(dot(n, l));
          float blinn = pow(abs(dot(n, b)), 1500.0);
          float lum = 0.4 * lambert + 0.6 * blinn;

          return clamp(lum * COLOR_1, 0.0, 1.0);
        }

        vec4 rgba(vec2 vTex) {
          float r = length(v);
          if (r > 0.99) return vec4(0.0);

          float h = h_acf(vTex);
          vec3 rgb = hcolor_${ACF_COLOR_SCHEME}(h);
          vec4 rgba = vec4(rgb, 1.0);
          rgba *= fadeoff(r);
          rgba *= fadein(r);
          return rgba;
        }

        void main () {
          v_FragColor = rgba(vTex);
        }
      `,
    });
  }
}

class GpuDownsampler2x2 extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uImage;

        vec4 rgba(vec2 vTex) {
          return texture(uImage, vTex);
        }

        void main () {
          ivec2 size = textureSize(uImage, 0);
          vec2 d = vec2(0.5, 0.5) / vec2(size);

          vec4 u1 = rgba(vTex - d.x - d.y);
          vec4 u2 = rgba(vTex - d.x + d.y);
          vec4 u3 = rgba(vTex + d.x + d.y);
          vec4 u4 = rgba(vTex + d.x - d.y);

          v_FragColor = 0.25 * (u1 + u2 + u3 + u4);
        }
      `,
    });
  }
}

class GpuDownsampler {
  constructor(webgl, { width, height, channels, aa }) {
    this.aa = aa;
    this.shader = new GpuDownsampler2x2(webgl);
    this.buffers = [];

    for (let i = 0; i < aa - 1; i++) {
      this.buffers[i] = new GpuFrameBuffer(webgl, {
        channels,
        width: Math.max(1, width >> (i + 1)),
        height: Math.max(1, height >> (i + 1)),
      });
    }
  }

  exec({ uImage }, target) {
    let aa = this.aa;

    for (let i = 0; i < aa; i++) {
      let input = this.buffers[i - 1] || uImage;
      let output = this.buffers[i] || target;
      this.shader.exec({ uImage: input }, output);
    }
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

class GpuMixer extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uImage1;
        uniform sampler2D uImage2;
        uniform float uBalance;

        void main() {
          vec4 tex1 = texture(uImage1, vTex);
          vec4 tex2 = texture(uImage2, vTex);
          v_FragColor = mix(tex1, tex2, uBalance);
        }
      `,
    });
  }
}

class GpuMirror extends GpuTransformProgram {
  constructor(webgl, { dx, dy }) {
    super(webgl, {
      fshader: `
        in vec2 v;

        const vec2 DIR = vec2(
          float(${dx}), float(${dy}));

        uniform sampler2D uImage;

        void main() {
          vec2 u = dot(DIR, v) < 0.0 ? v : reflect(v, DIR);
          v_FragColor = texture(uImage, u * 0.5 + 0.5);
        }
      `,
    });
  }
}
