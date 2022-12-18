let q_args = new URLSearchParams(location.search);
let args_info = [];

export const args = () => console.log(args_info.join('\n'));

// Dynamic args.

export const H_TACF = h_strarg('tacf');

// Static args.

export const DEBUG = numarg('dbg', 0);
export const FFT_SIZE = numarg('fft', 2048); // 2048 is the max on Android
export const SHADER = strarg('s', 'acf');
export const USE_DCT = numarg('dct', 0);
export const A4_FREQ = numarg('a4', 432);
export const SAMPLE_RATE = strarg('sr', '48000');
export const IMAGE_SIZE = numarg('img', 2048);
export const USE_MOUSE = numarg('mouse', 1);
export const HANN_WINDOW = numarg('hann', 1);
export const SHOW_MIC = numarg('mic', 0);
export const NUM_STRIPES = numarg('ns', 1);
export const ZOOM = numarg('zoom', 1);

export const DB_RANGE = strarg('db', 50);
export const ACF_R0 = numarg('acf.r0', 0.0);
export const ACF_POLAR = numarg('acf.polar', 0);
export const ACF_MAX_SIZE = numarg('acf.max', 4096);
export const ACF_RGB = numarg('rgb', 1);
export const ACF_DYN_LOUDNESS = numarg('acf.dyn', 1);
// FFT |amp|^2 decay after one full FFT frame (e.g. 2048 samples).
// The rationale is that FFT buffer corresponds to the ear's audio
// buffer of ~100ms.
export const ACF_LOUDNESS_DECAY = numarg('decay', 0.1);
export const ACF_MUTE_RANGE = numarg('mute', 0);

export const REC_FRAMERATE = numarg('rec.fps', 0);
export const USE_ALPHA_CHANNEL = numarg('alpha', 0);
export const FBO_MAX_SIZE = numarg('fbo.max', 27);
export const SHOW_LOGS = numarg('log', 0);
export const FLOAT_PRECISION = strarg('fp', 'highp');
export const INT_PRECISION = strarg('ip', 'highp');

function strarg(name, defval = '', { regex, parse } = {}) {
  let value = q_args.get(name);
  if (value === null)
    value = defval;
  let info = '?' + name + '=' + value;
  args_info.push(info);
  if (regex && !regex.test(value))
    throw new Error(info + ' doesnt match ' + regex);
  if (parse)
    value = parse(value);
  return value;
}

function numarg(name, defval = 0) {
  return +strarg(name, defval + '', /^\d+(\.\d+)?$/);
}

function h_strarg(name) {
  return {
    get() {
      let h_args = new URLSearchParams(location.hash.slice(1));
      return h_args.get(name);
    }
  };
}