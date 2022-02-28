let args = new URLSearchParams(location.search);

console.groupCollapsed('Config:');

export const DEBUG = numarg('dbg', 0);
export const FFT_SIZE = numarg('n', 2048); // 2048 is the max on Android
export const SHADER = strarg('s', 'acf');
export const A4_FREQ = numarg('a4', 432);
export const SAMPLE_RATE = strarg('sr', 'A10', /^A?\d+$/,
  s => +s || 2 ** (s.slice(1) - 4) * A4_FREQ);
export const IMAGE_SIZE = numarg('img', 2048);
export const USE_MOUSE = numarg('mouse', 1);
export const HANN_WINDOW = numarg('hann', 1);
export const VOL_FACTOR = numarg('vol', 1);
export const SHOW_MIC = numarg('mic', 0);
export const NUM_STRIPES = numarg('ns', 1);

export const ACF_LOUDNESS_RANGE = strarg('acf.lr', 2.5);
export const ACF_R0 = numarg('acf.r0', 0.0);
export const ACF_POLAR = numarg('acf.polar', 0);
export const ACF_MAX_SIZE = numarg('acf.max', 4096);
export const ACF_RGB = numarg('acf.rgb', 1);
export const ACF_DYN_LOUDNESS = numarg('acf.dyn', 1);
// FFT |amp|^2 decay after one full FFT frame (e.g. 2048 samples).
// The rationale is that FFT buffer corresponds to the ear's audio
// buffer of ~100ms.
export const ACF_LOUDNESS_DECAY = numarg('decay', 0.1);
export const ACF_MUTE_RANGE = numarg('acf.mr', 1);

export const REC_FRAMERATE = numarg('rec.fps', 0);
export const USE_ALPHA_CHANNEL = numarg('alpha', 0);
export const FBO_MAX_SIZE = numarg('fbo.max', 27);
export const SHOW_LOGS = numarg('log', 0);
export const FLOAT_PRECISION = strarg('fp', 'highp');
export const INT_PRECISION = strarg('ip', 'highp');

console.groupEnd();

function strarg(name, defval = '', regex = null, parser_fn = null) {
  let value = args.get(name);
  if (value === null)
    value = defval;
  let info = '?' + name + '=' + value;
  console.log(info);
  if (regex && !regex.test(value))
    throw new Error(info + ' doesnt match ' + regex);
  if (parser_fn)
    value = parser_fn(value);
  return value;
}

function numarg(name, defval = 0) {
  return +strarg(name, defval + '', /^\d+(\.\d+)?$/);
}
