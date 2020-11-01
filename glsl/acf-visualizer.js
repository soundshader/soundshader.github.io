import * as log from '../log.js';
import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { textureUtils, shaderUtils } from "./basics.js";
import { GpuStatsProgram } from "./stats.js";
import * as vargs from "../vargs.js";

export class GpuAcfBandpassProgram {
  constructor(webgl, args) {
    if (!vargs.ACF_BANDPASS)
      return new GpuAcfVisualizerProgram(webgl, args);

    this.acf_r = new GpuAcfVisualizerProgram(webgl, { ...args });
    this.acf_g = new GpuAcfVisualizerProgram(webgl, { ...args });
    this.acf_b = new GpuAcfVisualizerProgram(webgl, { ...args });

    this.tex_r = new GpuFrameBuffer(webgl, { size: args.imgSize, channels: 4 });
    this.tex_g = new GpuFrameBuffer(webgl, { size: args.imgSize, channels: 4 });
    this.tex_b = new GpuFrameBuffer(webgl, { size: args.imgSize, channels: 4 });

    this.mixer = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uTexR;
        uniform sampler2D uTexG;
        uniform sampler2D uTexB;

        void main() {
          vec4 r = 0.33 * texture(uTexR, vTex);
          vec4 g = 0.33 * texture(uTexG, vTex);
          vec4 b = 0.33 * texture(uTexB, vTex);

          v_FragColor = r + g + b;
        }
      `,
    });
  }

  exec(args, output) {
    let [mx, my] = args.uMousePos;
    let w0 = mx * 0.5 + 0.5;

    this.acf_r.exec({ ...args, uFreq0: 0.0 * w0, uColor: [4, 2, 1] }, this.tex_r);
    this.acf_g.exec({ ...args, uFreq0: 0.5 * w0, uColor: [1, 4, 2] }, this.tex_g);
    this.acf_b.exec({ ...args, uFreq0: 1.0 * w0, uColor: [1, 2, 4] }, this.tex_b);

    this.mixer.exec({
      uTexR: this.tex_r,
      uTexG: this.tex_g,
      uTexB: this.tex_b,
    }, output);
  }
}

export class GpuAcfVisualizerProgram {
  constructor(webgl, { waveformLen, imgSize }) {
    this.webgl = webgl;

    // N = waveform.length
    // FFT = N x (re, im)
    // ACF = N x (re)

    let size = Math.min(waveformLen, vargs.ACF_MAX_SIZE);
    let aa = Math.log2(size / imgSize);

    if (aa != Math.floor(aa))
      throw new Error('ACF MSAA 2^N != ' + aa);

    this.imgSize = imgSize;
    this.isFlat = !!vargs.ACF_COORDS;

    this.gpuACF = new GpuACF(webgl, { size: waveformLen });
    this.recorder = new GpuRecorder(webgl, { size });
    this.heightMap = new GpuHeightMapProgram(webgl, { size });
    this.stats = new GpuStatsProgram(webgl, { size });
    this.downsampler1 = new GpuDownsampler(webgl, { width: size, height: size, aa });
    this.downsampler2 = new GpuDownsampler(webgl,
      { width: 1, height: waveformLen, aa: Math.log2(waveformLen / size) });
    this.colorizer = new GpuColorizer(webgl, { size, sigma: vargs.ACF_SIGMA });

    this.acfBuffer = new GpuFrameBuffer(webgl, { width: 1, height: waveformLen });
    this.acfBufferAA = new GpuFrameBuffer(webgl, { width: 1, height: size });
    this.acfImage1 = new GpuFrameBuffer(webgl, { size });
    this.acfImage2 = new GpuFrameBuffer(webgl, { size });
    this.heightMapAA = new GpuFrameBuffer(webgl, { size: imgSize });
    this.heightMapStats = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });

    log.i('ACF config:',
      'wave', 1, 'x', waveformLen, '->',
      'acf', 1, 'x', waveformLen, '->',
      'hmap', size, 'x', size, '->',
      'hmap.img', size >> aa, 'x', size >> aa, '->',
      'rgba', imgSize, 'x', imgSize);
  }

  exec({ uWaveFormRaw, uMousePos, uColor, uFreq0 }, output) {
    let [mx, my] = uMousePos;

    if (uWaveFormRaw) {
      this.gpuACF.exec({
        uFreq0,
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
    }

    if (output != GpuFrameBuffer.DUMMY) {
      this.heightMap.exec({
        uFlat: this.isFlat,
        uZoom: 1.0 + Math.exp(my * vargs.ACF_ZOOM),
        uExp: Math.exp(mx * vargs.ACF_EXP),
        uACF: this.acfImage2,
      });

      this.stats.exec({
        uData: this.heightMap.output,
      }, this.heightMapStats);

      this.downsampler1.exec({
        uImage: this.heightMap.output,
      }, this.heightMapAA);

      this.colorizer.exec({
        uColor: uColor || [4, 2, 1],
        uFlat: this.isFlat,
        uMX: mx * 0.5 + 0.5,
        uHeightMap: this.heightMapAA,
        uHeightMapStats: this.heightMapStats,
      }, output);
    }
  }
}

class GpuACF {
  constructor(webgl, { size }) {
    this.size = size;
    this.fft = new FFT(size, { webgl });

    let width = this.fft.shader.width;
    let height = this.fft.shader.height;

    this.temp = new Float32Array(size * 2);
    this.wave = new GpuFrameBuffer(webgl, { width, height });
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
        uniform float uMX;

        void main() {
          vec2 z = texture(uInput, vTex).xy;
          v_FragColor = vec4(dot(z, z), 0.0, 0.0, 0.0);
        }
      `,
    });

    this.bandpass = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;
        uniform float uFreq0;

        const float SIGMA = 0.05;
        const float PI = ${Math.PI};
        const float S_PI_2 = 1.0 / sqrt(2.0 * PI);

        float gaussian(float w) {
          float ws = w / SIGMA;
          return exp(-0.5 * ws * ws) * S_PI_2 / SIGMA;
        }

        float bandpass(float w0) {
          ivec2 size = textureSize(uInput, 0);
          ivec2 iv = ivec2(vTex * vec2(size) - 0.5);
          int i = iv.x + iv.y * size.x;
          int n = size.x * size.y;
          float w = 2.0 * float(i) / float(n);
          return gaussian(w0 - min(w, 1.0 - w));
        }

        void main() {
          vec4 tex = texture(uInput, vTex);
          float bp = bandpass(uFreq0);
          v_FragColor = bp * tex;
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

    this.flatten = new GpuTransformProgram(webgl, {
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

  exec({ uWaveFormRaw, uFreq0 }, uACF) {
    if (uACF.width != 1 || uACF.height != this.size)
      throw new Error('ACF output must be a 1xN buffer');
    if (uWaveFormRaw.length != this.size)
      throw new Error('ACF waveform must have N samples');

    this.wave.source = uWaveFormRaw;
    this.expand.exec({ uInput: this.wave }, this.temp1);
    this.fft.transform(this.temp1, this.temp2);
    this.sqrabs.exec({ uInput: this.temp2 }, this.temp1);

    if (vargs.ACF_BANDPASS) {
      this.bandpass.exec({
        uFreq0,
        uInput: this.temp1,
      }, this.temp2);

      [this.temp1, this.temp2] =
        [this.temp2, this.temp1];
    }

    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    this.fft.transform(this.temp1, this.temp2);
    this.justre.exec({ uInput: this.temp2 }, this.temp1);
    this.flatten.exec({ uInput: this.temp1 }, uACF);
  }
}

// Maps ACF values to a disk height map.
class GpuHeightMapProgram extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      size,
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uACF;
        uniform float uZoom;
        uniform float uExp;
        uniform bool uFlat;

        const float N = float(${size});
        const float PI = ${Math.PI};

        ${shaderUtils}
        ${textureUtils}

        float h_acf(vec2 ta) {
          return textureSmooth(uACF, ta).x;
        }

        float h_acf_msaa(float t, float a0, float s, int aa) {
          if (aa < 2)
            return h_acf(vec2(t, a0));

          float sum = 0.0;

          for (int j = 0; j < aa; j++) {
            float a = mix(a0 - s, a0 + s,
              (0.5 + float(j))/float(aa));
            sum += h_acf(vec2(t, a));
          }

          return sum / float(aa);
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

        float fetch_0() {
          float r = length(v);
          float t = 1.0 - pow(r, uExp) / uZoom;

          if (r < 0.5/N || r > 1.0 - 0.5/N || t < 0.5/N)
            return 0.0;

          float arg = atan2(v.y, v.x);
          float a = -0.25 + 0.5 * arg / PI;
          return h_acf(vec2(t, a));

          /* float s = 0.5 / N / PI / t;
          float q = rand(dot(vTex, vec2(1.2918, 0.9821)/PI)) - 0.5;
          return h_acf_msaa(t, a - s * q * 0.1, s,
            int(clamp(ceil(1.0 / PI / t), 1.0, 10.0))); */
        }

        float fetch_1() {
          float r = 1.0 - vTex.y;
          float t = 1.0 - pow(r, uExp) / uZoom;

          if (r < 0.5/N || r > 1.0 - 0.5/N || t < 0.5/N)
            return 0.0;

          float a = vTex.x - 0.5;
          return h_acf(vec2(t, a));
        }

        void main () {
          float h = uFlat ? fetch_1() : fetch_0();
          v_FragColor = vec4(h, 0.0, 0.0, 0.0);
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
        const float R_MAX = 0.9;
        const float N_SIGMA = float(${sigma});
        const bool CIRCLE = ${vargs.ACF_COORDS == 0};

        const vec2 dx = vec2(1.0, 0.0) / N;
        const vec2 dy = vec2(0.0, 1.0) / N;

        uniform float uMX;
        uniform bool uFlat;
        uniform vec3 uColor;
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

        vec3 hcolor_1(float h) {
          return clamp(abs(h) * uColor, 0.0, 1.0);
        }

        vec3 hcolor_2(float h) {
          float s = sign(h) * 0.5 + 0.5;
          vec3 rgb = mix(uColor, uColor.bgr, s);
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

          return clamp(lum * uColor, 0.0, 1.0);
        }

        vec3 hcolor_5(float h) {
          float s = sign(h) * 0.5 + 0.5;
          float g = 1.0 / (1.0 - min(0.0, log(abs(h * 2.0)) / log(1.5)));
          vec3 rgb = mix(uColor, uColor.bgr, s);
          return clamp(g * rgb, 0.0, 1.0);
        }

        vec3 hcolor_6(float h) {
          return vec3(h <= 0.0 ? 0.0 : 1.0);
        }

        vec4 rgba(vec2 vTex) {
          float r = length(v);
          if (r > 0.99 && CIRCLE && !uFlat)
            return vec4(0.0);
          float h = h_acf(vTex);
          vec3 rgb = hcolor_${vargs.ACF_COLOR_SCHEME}(h);
          vec4 rgba = vec4(rgb, 1.0);
          if (CIRCLE && !uFlat)
            rgba *= smoothstep(1.0, R_MAX, r);
          return rgba;
        }

        void main () {
          v_FragColor = rgba(vTex);
        }
      `,
    });
  }
}

class GpuDownsampler1x2 extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uImage;

        const float A = 1.0 / 6.0;
        const float B = 4.0 / 6.0;
        const float C = 1.0 / 6.0;

        vec4 rgba(int i) {
          return texelFetch(uImage, ivec2(0, i), 0);
        }

        void main () {
          int n = textureSize(uImage, 0).y;
          int i = int(vTex.y * float(n) - 0.5);

          vec4 a = A * rgba(i - 1);
          vec4 b = B * rgba(i);
          vec4 c = C / 6.0 * rgba(i + 1);

          v_FragColor = a + b + c;
        }
      `,
    });
  }
}

class GpuDownsampler2x2 extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uImage;

        const float A = 1.0 / 6.0;
        const float B = 4.0 / 6.0;
        const float C = 1.0 / 6.0;

        const ivec2 dx = ivec2(1, 0);
        const ivec2 dy = ivec2(0, 1);

        vec4 rgba(ivec2 v) {
          return texelFetch(uImage, v, 0);
        }

        vec4 xavg(ivec2 v) {
          vec4 a = A * rgba(v - dx);
          vec4 b = B * rgba(v);
          vec4 c = C * rgba(v + dx);

          return a + b + c;
        }

        vec4 yavg(ivec2 v) {
          vec4 a = A * xavg(v - dy);
          vec4 b = B * xavg(v);
          vec4 c = C * xavg(v + dy);

          return a + b + c;
        }

        void main () {
          ivec2 size = textureSize(uImage, 0);
          ivec2 v = ivec2(vTex * vec2(size) - 0.5);
          v_FragColor = yavg(v);
        }
      `,
    });
  }
}

class GpuDownsampler {
  constructor(webgl, { width, height, channels, aa }) {
    this.aa = aa;
    this.shader = width == 1 ?
      new GpuDownsampler1x2(webgl) :
      new GpuDownsampler2x2(webgl);
    this.copy = new GpuTransformProgram(webgl);
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

    if (!aa) {
      this.copy.exec({ uInput: uImage }, target);
      return;
    }

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
