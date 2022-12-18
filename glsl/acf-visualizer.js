import * as log from '../log.js';
import * as vargs from "../url_args.js";
import { GpuFFT, GpuDCT } from "../webfft.js";
import { GpuTransformProgram, GpuFrameBuffer } from "../webgl2.js";
import { textureUtils, shaderUtils, colorUtils, complexMath } from "./basics.js";
import { GpuDownsampler } from './downsampler.js';
import { GpuStatsFlat, GpuStatsProgram } from './stats.js';

export class GpuAcfVisualizerProgram {
  constructor(webgl, { fft_size, img_size }) {
    this.webgl = webgl;
    this.flat = !vargs.ACF_POLAR;
    this.show_acf = vargs.SHADER == 'acf';

    let size = Math.min(fft_size, vargs.ACF_MAX_SIZE);
    let aa = Math.log2(size / img_size);

    log.assert(fft_size >= img_size);
    log.assert(aa == Math.floor(aa));

    this.gpuACF = new GpuACF(webgl, { fft_size, num_frames: size });
    this.heightMap = new GpuHeightMapProgram(webgl, { size, channels: 4 });
    this.smooth_max = new GpuSmoothMax(webgl, { size, kernel_width: 1 / 16 });
    this.min_max = new GpuStatsProgram(webgl, { size });
    this.downsampler1 = new GpuDownsampler(webgl, { width: size, height: size, aa, channels: 4 });
    this.downsampler2 = new GpuDownsampler(webgl,
      { width: 1, height: fft_size, aa: Math.log2(fft_size / size), channels: 4 });
    this.colorizer = new GpuColorizer(webgl, { size });
    this.stats = new GpuStatsFlat(webgl, { width: size });

    this.acfBuffer = new GpuFrameBuffer(webgl, { width: size, height: fft_size, channels: 4 });
    this.acfBufferAA = new GpuFrameBuffer(webgl, { size, channels: 4 });
    this.heightMapAA = new GpuFrameBuffer(webgl, { size: img_size, channels: 4 });

    this.fb_r_max = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });
    this.fb_g_max = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });
    this.fb_b_max = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });
    this.fb_a_max = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });

    this.fb_smooth_max = new GpuFrameBuffer(webgl, { width: size, height: 1 });
    this.fb_smooth_max_stats = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });
  }

  exec({ uWaveFormFB, uOffsetMin, uOffsetMax }, output) {
    if (uWaveFormFB) {
      this.gpuACF.show_acf = this.show_acf;
      this.gpuACF.exec({
        uWaveFormFB,
        uOffsetMin,
        uOffsetMax,
      }, this.acfBuffer);

      this.downsampler2.exec({
        uImage: this.acfBuffer,
      }, this.acfBufferAA);
    }

    if (output != GpuFrameBuffer.DUMMY) {
      if (vargs.ACF_DYN_LOUDNESS) {
        this.smooth_max.exec(
          this.acfBufferAA,
          this.fb_smooth_max);
      } else {
        this.min_max.exec({
          uData: this.acfBufferAA,
          uMask: [1, 0, 0, 0],
        }, this.fb_r_max);

        this.min_max.exec({
          uData: this.acfBufferAA,
          uMask: [0, 1, 0, 0],
        }, this.fb_g_max);

        this.min_max.exec({
          uData: this.acfBufferAA,
          uMask: [0, 0, 1, 0],
        }, this.fb_b_max);

        this.min_max.exec({
          uData: this.acfBufferAA,
          uMask: [0, 0, 0, 1],
        }, this.fb_a_max);
      }

      this.heightMap.exec({
        uFlat: this.flat,
        uACF: this.acfBufferAA,
        uSmoothMax: this.fb_smooth_max,
        uRMax: this.fb_r_max,
        uGMax: this.fb_g_max,
        uBMax: this.fb_b_max,
        uAMax: this.fb_a_max,
      });

      this.downsampler1.exec({
        uImage: this.heightMap.output,
      }, this.heightMapAA);

      this.colorizer.exec({
        uFlat: this.flat,
        uHeightMap: this.heightMapAA,
      }, output);

      if (vargs.DEBUG) {
        this.stats.exec({ uData: this.fb_smooth_max },
          this.fb_smooth_max_stats);

        let [s_min, s_max, s_avg] = this.fb_smooth_max_stats.download();
        log.i('min..max:', Math.log10(s_min) * 20 | 0,
          '..', Math.log10(s_max) * 20 | 0, 'dB',
          'avg:', Math.log10(s_avg) * 20 | 0, 'dB');
      }
    }
  }
}

class GpuACF {
  constructor(webgl, { fft_size, num_frames }) {
    this.fft_size = fft_size;
    this.show_acf = true;
    this.freq_mod = 1;
    this.freq_rem = 0;
    this.num_frames = num_frames;

    this.fft = vargs.USE_DCT ?
      new GpuDCT(webgl, { width: num_frames, height: fft_size, layout: 'cols' }) :
      new GpuFFT(webgl, { width: num_frames, height: fft_size, layout: 'cols' });

    this.tex1 = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 2 });
    this.tex2 = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 2 });
    this.tex3 = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 2 });

    this.fft_a = new GpuFrameBuffer(webgl, { width: num_frames, height: fft_size, channels: 4 });
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
        const int INT_MAX = 0x7FFFFFFF;

        void main() {
          ivec2 size = textureSize(uWaveFormFB, 0);
          ivec2 pos = ivec2(vTex * vec2(ivec2(F, N)) - 0.5);
          int span = uOffsetMax - uOffsetMin; // up to size.x * size.y

          // Make sure this doesn't overflow int32.
          int diff = span < INT_MAX / pos.x ?
            span * pos.x / (F - 1) :
            span / (F - 1) * pos.x;
            
          int t = uOffsetMin + diff + pos.y;
          int i = t / (4 * size.x);
          int j = t % (4 * size.x);

          if (t < 0 || t >= size.x * size.y * 4) {
            v_FragColor = vec4(0.0);
            return;
          }

          vec4 tex = texelFetch(uWaveFormFB, ivec2(j / 4, i), 0);
          v_FragColor = vec4(tex[j % 4], 0.0, 0.0, 0.0);
        }
      `,
    });

    this.merge_rgb = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uA;
        uniform sampler2D uR;
        uniform sampler2D uG;
        uniform sampler2D uB;

        void main() {
          float a = texture(uA, vTex).x;
          float r = texture(uR, vTex).x;
          float g = texture(uG, vTex).x;
          float b = texture(uB, vTex).x;

          v_FragColor = vec4(r, g, b, a);
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
          if (${!vargs.HANN_WINDOW}) hw = 1.0;
          v_FragColor = hw * texture(uWave, vTex);
        }
      `,
    });

    this.freq_colors = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uFFT;

        ${shaderUtils}

        void main() {
          float f = 2.0 * min(vTex.y, 1.0 - vTex.y);
          float r = 1.0 - hann_step(f, 0.0, 0.5);
          float b = hann_step(f, 0.25, 1.0); 
          float g = 1.0 - r - b;
          v_FragColor = texture(uFFT, vTex).x * vec4(r, g, b, 1.0);
        }
      `,
    });

    this.transpose = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;

        void main() {
          v_FragColor = texture(uInput, vec2(vTex.y, vTex.x));
        }
      `,
    });
  }

  exec({ uWaveFormFB, uOffsetMin, uOffsetMax }, uACF) {
    if (uACF.width != this.num_frames || uACF.height != this.fft_size || uACF.channels != 4)
      throw new Error('ACF output must be a FxNx4 buffer');
    if (uWaveFormFB.channels != 4)
      throw new Error('ACF input must be a NxNx4 buffer');

    let t1 = this.tex1, t2 = this.tex2, t3 = this.tex3;

    this.frame_selector.exec({ uWaveFormFB, uOffsetMin, uOffsetMax }, t1);
    this.hann_window.exec({ uWave: t1 }, t2);
    this.fft.exec({ uInput: t2 }, t3);
    this.sqr_abs.exec({ uInput: t3 }, t2);

    if (vargs.ACF_RGB) {
      this.freq_colors.exec({ uFFT: t2 }, this.fft_a);
      this.dot_prod.exec({ uInput: this.fft_a, uProd: [1, 0, 0, 0] }, this.fft_r);
      this.dot_prod.exec({ uInput: this.fft_a, uProd: [0, 1, 0, 0] }, this.fft_g);
      this.dot_prod.exec({ uInput: this.fft_a, uProd: [0, 0, 1, 0] }, this.fft_b);
    }

    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    if (this.show_acf) {
      this.fft.exec({ uInput: t2 }, t2);
      if (vargs.ACF_RGB) {
        this.fft.exec({ uInput: this.fft_r }, this.fft_r);
        this.fft.exec({ uInput: this.fft_g }, this.fft_g);
        this.fft.exec({ uInput: this.fft_b }, this.fft_b);
      }
    }

    if (vargs.H_TACF.get() == '1') {
      for (let t of [t2]) {
        this.transpose.exec({ uInput: t }, t1);
        // this.hann_window.exec({ uWave: t1 }, t2);
        this.fft.exec({ uInput: t1 }, t3);
        this.sqr_abs.exec({ uInput: t3 }, t1);
        this.fft.exec({ uInput: t1 }, t1);
        this.transpose.exec({ uInput: t1 }, t);
      }
    }

    this.merge_rgb.exec({
      uA: t2,
      uR: this.fft_r,
      uG: this.fft_g,
      uB: this.fft_b
    }, uACF);
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
        uniform sampler2D uRMax;
        uniform sampler2D uGMax;
        uniform sampler2D uBMax;
        uniform sampler2D uAMax;
        uniform bool uFlat;

        const float N = float(${size});
        const float PI = ${Math.PI};
        const float R0 = float(${vargs.ACF_R0});

        ${shaderUtils}
        ${textureUtils}

        vec4 h_acf(vec2 ta) {
          float t_max = mix(1.0 - 0.5/N, ta.x, float(${vargs.ACF_DYN_LOUDNESS}));
          vec4 s_max = texture(uSmoothMax, vec2(t_max, 0.0)).xxxx;

          if (${!vargs.ACF_DYN_LOUDNESS}) {
            vec4 r = texture(uRMax, vec2(0.0));
            vec4 g = texture(uGMax, vec2(0.0));
            vec4 b = texture(uBMax, vec2(0.0));
            vec4 a = texture(uAMax, vec2(0.0));

            s_max.x = max(abs(r.x), abs(r.y));
            s_max.y = max(abs(g.x), abs(g.y));
            s_max.z = max(abs(b.x), abs(b.y));
            s_max.w = max(abs(a.x), abs(a.y));
          }

          // if (s_max <= 0.0) return vec4(0.0);
          // return textureSmooth(uACF, ta) / s_max;
          return texture(uACF, ta) / s_max;
        }

        vec4 fetch_disk() {
          float r = abs(length(v) - R0);
          if (r > 0.99) return vec4(0.0);
          float arg = atan2(v.y, v.x);
          float a = ${!!vargs.USE_DCT} ?
            abs(mod(arg/PI + 2.5, 2.0) - 1.0) :
            -0.25 + 0.5 * arg / PI;
          a *= 2.0; // vertical symmetry
          return h_acf(vec2(r, a));
        }

        vec4 fetch_rect() {
          float r = vTex.x;
          float t = r;
          float a = vTex.y / float(${vargs.ZOOM});
          if (${!vargs.USE_DCT}) a *= 0.5;
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
        const bool CIRCLE = true;
        const float LOUDNESS_RANGE = float(${vargs.DB_RANGE / 20});

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
          return x <= 0.0 ? 0.0 : 1.0 + log10(x) / LOUDNESS_RANGE;
        }

        vec3 h_rgb() {
          vec4 h = h_acf();
          float sat = ${vargs.DB_RANGE <= 0} ?
            1.0 : 1.0 - h.w * h.w;
          vec3 c = ${!!vargs.ACF_RGB || vargs.DB_RANGE <= 0}
            ? abs(h.xyz) : abs(h.w) * vec3(1.0, 1.0, 1.0);
          if (${vargs.DB_RANGE > 0}) {
            c.r = loudness(c.r);
            c.g = loudness(c.g);
            c.b = loudness(c.b);
            c = clamp(c, 0.0, 1.0);
          } else {
            const mat3 mx = mat3(
              16.0, 4.0, 1.0,
              0.0, 1.0, 0.0,
              1.0, 2.0, 8.0);
            c = mx * c;
          }
          return mix(vec3(1.0), c, sat);
        }

        vec4 rgba() {
          float r = length(v);
          if (r > 0.99 && CIRCLE && !uFlat)
            return vec4(0.0);
          vec3 rgb = h_rgb();

          if (${vargs.DB_RANGE < 0})
             rgb *= -LOUDNESS_RANGE;

          vec4 rgba = vec4(rgb, 1.0);
          // if (CIRCLE && !uFlat)
          //   rgba *= smoothstep(1.0, R_MAX, r);
          return clamp(rgba, 0.0, 1.0);
        }

        void main () {
          v_FragColor = rgba();
        }
      `,
    });
  }
}

// Finds the average volume at each time step. The average is found
// by applying a window function (Hann) of width |kernel_width|. It's
// essentially a convolution, so FFT is used to do it in NlogN steps.
class GpuSmoothMax {
  constructor(webgl, { size, kernel_width }) {
    log.assert(kernel_width > 0 && kernel_width < 1);
    this.size = size;

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

    this.init_kernel = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        const float KW = float(${kernel_width});

        ${shaderUtils}

        void main () {
          float t = min(vTex.x, 1.0 - vTex.x);
          float h = 1.0 - hann_step(t, 0.0, KW * 0.5);
          v_FragColor = vec4(h, 0.0, 0.0, 0.0);
        }
      `,
    });

    this.dot_prod = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uA;
        uniform sampler2D uB;

        ${complexMath}

        void main () {
          vec2 a = texture(uA, vTex).xy;
          vec2 b = texture(uB, vTex).xy;
          v_FragColor = vec4(imul(a, b), 0.0, 0.0);
        }
      `,
    });

    this.mipmaps = [];

    for (let i = 0; 2 ** i < size; i++)
      this.mipmaps[i] = new GpuFrameBuffer(webgl,
        { width: size, height: 2 ** i });

    this.fb2 = new GpuFrameBuffer(webgl, { width: size, height: 1, channels: 2 });
    this.fb3 = new GpuFrameBuffer(webgl, { width: size, height: 1, channels: 2 });
    this.fb4 = new GpuFrameBuffer(webgl, { width: size, height: 1, channels: 2 });

    this.fft = new GpuFFT(webgl, { width: size, height: 1 });
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
    let fb2 = this.fb2; // kernel
    let fb3 = this.fb3; // FFT[fb1]
    let fb4 = this.fb4; // dot(fb2, fb3)

    this.init_kernel.exec({}, fb2);

    // uOutput = convolve(fb1, fb2)
    this.fft.exec({ uInput: fb2 }, fb2);
    this.fft.exec({ uInput: fb1 }, fb3);
    this.dot_prod.exec({ uA: fb2, uB: fb3 }, fb4);
    this.fft.exec({ uInput: fb4, uInverseFFT: true }, uOutput);
  }
}
