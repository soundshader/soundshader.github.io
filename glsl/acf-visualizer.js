import * as log from '../log.js';
import * as vargs from "../url_args.js";
import { GpuFFT, GpuDCT } from "../webfft.js";
import { GpuTransformProgram, GpuFrameBuffer } from "../webgl2.js";
import { textureUtils, shaderUtils, colorUtils, complexMath } from "./basics.js";
import { GpuDownsampler } from './downsampler.js';
import { GpuStatsFlat, GpuStatsProgram } from './stats.js';

const vconf = vargs.vconf;

export class GpuAcfVisualizerProgram {
  constructor(webgl, { fft_size, img_size }) {
    log.i('Initializing ACF renderer');
    img_size = Math.min(img_size, fft_size);

    this.webgl = webgl;
    this.flat = false;
    this.show_acf = vargs.SHADER == 'acf';

    let size = fft_size;
    let aa = Math.log2(size / img_size);

    log.assert(fft_size >= img_size, 'Img is too large');
    log.assert(aa == Math.floor(aa));

    this.gpuACF = new GpuACF(webgl, { fft_size, num_frames: size });
    this.heightMap = new GpuHeightMapProgram(webgl, { size, channels: 4 });
    this.smooth_max = new GpuSmoothMax(webgl, { size, kernel_width: 1 / 16 });
    this.min_max = new GpuStatsProgram(webgl, { size });
    this.downsampler1 = new GpuDownsampler(webgl, { size, aa, channels: 4 });
    this.colorizer = new GpuColorizer(webgl, { size });
    this.stats = new GpuStatsFlat(webgl, { width: size });

    this.acfBuffer = new GpuFrameBuffer(webgl, { size: fft_size, channels: 4 });
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
    }

    if (output != GpuFrameBuffer.DUMMY) {
      if (vconf.ACF_DYN_LOUDNESS) {
        this.smooth_max.exec(
          this.acfBuffer,
          this.fb_smooth_max);
      } else {
        this.min_max.exec({
          uData: this.acfBuffer,
          uMask: [1, 0, 0, 0],
        }, this.fb_r_max);

        this.min_max.exec({
          uData: this.acfBuffer,
          uMask: [0, 1, 0, 0],
        }, this.fb_g_max);

        this.min_max.exec({
          uData: this.acfBuffer,
          uMask: [0, 0, 1, 0],
        }, this.fb_b_max);

        this.min_max.exec({
          uData: this.acfBuffer,
          uMask: [0, 0, 0, 1],
        }, this.fb_a_max);
      }

      this.heightMap.exec({
        uACF: this.acfBuffer,
        uFlat: this.flat,
        uDynLoud: vconf.ACF_DYN_LOUDNESS,
        uSmoothMax: this.fb_smooth_max,
        uNumSym: vconf.N_SYMM,
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
        uDBMax: vconf.DB_MAX,
        uDBLog: vconf.DB_LOG,
        uRGB: vconf.ACF_RGB,
        uGrad: vconf.H_GRAD,
        uGradZoom: vconf.GRAD_ZOOM,
        uNumSamples: vconf.NUM_SAMPLES,
      }, output);
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

    this.fft = vconf.USE_DCT ?
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
        uniform float uHighPass; // 0..1, freq high pass filter

        void main() {
          vec2 z = texture(uInput, vTex).xy;
          float d = dot(z, z);
          float hpf = step(uHighPass, min(vTex.y, 1.0 - vTex.y));
          v_FragColor = vec4(d * hpf, 0.0, 0.0, 0.0);
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
          if (${!vconf.HANN_WINDOW}) hw = 1.0;
          v_FragColor = hw * texture(uWave, vTex);
        }
      `,
    });

    this.freq_colors = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uFFT;
        uniform bool uHzHue;

        ${shaderUtils}
        ${colorUtils}

        vec3 hz_to_hue(float hz) {
          float phi = fract(log2(hz / 555.0));
          // if (2 > 1) return hue2rgb(phi); // DEBUG

          vec2 ep = vec2(cos(2.0*PI*phi), sin(2.0*PI*phi));

          const vec2 R = vec2(1.0, 0.0);
          const vec2 G = vec2(cos(2.0*PI/3.0), sin(2.0*PI/3.0));
          const vec2 B = G * vec2(1.0, -1.0);

          float r = max(0.0, dot(ep, R) - 0.5) / 0.5;
          float g = max(0.0, dot(ep, G) - 0.5) / 0.5;
          float b = max(0.0, dot(ep, B) - 0.5) / 0.5;

          const vec3 RS = 4.0 * vec3(1.0, 0.2, 0.1);
          const vec3 GS = 4.0 * vec3(0.2, 1.0, 0.1);
          const vec3 BS = 4.0 * vec3(0.2, 0.1, 1.0);

          // return vec3(r, g, b);
          return r*RS + g*GS + b*BS;
        }

        vec3 bp_to_hue(float f) {
          float r = 1.0 - hann_step(f, 0.0, 0.5);
          float b = hann_step(f, 0.25, 1.0); 
          float g = 1.0 - r - b;
          return vec3(r, g, b);
        }

        void main() {
          float f = 2.0 * min(vTex.y, 1.0 - vTex.y);
          float hz = f * float(${vconf.SAMPLE_RATE / 2});
          vec3 rgb = uHzHue ? hz_to_hue(hz) : bp_to_hue(f);
          v_FragColor = texture(uFFT, vTex).x * vec4(rgb, 1.0);
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
    this.sqr_abs.exec({ uInput: t3, uHighPass: vconf.FREQ_MIN / vconf.SAMPLE_RATE }, t2);

    if (vconf.ACF_RGB) {
      this.freq_colors.exec({ uFFT: t2, uHzHue: vconf.HZ_HUE }, this.fft_a);
      this.dot_prod.exec({ uInput: this.fft_a, uProd: [1, 0, 0, 0] }, this.fft_r);
      this.dot_prod.exec({ uInput: this.fft_a, uProd: [0, 1, 0, 0] }, this.fft_g);
      this.dot_prod.exec({ uInput: this.fft_a, uProd: [0, 0, 1, 0] }, this.fft_b);
    } else {
      this.fft_a.clear();
      this.fft_r.clear();
      this.fft_g.clear();
      this.fft_b.clear();
    }

    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    if (this.show_acf) {
      this.fft.exec({ uInput: t2 }, t2);
      if (vconf.ACF_RGB) {
        this.fft.exec({ uInput: this.fft_r }, this.fft_r);
        this.fft.exec({ uInput: this.fft_g }, this.fft_g);
        this.fft.exec({ uInput: this.fft_b }, this.fft_b);
      }
    }

    if (vconf.H_TACF) {
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
      uB: this.fft_b,
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
        uniform float uNumSym;
        uniform bool uFlat;
        uniform bool uDynLoud;

        const float N = float(${size});
        const float R0 = 0.0;

        ${shaderUtils}
        ${textureUtils}

        vec4 h_acf(vec2 ta) {
          vec4 s_max = vec4(0.0);;

          if (uDynLoud) {
            s_max = texture(uSmoothMax, vec2(ta.x, 0.0)).xxxx;
          } else {
            vec4 r = texture(uRMax, vec2(0.0));
            vec4 g = texture(uGMax, vec2(0.0));
            vec4 b = texture(uBMax, vec2(0.0));
            vec4 a = texture(uAMax, vec2(0.0));

            s_max.r = max(1e-6, max(abs(r.x), abs(r.y)));
            s_max.g = max(1e-6, max(abs(g.x), abs(g.y)));
            s_max.b = max(1e-6, max(abs(b.x), abs(b.y)));
            s_max.a = max(1e-6, max(abs(a.x), abs(a.y)));
          }

          // if (s_max <= 0.0) return vec4(0.0);
          // return textureSmooth(uACF, ta) / s_max;
          return texture(uACF, ta) / s_max;
        }

        vec4 fetch_disk() {
          float r = abs(length(v) - R0);
          if (r > 0.99) return vec4(0.0);
          float arg = atan2(v.y, v.x);
          float a = ${!!vconf.USE_DCT} ?
            abs(mod(arg/PI + 2.5, 2.0) - 1.0) :
            -0.25 + 0.5 * arg / PI;
          
          a = fract(1.0 + a);
          if (a > 0.5) a -= 1.0;
          a *= uNumSym;
          a = fract(a);
          if (a > 0.5) a -= 1.0;

          // a /= pow(sin(r * PI), 0.5)/2.0;
          // if (abs(a) > 0.5) return vec4(0.0);

          return h_acf(vec2(r, a));
        }

        vec4 fetch_rect() {
          float r = vTex.x;
          float t = r;
          float a = vTex.y / float(${vargs.ZOOM});
          if (${!vconf.USE_DCT}) a *= 0.5;
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
        const vec2 dx = vec2(1.0, 0.0) / N;
        const vec2 dy = vec2(0.0, 1.0) / N;

        uniform int uNumSamples;
        uniform bool uGrad;
        uniform float uGradZoom;
        uniform bool uFlat;
        uniform bool uRGB;
        uniform float uDBMax;
        uniform bool uDBLog;
        uniform sampler2D uHeightMap;

        ${colorUtils}
        ${shaderUtils}
        ${textureUtils}

        vec4 h_acf(vec2 vTex) {
          return textureGauss(uHeightMap, vTex);
        }

        vec4 g_acf(vec2 ta) {
          float f = 0.5 * pow(10.0, uGradZoom);
          vec4 lt = h_acf(ta);
          vec4 rt = h_acf(ta + dx);
          vec4 lb = h_acf(ta + dy);
          vec4 rb = h_acf(ta + dx + dy);
          vec4 gx = f * (rt + rb - lt - lb);
          vec4 gy = f * (rt - rb + lt - lb);
          vec4 gz = 1.0 / sqrt(1.0 + gx*gx + gy*gy);
          return gz;
        }

        float loudness(float x) {
          return x <= 0.0 ? 0.0 : 1.0 + log10(x) / uDBMax * 20.0;
        }

        vec3 h_rgb(vec2 vTex) {
          vec4 h = uGrad ? g_acf(vTex) : h_acf(vTex);
          float sat = 1.0; // uRGB ? 1.0 : 1.0 - clamp(sqr(h.w), 0.0, 1.0);
          vec3 c = uRGB ? abs(h.xyz) : mix(vec3(0.2, 0.1, 1.0), vec3(1.0, 0.2, 0.1), step(0.0, h.a)) * sqr(h.a);

          if (uDBLog) {
            c.r = loudness(c.r);
            c.g = loudness(c.g);
            c.b = loudness(c.b);
            c = clamp(c, 0.0, 1.0);
          } else {
            if (uDBMax > 0.0)
              c *= uDBMax / 20.0;
          }

          return mix(vec3(1.0), c, sat);
        }

        vec3 h_rgb_sampled(vec2 vTex, int n) {
          const vec2 dxdy = (dx + dy) * sqrt(2.0);
          vec3 sum = vec3(0.0);
          for (int i = 0; i < n; i++) {
            vec2 vTex2 = vTex + fibb_spiral(i, n) * dxdy;
            sum += h_rgb(vTex2);
          }
          return sum / float(n);
        }

        vec4 rgba() {
          float r = length(v);
          if (r > 0.99 && CIRCLE && !uFlat)
            return vec4(0.0);
          vec3 rgb = h_rgb_sampled(vTex, uNumSamples);
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
