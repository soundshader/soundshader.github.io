import * as log from '../log.js';
import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { textureUtils, shaderUtils, colorUtils } from "./basics.js";
import { GpuStatsProgram } from "./stats.js";
import * as vargs from "../vargs.js";

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

    this.flat = !!vargs.ACF_COORDS;

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
    this.heightMapAA = new GpuFrameBuffer(webgl, { size: size >> aa });
    this.heightMapStats = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });

    log.i('ACF config:',
      'wave', 1, 'x', waveformLen, '->',
      'acf', 1, 'x', waveformLen, '->',
      'hmap', size, 'x', size, '->',
      'hmap.img', size >> aa, 'x', size >> aa, '->',
      'rgba', imgSize, 'x', imgSize);

    if (vargs.ACF_STATS > 0) {
      log.i('Logging ACF stats every', vargs.ACF_STATS, 'sec');
      setInterval(() => {
        let [min, max, avg, stddev] = this.heightMapStats.download();
        log.i('ACF stats:',
          'stddev', stddev.toExponential(2),
          'avg', (avg / stddev).toFixed(2) + 's',
          'min', (min / stddev).toFixed(2) + 's',
          'max', (max / stddev).toFixed(2) + 's');
      }, vargs.ACF_STATS * 1e3 | 0);
    }
  }

  exec({ uWaveFormRaw, uMousePos }, output) {
    let [mx, my] = uMousePos;

    if (uWaveFormRaw) {
      this.gpuACF.exec({
        uWaveFormRaw,
        uMX: mx * 0.5 + 0.5,
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
        uFlat: this.flat,
        uZoom: 1.0 + Math.exp(my * vargs.ACF_ZOOM),
        uACF: this.acfImage2,
      });

      this.stats.exec({
        uData: this.heightMap.output,
      }, this.heightMapStats);

      this.downsampler1.exec({
        uImage: this.heightMap.output,
      }, this.heightMapAA);

      this.colorizer.exec({
        uFlat: this.flat,
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

    this.aweight = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;

        float gaussian(float u, float sigma) {
          float s = u / sigma;
          return exp(-0.5 * s * s) / sigma / ${Math.sqrt(2 * Math.PI)};
        }

        float freq_abs(vec2 vTex) {
          ivec2 size = textureSize(uInput, 0);
          ivec2 iv = ivec2(vTex * vec2(size) - 0.5);
          int i = iv.x + iv.y * size.x;
          int n = size.x * size.y;
          float w = 2.0 * float(i) / float(n);
          return min(w, 1.0 - w) * 22.5e3;
        }

        float a_weight(float f) {
          const float C1 = float(${20.6 ** 2});
          const float C2 = float(${12200 ** 2});
          const float C3 = float(${107.7 ** 2});
          const float C4 = float(${737.9 ** 2});

          float f2 = f * f;

          float d0 = C2 * f2 * f2;
          float d1 = f2 + C1;
          float d2 = f2 + C2;
          float d3 = sqrt(f2 + C3);
          float d4 = sqrt(f2 + C4);

          float ra = d0 / (d1 * d2 * d3 * d4);
          return 2.0 + 20.0 * log(ra) / log(10.0);
        }

        void main() {
          float f = freq_abs(vTex);
          float a = a_weight(f);
          float w = pow(10.0, a / 20.0 * float(${vargs.ACF_A_WEIGHT}));
          v_FragColor = texture(uInput, vTex) * w;
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

  exec({ uWaveFormRaw, uMX }, uACF) {
    if (uACF.width != 1 || uACF.height != this.size)
      throw new Error('ACF output must be a 1xN buffer');
    if (uWaveFormRaw.length != this.size)
      throw new Error('ACF waveform must have N samples');
    this.temp0.source = uWaveFormRaw;
    this.expand.exec({ uInput: this.temp0 }, this.temp1);
    this.fft.transform(this.temp1, this.temp2);
    this.sqrabs.exec({ uInput: this.temp2 }, this.temp1);

    if (vargs.ACF_A_WEIGHT > 0) {
      this.aweight.exec({ uInput: this.temp1 }, this.temp2);
      [this.temp1, this.temp2] = [this.temp2, this.temp1];
    }

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
        in vec2 vTex;

        uniform sampler2D uACF;
        uniform float uZoom;
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
          float t = 1.0 - r / uZoom;

          if (r < 0.5/N || r > 1.0 - 0.5/N || t < 0.5/N)
            return 0.0;

          float arg = atan2(v.y, v.x);
          float a = -0.25 + 0.5 * arg / PI;
          return h_acf(vec2(t, a));
        }

        float fetch_1() {
          float r = 1.0 - vTex.y;
          float t = 1.0 - r / uZoom;

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

const parseRGB = str => str.split(',').map(x => (+x || 0).toFixed(3)).join(',');

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { size, sigma }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        const float N = ${size}.0;
        const float R_MAX = 0.9;
        const float N_SIGMA = float(${sigma});
        const vec3 COLOR_1 = vec3(${parseRGB(vargs.ACF_RGB_1)});
        const vec3 COLOR_2 = vec3(${parseRGB(vargs.ACF_RGB_2)});
        const bool CIRCLE = ${vargs.ACF_COORDS == 0};

        ${colorUtils}

        const vec2 dx = vec2(1.0, 0.0) / N;
        const vec2 dy = vec2(0.0, 1.0) / N;

        uniform float uMX;
        uniform bool uFlat;
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
          return clamp(abs(h) * COLOR_2, 0.0, 1.0);
        }

        vec3 hcolor_2(float h) {
          float s = sign(h) * 0.5 + 0.5;
          vec3 rgb = mix(COLOR_2, COLOR_1, s);
          return clamp(abs(h) * rgb, 0.0, 1.0);
        }

        vec3 hcolor_3(float h) {
          vec3 sum = vec3(0.0);
          float mag = 1.0;
          int num = 10;

          for (int k = 0; k < num; k++) {
            sum += hcolor_1(h * mag);
            mag *= 1.2;
          }
          
          return sum / float(num);
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

        vec3 hcolor_5(float h) {
          float s = sign(h) * 0.5 + 0.5;
          float g = 1.0 / (1.0 - min(0.0, log(abs(h * 2.0)) / log(1.5)));
          vec3 rgb = mix(COLOR_2, COLOR_1, s);
          return clamp(g * rgb, 0.0, 1.0);
        }

        vec3 hcolor_6(float h) {
          return vec3(h <= 0.0 ? 0.0 : 1.0);
        }

        vec3 hcolor_7(float h) {
          vec3 n = grad2(vTex);
          vec3 s = normalize(vec3(1.0, 1.0, 0.2));
          float g = dot(n, s) * 0.5;
          vec3 rgb = mix(COLOR_2, COLOR_1,
            clamp(5.0*h, -1.0, 1.0) * 0.5 + 0.5);
          return clamp(rgb * g, 0.0, 1.0);
        }

        vec3 hcolor_8(float h) {
          float hue = h < 0.0 ? 0.5 : 0.1;
          float sat = 1.0;
          float lts = abs(h);

          return hsl2rgb(vec3(hue, sat, lts));
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
