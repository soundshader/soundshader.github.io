import * as log from '../log.js';
import * as vargs from "../vargs.js";
import { GpuFFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { textureUtils, shaderUtils, colorUtils } from "./basics.js";
import { GpuDownsampler } from './downsampler.js';

export class GpuAcfVisualizerProgram {
  constructor(webgl, { fft_size, img_size }) {
    this.webgl = webgl;
    this.flat = !!vargs.ACF_COORDS;

    let size = Math.min(fft_size, vargs.ACF_MAX_SIZE);
    let aa = Math.log2(size / img_size);

    log.assert(fft_size >= img_size);
    log.assert(aa == Math.floor(aa));

    this.gpuACF = new GpuACF(webgl, { fft_size, num_frames: size });
    this.heightMap = new GpuHeightMapProgram(webgl, { size, channels: 4 });
    this.smooth_max = new GpuSmoothMax(webgl, { size, factor: 0.99 });
    this.downsampler1 = new GpuDownsampler(webgl, { width: size, height: size, aa, channels: 4 });
    this.downsampler2 = new GpuDownsampler(webgl,
      { width: 1, height: fft_size, aa: Math.log2(fft_size / size), channels: 4 });
    this.colorizer = new GpuColorizer(webgl, { size });

    this.acfBuffer = new GpuFrameBuffer(webgl, { width: size, height: fft_size, channels: 4 });
    this.acfBufferAA = new GpuFrameBuffer(webgl, { size, channels: 4 });
    this.heightMapAA = new GpuFrameBuffer(webgl, { size: img_size, channels: 4 });
    this.fb_smooth_max = new GpuFrameBuffer(webgl, { width: size, height: 1 });

    log.i('ACF config:',
      'wave', 1, 'x', fft_size, '->',
      'acf', size, 'x', fft_size, '->',
      'hmap', size, 'x', size, '->',
      'hmap.img', img_size, 'x', img_size, '->',
      'rgba', img_size, 'x', img_size);
  }

  exec({ uWaveFormFB, uOffsetMin, uOffsetMax }, output) {
    if (uWaveFormFB) {
      this.gpuACF.exec({
        uWaveFormFB,
        uOffsetMin,
        uOffsetMax,
        uMX: 0,
      }, this.acfBuffer);

      this.downsampler2.exec({
        uImage: this.acfBuffer,
      }, this.acfBufferAA);
    }

    if (output != GpuFrameBuffer.DUMMY) {
      this.smooth_max.exec(
        this.acfBufferAA,
        this.fb_smooth_max);

      this.heightMap.exec({
        uFlat: this.flat,
        uACF: this.acfBufferAA,
        uSmoothMax: this.fb_smooth_max,
      });

      this.downsampler1.exec({
        uImage: this.heightMap.output,
      }, this.heightMapAA);

      this.colorizer.exec({
        uFlat: this.flat,
        uMX: 0,
        uHeightMap: this.heightMapAA,
      }, output);
    }
  }
}

class GpuACF {
  constructor(webgl, { fft_size, num_frames }) {
    this.fft_size = fft_size;
    this.num_frames = num_frames;
    this.fft = new GpuFFT(webgl, { width: num_frames, height: fft_size, layout: 'cols' });
    this.temp1a = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 1 });

    this.temp2a = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 2 });
    this.temp2b = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 2 });

    this.fft_rgb = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 4 });

    this.fft_r = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 1 });
    this.fft_g = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 1 });
    this.fft_b = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 1 });

    this.frame_selector = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uWaveFormFB;
        uniform int uOffsetMin;
        uniform int uOffsetMax;

        const int F = ${num_frames};
        const int N = ${fft_size};

        void main() {
          ivec2 size = textureSize(uWaveFormFB, 0);
          ivec2 pos = ivec2(vTex * vec2(ivec2(F, N)) - 0.5);
          int f = (uOffsetMin * (F - 1 - pos.x) + uOffsetMax * pos.x) / (F - 1) + pos.y;
          int i = f / size.x;
          int j = f % size.x;
          v_FragColor = j >= 0 && i >= 0 && j < size.x && i < size.y ?
            texelFetch(uWaveFormFB, ivec2(j, i), 0) :
            vec4(0.0);
        }
      `,
    });

    this.merge_rgb = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uR;
        uniform sampler2D uG;
        uniform sampler2D uB;

        void main() {
          float r = texture(uR, vTex).x;
          float g = texture(uG, vTex).x;
          float b = texture(uB, vTex).x;
          float a = sqrt(r*r + g*g + b*b);

          v_FragColor = vec4(a, r*r, g*g, b*b);
        }
      `,
    });

    this.sqr_abs = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;

        void main() {
          vec2 z = texture(uInput, vTex).xy;
          float d = dot(z, z);
          v_FragColor = vec4(d, 0.0, 0.0, 0.0);
        }
      `,
    });

    this.dot_prod = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;
        uniform vec4 uProd;

        void main() {
          v_FragColor = vec4(dot(uProd, texture(uInput, vTex)));
        }
      `,
    });

    this.hann_window = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        const float N = float(${fft_size});
        uniform sampler2D uWave;

        ${shaderUtils}

        void main() {
          float hw = hann(vTex.y - 0.5 / N);
          v_FragColor = hw * texture(uWave, vTex);
        }
      `,
    });

    this.rgb_mask = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uFFT;

        const float N = float(${fft_size});
        const float SR = float(${vargs.SAMPLE_RATE * 1000});
        const float A4 = float(${vargs.A4_FREQ});
        const float A0 = A4 / 4.0;

        ${shaderUtils}

        vec3 hann_hsv2rgb(vec3 hsv) {
          float hue = fract(hsv.x);
          float sat = clamp(hsv.y, 0.0, 1.0);
          float val = hsv.z;
          float r = 3.0 * min(hue, 1.0 - hue);
          float g = 3.0 * abs(hue - 1.0 / 3.0);
          float b = 3.0 * abs(hue - 2.0 / 3.0);
          r = r > 1.0 ? 0.0 : 1.0 - hann(r / 2.0);
          g = g > 1.0 ? 0.0 : 1.0 - hann(g / 2.0);
          b = b > 1.0 ? 0.0 : 1.0 - hann(b / 2.0);
          r = val * mix(1.0, r, sat);
          g = val * mix(1.0, g, sat);
          b = val * mix(1.0, b, sat);
          return vec3(r, g, b);
        }

        void main() {
          float f = vTex.y * N - 0.5;
          float freq_hz = SR * min(f, N - f) / N;
          float pitch = fract(log2(freq_hz / A4));
          float val = hann_step(freq_hz / A0, 0.0, 1.0);
          vec3 rgb = hann_hsv2rgb(vec3(pitch, 1.0, val));

          v_FragColor = texture(uFFT, vTex).x * vec4(rgb, 0.0);
        }
      `,
    });
  }

  exec({ uWaveFormFB, uOffsetMin, uOffsetMax }, uACF) {
    if (uACF.width != this.num_frames || uACF.height != this.fft_size || uACF.channels != 4)
      throw new Error('ACF output must be a FxNx4 buffer');
    if (uWaveFormFB.channels != 1)
      throw new Error('ACF input must be a NxNx1 buffer');

    this.frame_selector.exec({ uWaveFormFB, uOffsetMin, uOffsetMax }, this.temp1a);
    this.hann_window.exec({ uWave: this.temp1a }, this.temp2a);
    this.fft.exec({ uInput: this.temp2a }, this.temp2b);
    this.sqr_abs.exec({ uInput: this.temp2b }, this.temp2a);

    this.rgb_mask.exec({ uFFT: this.temp2a }, this.fft_rgb);
    this.dot_prod.exec({ uInput: this.fft_rgb, uProd: [1, 0, 0, 0] }, this.fft_r);
    this.dot_prod.exec({ uInput: this.fft_rgb, uProd: [0, 1, 0, 0] }, this.fft_g);
    this.dot_prod.exec({ uInput: this.fft_rgb, uProd: [0, 0, 1, 0] }, this.fft_b);

    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    this.fft.exec({ uInput: this.fft_r }, this.fft_r);
    this.fft.exec({ uInput: this.fft_g }, this.fft_g);
    this.fft.exec({ uInput: this.fft_b }, this.fft_b);

    this.merge_rgb.exec({ uR: this.fft_r, uG: this.fft_g, uB: this.fft_b }, uACF);
  }
}

class GpuHeightMapProgram extends GpuTransformProgram {
  constructor(webgl, { size, channels }) {
    super(webgl, {
      size,
      channels,
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uACF;
        uniform sampler2D uSmoothMax;
        uniform bool uFlat;

        const float N = float(${size});
        const float PI = ${Math.PI};
        const float R0 = float(${vargs.ACF_R0});

        ${shaderUtils}
        ${textureUtils}

        vec4 h_acf(vec2 ta) {
          float s_max = texture(uSmoothMax, vec2(ta.x, 0.0)).x;
          return s_max > 1e-10 ? textureSmooth(uACF, ta) / s_max : vec4(0.0);
        }

        vec4 fetch_disk() {
          float r = abs(length(v) - R0);
          if (r > 0.99) return vec4(0.0);
          float t = r;
          float arg = atan2(v.y, v.x);
          float a = -0.25 + 0.5 * arg / PI;
          return h_acf(vec2(t, a));
        }

        vec4 fetch_rect() {
          float r = vTex.x;
          float t = r;
          float a = vTex.y * 0.5;
          return h_acf(vec2(t, a));
        }

        void main () {
          v_FragColor = uFlat ? fetch_rect() : fetch_disk();
        }
      `,
    });
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        const float N = ${size}.0;
        const float R_MAX = 0.9;
        const bool CIRCLE = ${vargs.ACF_COORDS == 0};
        const float LOUDNESS_RANGE = float(${vargs.ACF_LOUDNESS_RANGE});

        ${colorUtils}

        const vec2 dx = vec2(1.0, 0.0) / N;
        const vec2 dy = vec2(0.0, 1.0) / N;

        uniform bool uFlat;
        uniform sampler2D uHeightMap;

        ${shaderUtils}

        vec4 h_acf() {
          return texture(uHeightMap, vTex);
        }

        float loudness(float x) {
          return x > 0.0 ? 1.0 + log10(x) / LOUDNESS_RANGE : 0.0;
        }

        vec3 h_rgb() {
          vec4 h = h_acf();
          float sat = 1.0 - h.x * h.x;
          vec3 rgb = h.yzw;
          float r = loudness(rgb.x);
          float g = loudness(rgb.y);
          float b = loudness(rgb.z);
          return mix(vec3(1.0), vec3(r, g, b), sat);
        }

        vec4 rgba(vec2 vTex) {
          float r = length(v);
          if (r > 0.99 && CIRCLE && !uFlat)
            return vec4(0.0);
          vec3 rgb = h_rgb();
          vec4 rgba = vec4(rgb, 1.0);
          if (CIRCLE && !uFlat)
            rgba *= smoothstep(1.0, R_MAX, r);
          return clamp(rgba, 0.0, 1.0);
        }

        void main () {
          v_FragColor = rgba(vTex);
        }
      `,
    });
  }
}

class GpuSmoothMax {
  constructor(webgl, { size, factor = 1.0 }) {
    this.size = size;
    this.copy = new GpuTransformProgram(webgl);

    this.h_max = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        const int N = ${size};
        uniform sampler2D uInput;

        vec4 get(int i, int j) {
          return texelFetch(uInput, ivec2(i, j), 0);
        }

        void main () {
          int n = textureSize(uInput, 0).y;
          int i = int(vTex.x * float(N) - 0.5);
          int j = int(vTex.y * float(n / 2) - 0.5);

          v_FragColor = max(get(i, 2 * j), get(i, 2 * j + 1));
        }
      `,
    });

    this.w_max = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        const int N = ${size};
        const float F = float(${factor});

        uniform sampler2D uInput;
        uniform int uScale; // 1, 2, 4, ...

        vec4 get(int i) {
          return texelFetch(uInput, ivec2(i, 0), 0);
        }

        void main () {
          int i = int(vTex.x * float(N) - 0.5);
          vec4 x = i >= uScale ? get(i - uScale) : vec4(0.0);
          v_FragColor = max(get(i), x * pow(F, float(uScale)));
        }
      `,
    });

    this.mipmaps = [];

    for (let i = 0; 2 ** i < size; i++)
      this.mipmaps[i] = new GpuFrameBuffer(webgl,
        { width: size, height: 2 ** i });

    this.tmp1d = new GpuFrameBuffer(webgl,
      { width: size, height: 1 });
  }

  exec(uInput, uOutput) {
    let n = this.size;
    log.assert(uInput.width == n && uInput.height == n);
    log.assert(uOutput.width == n && uOutput.height == 1);

    let mm = this.mipmaps;
    let mm_size = mm.length;

    for (let i = 0; i < mm_size; i++) {
      let input = i > 0 ? mm[mm_size - i] : uInput;
      let output = mm[mm_size - 1 - i];
      this.h_max.exec({ uInput: input }, output);
    }

    let fb1 = this.mipmaps[0];
    let fb2 = this.tmp1d;

    for (let i = 0; 2 ** i < n; i++) {
      this.w_max.exec({ uInput: fb1, uScale: 2 ** i }, fb2);
      [fb1, fb2] = [fb2, fb1];
    }

    this.copy.exec({ uInput: fb1 }, uOutput);
  }
}
