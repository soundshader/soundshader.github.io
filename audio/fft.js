// Cooley-Tukey FFT algorithm.
//
// This JS implementation is fast enough to be usable,
// but could be be made a lot faster with WASM or GLSL.
export class FFT {
  constructor(size) {
    if (!Number.isFinite(size) || size < 2 || (size & (size - 1)))
      throw new Error('DFT: ' + size + ' != 2**k');

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
