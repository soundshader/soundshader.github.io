// Cooley-Tukey FFT algorithm.
//
// This JS implementation is fast enough to be usable,
// but could be be made a lot faster with WASM or GLSL.
export class FFT {
  static instances = new Map;
  static wasm = { size: 0, src: 0, res: 0, src_view: null, res_view: null };

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
    if (_fft_init) {
      let n = src.length / 2;

      if (!FFT.wasm.size) {
        FFT.wasm.size = n;
        _fft_init(n);
        FFT.wasm.src = _malloc(2 * n * 4);
        FFT.wasm.res = _malloc(2 * n * 4);
        let src_base = FFT.wasm.src / 4;
        let res_base = FFT.wasm.res / 4;
        FFT.wasm.src_view = HEAPF32.subarray(src_base, src_base + n * 2);
        FFT.wasm.res_view = HEAPF32.subarray(res_base, res_base + n * 2);
      }

      FFT.wasm.src_view.set(src); // js -> wasm
      _fft_inverse(FFT.wasm.src, FFT.wasm.res);
      res.set(FFT.wasm.res_view); // wasm -> js
      return res;
    }

    FFT.conjugate(src);
    FFT.forward(src, res);
    FFT.conjugate(src);
    FFT.conjugate(res);
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

  constructor(size) {
    if (!Number.isFinite(size) || size < 2 || (size & (size - 1)))
      throw new Error('FFT: ' + size + ' != 2**k');

    this.size = size;
    this.revidx = new Int32Array(size);
    this.uroots = new Float32Array(2 * size);

    // uroots[k] = exp(2*pi*k/n)
    for (let k = 0; k < size; k++) {
      let a = 2 * Math.PI * k / size;
      this.uroots[2 * k] = Math.cos(a);
      this.uroots[2 * k + 1] = Math.sin(a);
    }

    for (let k = 0; k < size; k++) {
      let r = 0;
      for (let i = 0; 2 ** i < size; i++)
        r = (r << 1) | (k >> i) & 1;
      this.revidx[k] = r;
    }
  }

  // Computes the unitary complex-valued DFT.
  transform(src, res) {
    let n = this.size;

    // both src and res contain N x (re, im) pairs
    if (src.length != 2 * n || res.length != 2 * n)
      throw new Error('DFT: wrong input/output size');

    for (let i = 0; i < n; i++) {
      let r = this.revidx[i];
      res[r * 2 + 0] = src[i * 2 + 0];
      res[r * 2 + 1] = src[i * 2 + 1];
    }

    for (let s = 2; s <= n; s += s) {
      for (let k = 0; k < s / 2; k++) {
        let kth = (n / s * k) % n;
        let cos = this.uroots[kth * 2];
        let sin = -this.uroots[kth * 2 + 1];

        for (let j = 0; j < n / s; j++) {
          let v = j * s + k;
          let u = v + s / 2;

          let v_re = res[v * 2];
          let v_im = res[v * 2 + 1];

          let u_re = res[u * 2];
          let u_im = res[u * 2 + 1];

          let t_re = u_re * cos - u_im * sin;
          let t_im = u_re * sin + u_im * cos;

          res[u * 2 + 0] = v_re - t_re;
          res[u * 2 + 1] = v_im - t_im;

          res[v * 2 + 0] = v_re + t_re;
          res[v * 2 + 1] = v_im + t_im;
        }
      }
    }

    // this makes the DFT unitary
    let n_rsqrt = 1 / Math.sqrt(n);
    for (let i = 0; i < 2 * n; i++)
      res[i] *= n_rsqrt;
  }
}
