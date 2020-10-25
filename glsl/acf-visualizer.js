import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { textureUtils, shaderUtils } from "./basics.js";
import { GpuStatsProgram } from "./stats.js";

const ACF_GRAD = 0;
const MAX_ACF_SIZE = 2048; // too slow otherwise

export class GpuAcfVisualizerProgram {
  constructor(webgl, { waveformLen, canvasSize }) {
    this.webgl = webgl;

    // N = waveform.length
    // FFT = N x (re, im)
    // ACF = N x (re)

    let size = Math.min(waveformLen, MAX_ACF_SIZE);
    let aa = size / canvasSize;

    console.log('ACF initializing with config:',
      'wave =', waveformLen,
      'fft size =', size,
      'canvas =', canvasSize);

    if (aa != Math.floor(aa))
      throw new Error('ACF MSAA cant work with ' + aa);

    this.gpuACF = new GpuACF(webgl, { size: waveformLen });
    this.recorder = new GpuRecorder(webgl, { size });
    this.heightMap = new GpuHeightMapProgram(webgl, { size });
    this.stats = new GpuStatsProgram(webgl, { size });
    this.downsampler = new GpuDownsampler(webgl, { size, aa });
    this.colorizer = new GpuColorizer(webgl, { sigma: 3.0 });

    this.acfBuffer = new GpuFrameBuffer(webgl, { width: 1, height: waveformLen });
    this.acfBufferAA = new GpuFrameBuffer(webgl, { width: 1, height: size });
    this.acfImage1 = new GpuFrameBuffer(webgl, { size });
    this.acfImage2 = new GpuFrameBuffer(webgl, { size });
    this.heightMapAA = new GpuFrameBuffer(webgl, { size: size / aa, channels: 4 });
    this.heightMapStats = new GpuFrameBuffer(webgl, { size, channels: 4 });
  }

  exec({ uWaveFormRaw, uMousePos }, output) {
    this.gpuACF.exec({
      uWaveFormRaw,
    }, this.acfBuffer);

    this.downsampler.exec({
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

    this.downsampler.exec({
      uImage: this.heightMap.output,
    }, this.heightMapAA);

    this.colorizer.exec({
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
      channels: 4,
      size,
      fshader: `
        in vec2 v;

        uniform sampler2D uACF;
        uniform float uZoom;

        const float N = float(${size});
        const float PI = ${Math.PI};
        const bool GRAD = ${!!ACF_GRAD};

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

          return vec4(
            h_acf(ta),
            GRAD ? t_grad(ta) : 0.0,
            GRAD ? a_grad(ta) : 0.0,
            0.0);
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
  constructor(webgl, { sigma }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        const float R_MIN = 0.05;
        const float R_MAX = 0.75;
        const float R_GAIN = 1.5;
        const float N_SIGMA = float(${sigma});
        const vec3 COLOR_1 = vec3(4.0, 2.0, 1.0);
        const vec3 COLOR_2 = vec3(1.0, 2.0, 4.0);

        uniform vec3 uColor;
        uniform sampler2D uHeightMap;
        uniform sampler2D uHeightMapStats;

        ${shaderUtils}

        float fadeoff(float r) {
          float r0 = 0.5 * (1.0 + R_MAX);
          float dr = 0.5 * (1.0 - R_MAX);
          return 0.5 + 0.5 * gain((r0 - r) / dr, R_GAIN);
        }

        float fadein(float r) {
          float r0 = 0.5 * R_MIN;
          return 0.5 + 0.5 * gain((r - r0) / r0, R_GAIN);
        }

        vec3 hcolor(float h) {
          float s = sign(h) * 0.5 + 0.5;
          vec3 rgb = mix(COLOR_2, COLOR_1, s);
          return clamp(abs(h) * rgb, 0.0, 1.0);
        }

        vec3 hcolor2(float h) {
          vec3 c1 = 0.33 * hcolor(h);
          vec3 c2 = 0.33 * hcolor(h * 1.4);
          vec3 c3 = 0.33 * hcolor(h * 2.0);
          return c1 + c2 + c3;
        }

        vec4 rgba(vec2 vTex) {
          float r = length(v);
          if (r > 0.99) return vec4(0.0);

          float h = texture(uHeightMap, vTex).x;
          vec4 stats = texture(uHeightMapStats, vec2(0.0));

          float h_min = stats.x; // -5*sigma
          float h_max = stats.y; // +5*sigma
          float h_avg = stats.z; // +/- 0.0
          float sigma = stats.w; // 0.3..0.5

          vec3 rgb = hcolor2(h / N_SIGMA / sigma);
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

class GpuDownsampler extends GpuTransformProgram {
  constructor(webgl, { size, aa }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        const int K_AA = ${aa};
        const int N = ${size};

        uniform sampler2D uImage;

        vec4 rgba(vec2 vTex) {
          return texture(uImage, vTex);
        }

        vec4 rgba_aa(vec2 vTex) {
          const float mid = float(K_AA/2) - 0.5;
          vec4 sum = vec4(0.0);

          for (int i = 0; i < K_AA; i++) {
            for (int j = 0; j < K_AA; j++) {
              vec2 ds = vec2(float(i) - mid, float(j) - mid);
              sum += rgba(vTex + ds / float(N));
            }
          }

          return sum / float(K_AA * K_AA);
        }

        void main () {
          v_FragColor = K_AA > 1 ?
            rgba_aa(vTex) :
            rgba(vTex);
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
