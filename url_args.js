let q_args = new URLSearchParams(location.search);
let args_info = [];
let gui = window.dat && new dat.GUI({ autoPlace: true });
let log2 = Math.log2;

export const vconf = { onchange: null };

// Dynamic args.

define_arg('IMAGE_SIZE', 'img', 2048, { min: 1, max: 4096, fix: x => 2 ** (log2(x) | 0) });
define_arg('FFT_SIZE', 'fft', 2048, { min: 1, max: 4096, fix: x => 2 ** (log2(x) | 0) });
define_arg('SAMPLE_RATE', 'sr', 12000, { min: 3600, max: 48000 });
define_arg('DB_MAX', 'db_max', 5, { min: 0, max: 100 });
define_arg('DB_LOG', 'db_log', false);
define_arg('HZ_HUE', 'hue', false);
define_arg('FREQ_MIN', 'hz_min', 0, { min: 0, max: 3000 });
define_arg('ACF_DYN_LOUDNESS', 'dyn', false);
define_arg('ACF_RGB', 'rgb', true);
define_arg('HANN_WINDOW', 'hann', true);
define_arg('USE_DCT', 'dct', false);
define_arg('N_SYMM', 'sym', 1, { min: 1, max: 12 });

define_arg('H_TACF', 'tacf', false);
define_arg('H_GRAD', 'grad', false);
define_arg('GRAD_ZOOM', 'gzoom', 3.5, { min: 0, max: 5, step: 0.01 });
define_arg('DEBUG', 'dbg', false);
define_arg('SHOW_LOGS', 'log', false);
define_arg('REC_FRAMERATE', 'fps', 0, { max: 60 });
define_arg('NUM_STRIPES', 'ns', 1, { max: 8 });
define_arg('NUM_SAMPLES', 'rs', 16, { min: 1, max: 64 });

if (gui) {
  gui.useLocalStorage = true;
}

// Static args.

export const SHADER = strarg('s', 'acf');
export const USE_MOUSE = numarg('mouse', 1);
export const SHOW_MIC = numarg('mic', 0);
export const ZOOM = numarg('zoom', 1);

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

function define_arg(tag, url_param, value = 0, { min = value, max = value, step = 1, fix } = {}) {
  let ctr, title = tag + ' (' + url_param + ')';

  switch (typeof value) {
    case 'boolean':
      vconf[tag] = numarg(url_param, +value);
      ctr = gui.add(vconf, tag, 0, 1, 1).name(title);
      ctr.onChange(() => onArgChange(ctr, tag, fix));
      return vconf[tag];
    case 'number':
      vconf[tag] = numarg(url_param, value);
      ctr = gui.add(vconf, tag, min, max, step).name(title)
      ctr.onChange(() => onArgChange(ctr, tag, fix));
      return vconf[tag];
    default:
      return vconf[tag] = strarg(url_param, value);
  }
}

function onArgChange(ctr, tag, fix) {
  let value = vconf[tag];
  if (fix) {
    value = fix(value);
    if (value != vconf[tag]) {
      ctr.setValue(value);
      return;
    }
  }
  vconf.onchange?.(tag);
}
