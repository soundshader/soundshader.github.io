// Cooley-Tukey FFT algorithm.
//
// This JS implementation is fast enough to be usable,

import { GpuTransformProgram } from "../webgl/transform.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

// but could be be made a lot faster with WASM or GLSL.
export class FFT {
  static instances = new Map;

  static get(size) {
    let fft = FFT.instances.get(size);
    if (!fft) {
      fft = new FFT(size);
      FFT.instances.set(size, fft);
    }
    return fft;
  }

  static forward(src, res = src.slice(0)) {
    let n = src.length / 2;
    let fft = FFT.get(n);
    fft.transform(src, res);
    return res;
  }

  static inverse(src, res = src.slice(0)) {
    let n = src.length / 2;
    let fft = FFT.get(n);
    fft.inverse(src, res);
    return res;
  }

  static conjugate(src) {
    let n = src.length / 2;
    for (let i = 0; i < n; i++)
      src[2 * i + 1] *= -1;
  }

  static expand(src, res = new Float32Array(src.length * 2)) {
    for (let i = 0; i < src.length; i++) {
      res[2 * i] = src[i];
      res[2 * i + 1] = 0;
    }
    return res;
  }

  static re(src, res = new Float32Array(src.length / 2)) {
    for (let i = 0; i < res.length; i++)
      res[i] = src[2 * i];
    return res;
  }

  static im(src, res = new Float32Array(src.length / 2)) {
    for (let i = 0; i < res.length; i++)
      res[i] = src[2 * i + 1];
    return res;
  }

  static abs(src, res) {
    let n = src.length / 2;
    res = res || src.slice(0, n);

    for (let i = 0; i < n; i++) {
      let re = src[2 * i];
      let im = src[2 * i + 1];
      res[i] = Math.sqrt(re * re + im * im);
    }

    return res;
  }

  static sqr_abs(src, res) {
    res = FFT.abs(src);
    for (let i = 0; i < res.length; i++)
      res[i] *= res[i];
    return res;
  }

  static sqr_abs_reim(src, res = src.slice(0)) {
    let n = src.length / 2;

    for (let i = 0; i < n; i++) {
      let re = src[2 * i];
      let im = src[2 * i + 1];
      res[2 * i] = re * re + im * im;
      res[2 * i + 1] = 0;
    }

    return res;
  }

  // https://en.wikipedia.org/wiki/Autocorrelation
  static auto_cf(src, res) {
    res = FFT.forward(src, res);
    let sqr = FFT.sqr_abs(res);
    return FFT.inverse(FFT.expand(sqr), res);
  }

  static dot(src1, src2, res = src1.slice(0)) {
    let n = res.length / 2;

    for (let i = 0; i < n; i++) {
      let re1 = src1[2 * i + 0];
      let im1 = src1[2 * i + 1];
      let re2 = src2[2 * i + 0];
      let im2 = src2[2 * i + 1];
      res[2 * i + 0] = re1 * re2 - im1 * im2;
      res[2 * i + 1] = re1 * im2 + re2 * im1;
    }

    return res;
  }

  static exp(size, freq, shift = 0, res = new Float32Array(2 * size)) {
    for (let k = 0; k < size; k++) {
      res[2 * k + 0] = Math.cos(freq * (k - shift));
      res[2 * k + 1] = Math.sin(freq * (k - shift));
    }
    return res;
  }

  static gaussian(size, sigma, shift = 0, res = new Float32Array(2 * size)) {
    for (let k = 0; k < size; k++) {
      let x = k < size / 2 ? k : k - size;
      res[2 * k + 0] = Math.exp(-0.5 * ((x - shift) / sigma) ** 2);
      res[2 * k + 1] = 0;
    }
    return res;
  }


  static normalize(res) {
    let n = res.length / 2;
    let n_rsqrt = 1 / Math.sqrt(n);
    for (let i = 0; i < 2 * n; i++)
      res[i] *= n_rsqrt;
  }

  constructor(size, { webgl } = {}) {
    if (!Number.isFinite(size) || size < 2 || (size & (size - 1)))
      throw new Error('FFT: ' + size + ' != 2**k');

    this.size = size;
    this.webgl = webgl;
    this.revidx = new Int32Array(size);
    this.uroots = !this.webgl && new Float32Array(2 * size);

    if (this.uroots) {
      // uroots[k] = exp(2*pi*k/n)
      for (let k = 0; k < size; k++) {
        let a = 2 * Math.PI * k / size;
        this.uroots[2 * k] = Math.cos(a);
        this.uroots[2 * k + 1] = Math.sin(a);
      }
    }

    for (let k = 0; k < size; k++) {
      let r = 0;
      for (let i = 0; 2 ** i < size; i++)
        r = (r << 1) | (k >> i) & 1;
      this.revidx[k] = r;
    }

    if (webgl) this.initGPU();
  }

  initGPU() {
    let webgl = this.webgl;
    let nlog2 = Math.log2(this.size);
    let width = 2 ** Math.ceil(nlog2 / 2);
    let height = 2 ** Math.floor(nlog2 / 2);

    // 1 million inputs -> 1024 x 1024 texture
    this.shader = new GpuFFT(webgl, { width, height });
    this.texData = new Float32Array(this.size * 2);
    this.texture = new GpuFrameBuffer(webgl, {
      width,
      height,
      channels: 2,
      source: this.texData,
    });

    this.texture1 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });
    this.texture2 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });
  }

  bit_reverse(src, res) {
    let n = this.size;

    // both src and res contain N x (re, im) pairs
    if (src.length != 2 * n || res.length != 2 * n)
      throw new Error('DFT: wrong input/output size');

    for (let i = 0; i < n; i++) {
      let r = this.revidx[i];
      res[r * 2 + 0] = src[i * 2 + 0];
      res[r * 2 + 1] = src[i * 2 + 1];
    }
  }

  inverse(src, res) {
    FFT.conjugate(src);
    this.transform(src, res);
    FFT.conjugate(src);
    FFT.conjugate(res);
  }

  // Computes the unitary complex-valued DFT.
  transform(src, res) {
    if (this.webgl) {
      this.transform_gpu(src, res);
      return;
    }

    let n = this.size;
    this.bit_reverse(src, res);

    // DSP Guide, Chapter 12: The Fast Fourier Transform
    // dspguide.com/ch12/2.htm
    for (let s = 2; s <= n; s *= 2) {
      for (let k = 0; k < s / 2; k++) {
        let kth = n / s * k; // 0..n/2

        // exp(2*pi*i/N)^k
        let cos = this.uroots[kth * 2];
        let sin = this.uroots[kth * 2 + 1];

        for (let j = 0; j < n / s; j++) {
          let u = j * s + k;
          let v = u + s / 2;

          // E[k] - even
          let v_re = res[u * 2];
          let v_im = res[u * 2 + 1];

          // O[k] - odd
          let u_re = res[v * 2];
          let u_im = res[v * 2 + 1];

          // O[k] * exp(-2*pi*i/N)^k
          let t_re = u_re * cos + u_im * sin;
          let t_im = u_im * cos - u_re * sin;

          // E[k] + O[k] * exp(...) = X[k]
          res[u * 2 + 0] = v_re + t_re;
          res[u * 2 + 1] = v_im + t_im;

          // E[k] - O[k] * exp(...) = X[k + s/2]
          res[v * 2 + 0] = v_re - t_re;
          res[v * 2 + 1] = v_im - t_im;
        }
      }
    }

    FFT.normalize(res); // make the DFT unitary
  }

  // Same as transform(), but on GPU.
  transform_gpu(src, res) {
    let n = this.size;
    this.bit_reverse(src, res);
    this.texData.set(res);

    let tex1 = this.texture1;
    let tex2 = this.texture2;

    for (let s = 2; s <= n; s *= 2) {
      [tex1, tex2] = [tex2, tex1];
      this.shader.exec({
        uScale: s,
        uInput: s == 2 ? this.texture : tex1,
      }, tex2);
    }

    tex2.download(res); // copy data from GPU's texture
    FFT.normalize(res); // make the DFT unitary
  }
}

class GpuFFT extends GpuTransformProgram {
  constructor(webgl, { width, height }) {
    super(webgl, {
      channels: 2, // [re, im]
      fshader: `
        in vec2 vTex;

        const int TW = ${width};
        const int TH = ${height};
        const int N = TW * TH;
        const float PI = ${Math.PI};

        uniform sampler2D uInput;
        uniform int uScale; // 2, 4, 8, .., n

        // exp(2*PI*i/N)^k
        vec2 kth_root(int k) {
          float w = 2.0 * PI * float(k) / float(N);
          return vec2(cos(w), sin(w));
        }

        vec2 element(int i) {
          int x = i % TW;
          int y = i / TW;
          return texelFetch(uInput, ivec2(x, y), 0).xy;
        }

        vec2 multiply(vec2 u, vec2 v) {
          float re = u.x * v.x - u.y * v.y;
          float im = u.x * v.y + u.y * v.x;
          return vec2(re, im);
        }

        void main() {
          vec2 vTexN = vTex * vec2(float(TW), float(TH)) - 0.5;
          int i = int(vTexN.x) + TW * int(vTexN.y); // 0..N-1
          int s = uScale;
          int j = i / s;
          int k = i % (s / 2);
  
          vec2 u = element(j * s + k);         // E[k] = even
          vec2 v = element(j * s + k + s / 2); // O[k] = odd
          vec2 t = multiply(v, kth_root(N / s * k));
  
          // E[k] + O[k] * exp(...) = X[k]
          // E[k] - O[k] * exp(...) = X[k + s/2]
          float sign = i % s < s / 2 ? +1.0 : -1.0;

          v_FragColor = vec4(u + sign * t, 0.0, 0.0);
        }
      `,
    });
  }
}

/* for (let i = 0; i < n; i++) {
  let j = i / s | 0;
  let k = i % (s / 2);

  // exp(2*pi*i/N)^k
  let kth = n / s * k; // 0..n/2
  let cos = this.uroots[kth * 2];
  let sin = this.uroots[kth * 2 + 1];

  let u = j * s + k;
  let v = u + s / 2;

  // E[k] - even
  let u_re = res[u * 2];
  let u_im = res[u * 2 + 1];

  // O[k] - odd
  let v_re = res[v * 2];
  let v_im = res[v * 2 + 1];

  // O[k] * exp(-2*pi*i/N)^k
  let t_re = v_re * cos + v_im * sin;
  let t_im = v_im * cos - v_re * sin;

  // E[k] + O[k] * exp(...) = X[k]
  // E[k] - O[k] * exp(...) = X[k + s/2]
  let sign = i % s < s / 2 ? +1 : -1;

  tmp[i * 2 + 0] = u_re + t_re * sign;
  tmp[i * 2 + 1] = u_im + t_im * sign;
} */
