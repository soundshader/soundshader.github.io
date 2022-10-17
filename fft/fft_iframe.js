import { FFT } from '../webfft.js';

function assert(x, message) {
  if (!x) throw new Error(message || 'assertion failed');
}

function exec(fn, arg) {
  let { re, im } = arg;

  assert(fn == 'fft',
    'only `fft` function is supported now');
  assert(re && re.length > 0 && !(re.length & re.length - 1),
    'arg.re must be a Float32Array with 2^N elements')
  assert(!im || im.length == re.length,
    'arg.im and arg.re must have the same length');

  let n = re.length;
  let fft = FFT.get(n);
  let src = new Float32Array(n * 2);
  let res = new Float32Array(n * 2);

  for (let i = 0; i < n; i++) {
    src[2 * i] = re[i];
    if (im) src[2 * i + 1] = im[i];
  }

  fft.transform(src, res);

  let res_re = new Float32Array(n);
  let res_im = new Float32Array(n);
  let res_abs = new Float32Array(n);
  let res_arg = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    let x = res[2 * i];
    let y = res[2 * i + 1];

    res_re[i] = x;
    res_im[i] = y;

    let r = Math.sqrt(x * x + y * y);
    let a = r > 0 ? Math.sign(y) * Math.acos(x / r) : 0;

    res_abs[i] = r;
    res_arg[i] = a;
  }

  return { re: res_re, im: res_im, abs: res_abs, arg: res_arg };
}

window.onmessage = (event) => {
  let ts = Date.now();
  let { fn, arg, tx } = event.data;
  let res = null, err = null;
  try {
    res = exec(fn, arg);
  } catch (e) {
    err = e.message;
  }
  let dt = Date.now() - ts;
  event.source.postMessage({ tx, dt, res, err }, '*');
};
