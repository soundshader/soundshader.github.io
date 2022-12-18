import { FFT } from '/webfft.js'

const EPS = 1e-6;
const DISK = 1;
const ACF = 1;

let ts_min = 0.0;
let ts_max = 15.0;
let frame_size = 4096;
let sample_rate = 16000;
let num_frames_xs = 256;
let num_frames_xl = 1024;
let audio_ctx = null;
let sound_files = [];
let waveform = null;
let freq_colors = new Float32Array(4 * frame_size);

// These are files in the vowels/*.ogg list.
let sample_files = [
  'cbr', 'cbu', 'ccr', 'ccu', 'cfr', 'cfu', 'cmbr', 'cmbu',
  'cmcr', 'cmcu', 'cmfr', 'cmfu', 'mcv', 'ncnbr', 'ncnfr',
  'ncnfu', 'nocu', 'nofu', 'obu', 'ocu', 'ofr', 'omcr',
  'omcu', 'omfr', 'omfu', 'probr', 'profu', 'prombr', 'prombu'];

let hann = (x, a = 0, b = 1) => x > a && x < b ? Math.sin(Math.PI * (x - a) / (b - a)) ** 2 : 0
let hann_step = (x, a, b) => x < a ? 0 : x > b ? 1 : hann(0.5 * (x - a) / (b - a));
let hard_step = (x, a, b) => x >= a && x < b ? 1 : 0;
let fract = x => x - Math.floor(x);
let sleep = t => new Promise(resolve => setTimeout(resolve, t));

async function main() {
  $('#load').onclick = async () => {
    $('#sounds').innerHTML = '';
    sound_files = await selectAudioFiles();
    log('Selected files:', sound_files.length);
    await renderSoundFilesAsGrid();
    if (sound_files.length == 1)
      saveWaveform();
  };

  $('#init').onclick = async () => {
    $('#init').onclick = null;
    $('#sounds').innerHTML = '';
    sound_files = [];
    await downloadSamples();
    await renderSoundFilesAsGrid();
  };

  $('#play').onclick = () => waveform && playSound(waveform);

  initFreqColors();
  loadWaveform();

  if (waveform) {
    let canvas = createCanvas();
    await renderWaveform(canvas, waveform, num_frames_xs);
  }
}

function initFreqColors() {
  for (let i = 0; i < frame_size; i++) {
    let f = Math.min(i, frame_size - i) / frame_size * 2; // 0..1
    let r = hann(f, 0.0, 0.1) + hann(f, 0.3, 0.4);
    let g = hann(f, 0.0, 0.3) + hann(f, 0.3, 0.6);
    let b = hann(f, 0.0, 0.7) + hann(f, 0.3, 1.0);

    freq_colors[4 * i + 0] = r;
    freq_colors[4 * i + 1] = g;
    freq_colors[4 * i + 2] = b;
    freq_colors[4 * i + 3] = 1;
  }
}

async function downloadSamples(min = 10, max = 38) {
  log('Downloading sample files');
  for (let f of sample_files) {
    let name = 'vowels/' + f + '.ogg';
    let resp = await fetch(name);
    let blob = await resp.blob();
    blob.name = f;
    sound_files.push(blob);
  }
}

function createCanvas(id = 0, nf = num_frames_xs) {
  dcheck(nf > 0);
  let canvas = document.createElement('canvas');
  canvas.onclick = () => renderFullScreen(id);

  if (DISK) {
    canvas.width = nf * 2;
    canvas.height = nf * 2;
  } else {
    canvas.height = nf;
    canvas.width = frame_size / 2;
  }

  $('#sounds').append(canvas);
  return canvas;
}

async function renderFullScreen(id) {
  dcheck(!$('canvas.top'));
  let canvas = createCanvas(0, num_frames_xl);
  canvas.className = 'top';
  canvas.onclick = () => canvas.remove();
  await renderSoundFile(id, canvas, num_frames_xl);
  saveWaveform();
}

async function renderSoundFilesAsGrid() {
  let num = sound_files.length;
  log('Rendering sounds:', num);

  for (let id = 0; id < num; id++) {
    let canvas = createCanvas(id + 1, num_frames_xs);
    await renderSoundFile(id + 1, canvas, num_frames_xs);
    await sleep(0);
  }

  log('Rendered all sounds');
}

async function renderSoundFile(id, canvas, num_frames) {
  let file = id > 0 && sound_files[id - 1];

  if (id > 0) {
    try {
      let buffer = await decodeAudioFile(file);
      log('Decoded sound:', buffer.duration.toFixed(1), 'sec', '#' + id, '(' + file.name + ')');
      waveform = buffer.getChannelData(0);
    } catch (err) {
      log(err.message);
      waveform = new Float32Array(0);
    }
  }

  waveform && await renderWaveform(canvas, waveform, num_frames);
  file && renderSoundTag(canvas, file.name.replace(/\.\w+$/, ''));
}

function renderSoundTag(canvas, text) {
  let h = canvas.height;
  let fs = h / 24 | 0;
  let ctx = canvas.getContext('2d');
  ctx.font = fs + 'px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText(text, fs / 2, h - fs / 2);
}

async function renderWaveform(canvas, waveform, num_frames) {
  let trimmed = prepareWaveform(waveform);
  await drawACF(canvas, trimmed, num_frames);
}

function prepareWaveform(waveform) {
  let n = waveform.length, fs = frame_size;

  // trim zeros at both ends
  let i = 0, j = n - 1;
  while (i < j && Math.abs(waveform[i]) < EPS) i++;
  while (i < j && Math.abs(waveform[j]) < EPS) j--;
  waveform = waveform.subarray(i, j + 1).subarray(
    ts_min * sample_rate | 0, ts_max * sample_rate | 0);
  n = waveform.length;

  // need some padding on both ends for smooth edges
  let pad = fs / 2 | 0;
  let tmp = new Float32Array(n + 2 * pad);
  tmp.set(waveform, pad);

  return tmp;
}

function loadWaveform() {
  if (localStorage.audio) {
    waveform = new Float32Array(
      localStorage.audio.split(',')
        .map(s => parseInt(s))
        .map(i => i / 2 ** 15));
    log('Loaded audio from local storage:', waveform.length);
  }
}

function saveWaveform() {
  if (waveform.length < 1e5) {
    localStorage.audio = [...waveform]
      .map(f => f * 2 ** 15 | 0).join(',');
    log('Saved audio to local storage:', waveform.length);
  }
}

async function selectAudioFiles() {
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.multiple = true;
  input.click();
  return new Promise(resolve =>
    input.onchange = () => resolve(input.files));
}

async function decodeAudioFile(file, sr = sample_rate) {
  log('Decoding audio at', sr, 'Hz: ', file.size / 1024 | 0, 'KB');
  let encoded = await file.arrayBuffer();
  audio_ctx = audio_ctx || new AudioContext({ sampleRate: sr });
  let buffer = await audio_ctx.decodeAudioData(encoded);
  return buffer;
}

function playSound(sound, sr = sample_rate) {
  audio_ctx = audio_ctx || new AudioContext({ sampleRate: sr });
  let buffer = audio_ctx.createBuffer(1, sound.length, sample_rate);
  buffer.getChannelData(0).set(sound);
  let source = audio_ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(audio_ctx.destination);
  source.start();
}

async function drawACF(canvas, audio, num_frames) {
  let fs = frame_size;
  let ctx = canvas.getContext('2d');
  let fft_data = new Float32Array(num_frames * fs);
  let acf_data = new Float32Array(4 * num_frames * fs);

  for (let t = 0; t < num_frames; t++) {
    let frame = new Float32Array(fs);
    readAudioFrame(audio, num_frames, t, frame);
    computeFFT(frame, frame);
    fft_data.subarray(t * fs, (t + 1) * fs).set(frame);
  }

  for (let t = 0; t < num_frames; t++) {
    let fft_frame = fft_data.subarray(t * fs, (t + 1) * fs);

    for (let f = 0; f < fs; f++)
      for (let i = 0; i < 3; i++)
        acf_data[t * fs + f + i * num_frames * fs] = fft_frame[f] * freq_colors[4 * f + i];

    if (ACF) {
      for (let i = 0; i < 3; i++) {
        let acf_frame = acf_data
          .subarray(i * num_frames * fs, (i + 1) * num_frames * fs)
          .subarray(t * fs, (t + 1) * fs);
        computeACF(acf_frame, acf_frame);
      }
    }
  }

  await drawFrames(ctx, acf_data, num_frames);
}

async function drawFrames(ctx, rgba_data, num_frames) {
  let w = ctx.canvas.width;
  let h = ctx.canvas.height;
  let img = ctx.getImageData(0, 0, w, h);
  let fs = frame_size;
  let time = performance.now();
  let abs_max = 0.08 * max(rgba_data);

  // for (let i = 0; i < num_frames * fs; i++)
  //   abs_max = Math.max(abs_max, Math.abs(rgba_data[i * 4 + 3]));

  // ctx.clearRect(0, 0, w, h);

  let set_rgb = (x, y, r, g, b) => {
    let i = (x + y * w) * 4;
    img.data[i + 0] = 255 * Math.abs(r) / abs_max;
    img.data[i + 1] = 255 * Math.abs(g) / abs_max;
    img.data[i + 2] = 255 * Math.abs(b) / abs_max;
    img.data[i + 3] = 255;
  };

  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < w / 2; x++) {
      let t, f;

      if (!DISK) {
        t = Math.abs(y / h * 2 - 1) * num_frames | 0;
        f = (x / w + 0.5) * fs | 0;
        t = clamp(t, 0, num_frames - 1);
      } else {
        let [r, a] = xy2ra(x / w * 2 - 1, y / h * 2 - 1);
        if (r >= 1) continue;
        t = Math.min(num_frames - 1, r * num_frames | 0);
        f = ((a / Math.PI + 1) / 2 + 0.75) * fs;
        f = f * 2; // vertical symmetry
      }

      let f_width = DISK ? num_frames / (t + 1) : 0;

      let r = getRgbaSmoothAvg(rgba_data, 0, t, f, f_width, num_frames);
      let g = getRgbaSmoothAvg(rgba_data, 1, t, f, f_width, num_frames);
      let b = getRgbaSmoothAvg(rgba_data, 2, t, f, f_width, num_frames);

      // [r, g, b] = mv3x3_mul([16, 4, 1, 4, 16, 4, 4, 1, 16], [r, g, b]);

      set_rgb(x, y, r, g, b);
      set_rgb(w - x - 1, y, r, g, b);
      set_rgb(x, h - y - 1, r, g, b);
      set_rgb(w - x - 1, h - y - 1, r, g, b);
    }

    if (performance.now() > time + 250) {
      ctx.putImageData(img, 0, 0);
      await sleep(0);
      time = performance.now();
    }
  }

  ctx.putImageData(img, 0, 0);
  await sleep(0);
}

// f doesn't have to be an integer
function getRgbaSmoothAvg(rgba_data, rgba_idx, t, f, f_width, num_frames) {
  dcheck(rgba_idx >= 0 && rgba_idx <= 3);
  dcheck(t >= 0 && t < num_frames);
  dcheck(f_width >= 0 && f_width <= frame_size);
  dcheck(rgba_data.length == num_frames * frame_size * 4);

  let fs = frame_size;
  let nf = num_frames;
  let base = rgba_idx * nf * fs + t * fs;
  let frame = rgba_data.subarray(base, base + frame_size);

  return !f_width ?
    frame[((f | 0) % fs + fs) % fs] :
    getSmoothAvg(frame, f, f_width);
}

// f doesn't have to be an integer
function getSmoothAvg(frame, f, f_width) {
  let fs = frame.length;
  let f_min = Math.floor(f - f_width);
  let f_max = Math.ceil(f + f_width);
  let sum = 0, w_sum = 0;

  dcheck(f_width >= 1 && f_width <= fs);

  for (let i = f_min; i <= f_max; i++) {
    let w = hann(i, f - f_width, f + f_width);
    sum += w * frame[(i % fs + fs) % fs];
    w_sum += w;
  }

  return sum / w_sum;
}

function readAudioFrame(audio, num_frames, frame_id, frame) {
  dcheck(frame_id >= 0 && frame_id < num_frames);
  let n = audio.length;
  let fs = frame.length;
  let step = (n - fs) / num_frames;
  let t = frame_id * step | 0;

  dcheck(t + fs <= n);
  frame.set(audio.subarray(t, t + fs));

  for (let i = 0; i < fs; i++)
    frame[i] *= hann(i / fs);
}

// output[i] = abs(FFT[i])^2
function computeFFT(input, output) {
  dcheck(input.length == output.length);
  let temp = FFT.expand(input);
  let temp2 = FFT.forward(temp);
  FFT.sqr_abs(temp2, output);
  dcheck(is_even(output));
}

// intput[i] = abs(FFT[i])^2
// output[i] = abs(ACF[i])
function computeACF(input, output) {
  dcheck(input.length == output.length);
  let temp = FFT.expand(input);
  let temp2 = FFT.forward(temp);
  // dcheck(is_real(temp2));
  FFT.abs(temp2, output);
  // dcheck(is_even(output));
}

function dcheck(x) {
  if (x) return;
  debugger;
  throw new Error('dcheck failed');
}

function log(...args) {
  console.log(args.join(' '));
}

function dot(a, b) {
  let n = a.length, s = 0;
  for (let i = 0; i < n; i++)
    s += a[i] * b[i];
  return s;
}

function clamp(x, min = 0, max = 1) {
  return Math.max(Math.min(x, max), min);
}

function interpolate(t, ps) {
  let n = ps.length;
  dcheck(n > 1);
  if (t <= ps[0][0])
    return ps[0][1];
  for (let i = 1; i < n; i++) {
    let a = ps[i - 1], b = ps[i];
    if (t <= b[0])
      return mix3(a[1], b[1], (t - a[0]) / (b[0] - a[0]));
  }
  return ps[n - 1][1];
}

function mix3(a, b, x) {
  return [mix(a[0], b[0], x), mix(a[1], b[1], x), mix(a[2], b[2], x)];
}

function mix(a, b, x) {
  return a * (1 - x) + b * x;
}

function is_real(a) {
  let n = a.length;
  for (let i = 1; i < n; i += 2)
    if (Math.abs(a[i]) > EPS)
      return false;
  return true;
}

function is_even(a) {
  let n = a.length;
  for (let i = 1; i < n / 2; i++)
    if (Math.abs(a[i] - a[n - i]) > EPS)
      return false;
  return true;
}

function max(a, mul = 1) {
  let x = a[0], n = a.length;
  for (let i = 1; i < n; i++)
    x = Math.max(x, mul * a[i]);
  return x;
}

function min(a) {
  return -max(a, -1);
}

function xy2ra(x, y) {
  let r = Math.sqrt(x * x + y * y);
  let a = Math.atan2(y, x); // -PI..PI
  return [r, a]
}

function mv3x3_mul(m, v) {
  dcheck(v.length == 3 && m.length == 9);
  return [
    v[0] * m[0] + v[1] * m[3] + v[2] * m[6],
    v[0] * m[1] + v[1] * m[4] + v[2] * m[7],
    v[0] * m[2] + v[1] * m[5] + v[2] * m[8],
  ];
}

function $(s) {
  return document.querySelector(s);
}

window.onload = () => main();
