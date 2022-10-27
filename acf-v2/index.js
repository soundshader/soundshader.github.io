import { FFT } from '/webfft.js'

const EPS = 1e-6;
const DISK = 1;
const ACF = 1;
const MAX_DURATION = 3;

let sample_rate = 16000;
let frame_size = 4096;
let num_frames_xs = 256;
let num_frames_xl = 1024;
let audio_ctx = null;
let sound_files = [];
let sound_id = 0; // sound_files[sound_id - 1]
let waveform = null;

let bandpass_filters = [
  { rgb: [16, 4, 1], freqs: f => 1 - hann_step(f, 0, 0.5) },
  { rgb: [0, 1, 0], freqs: f => hann_step(f, 0, 0.5) - hann_step(f, 0.25, 1) },
  { rgb: [1, 2, 6], freqs: f => hann_step(f, 0.25, 1) },
];

let hann = (x, a = 0, b = 1) => x > a && x < b ? Math.sin(Math.PI * (x - a) / (b - a)) ** 2 : 0
let hann_step = (x, a, b) => hann(0.5 * (x - a) / (b - a));
let fract = x => x - Math.floor(x);
let sleep = t => new Promise(resolve => setTimeout(resolve, t));

async function main() {
  $('#load').onclick = async () => {
    sound_files = await selectAudioFiles();
    sound_id = 0;
    log('Selected files:', sound_files.length);
    $('canvas').remove();
    await renderSoundFilesAsGrid();
    if (sound_files.length == 1)
      saveWaveform();
  };

  $('#init').onclick = async () => {
    $('#init').onclick = null;
    await downloadSamples();
    await renderSoundFilesAsGrid();
  };

  $('#play').onclick = () => waveform && playSound(waveform);

  loadWaveform();

  if (waveform) {
    let canvas = createCanvas();
    await renderWaveform(canvas, waveform);
  }
}

async function downloadSamples(min = 10, max = 38) {
  log('Downloading sample files');
  for (let i = min; i <= max; i++) {
    let resp = await fetch('vowels/' + i + '.ogg');
    let blob = await resp.blob();
    sound_files.push(blob);
  }
}

function createCanvas(id = 0, nf = num_frames_xs) {
  dcheck(nf > 0);
  let canvas = document.createElement('canvas');
  canvas.onclick = () => renderFullScreen(id);
  if (id) canvas.title = sound_files[id - 1].name;

  if (DISK) {
    canvas.width = nf * 2;
    canvas.height = nf * 2;
  } else {
    canvas.height = nf;
    canvas.width = frame_size / 2;
  }

  document.body.append(canvas);
  return canvas;
}

async function renderFullScreen(id) {
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
    await renderSoundFile(id + 1, canvas);
    await sleep(0);
  }

  log('Rendered all sounds');
}

async function renderSoundFile(id = sound_id, canvas) {
  if (id > 0) {
    let file = sound_files[id - 1];
    let buffer = await decodeAudioFile(file);
    log('Decoded sound', id, buffer.duration.toFixed(1), 'sec', '(' + file.name + ')');
    waveform = buffer.getChannelData(0).subarray(0, MAX_DURATION * sample_rate | 0);
  }

  await renderWaveform(canvas, waveform);
}

async function renderWaveform(canvas, waveform) {
  let trimmed = trimWaveform(waveform);
  await drawACF(canvas, trimmed, num_frames_xs, bandpass_filters);
}

function trimWaveform(audio) {
  // need some padding on both ends for smooth edges
  let tmp = new Float32Array(audio.length + frame_size * 1.5);
  tmp.set(audio, frame_size >> 1);
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
  log('Decoding audio at', sr, 'Hz: ', file.size / 1024 | 0, 'KB', file.name);
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

async function drawACF(canvas, audio, num_frames, colors = [{}]) {
  let h = canvas.height;
  let w = canvas.width;
  let fs = frame_size;
  let ctx = canvas.getContext('2d');
  let fft_data = new Float32Array(num_frames * fs);
  let acf_data = new Float32Array(num_frames * fs);

  log('fft frame:', fs, ';',
    audio.length / w | 0, 'samples/step');

  for (let t = 0; t < num_frames; t++) {
    let frame = new Float32Array(fs);
    readAudioFrame(audio, num_frames, t, frame);
    computeFFT(frame, frame);
    fft_data.subarray(t * fs, (t + 1) * fs).set(frame);
  }

  ctx.clearRect(0, 0, w, h);

  for (let clr of colors) {
    let abs_max = 0;

    for (let t = 0; t < num_frames; t++) {
      let fft_frame = fft_data.subarray(t * fs, (t + 1) * fs);
      let acf_frame = acf_data.subarray(t * fs, (t + 1) * fs);

      for (let f = 0; f < fs; f++)
        acf_frame[f] = fft_frame[f] * clr.freqs(2 * Math.min(f, fs - f) / fs);

      if (ACF) computeACF(acf_frame, acf_frame);
      abs_max = Math.max(abs_max, max(acf_frame));
    }

    await drawFrames(ctx, acf_data, num_frames, abs_max, clr.rgb);
  }
}

async function drawFrames(ctx, fft_data, num_frames, abs_max, rgb = [1, 1, 1]) {
  let w = ctx.canvas.width;
  let h = ctx.canvas.height;
  let img = ctx.getImageData(0, 0, w, h);
  let fs = frame_size;
  let time = performance.now();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let t = y / h * num_frames | 0;
      let f = (x / w + 0.5) * fs | 0;

      if (DISK) {
        let [r, a] = xy2ra(x / w * 2 - 1, y / h * 2 - 1);
        t = (1 - r) * num_frames | 0;
        f = ((a / Math.PI + 1) / 2 + 0.75) * fs | 0;
        f = f * 2; // vertical symmetry
      }

      t = num_frames - 1 - t;
      f = f % fs;

      let frame = fft_data.subarray(t * fs, (t + 1) * fs);
      let p = Math.abs(frame[f]) / abs_max;
      let i = (x + y * w) * 4;
      img.data[i + 0] += 255 * p * rgb[0];
      img.data[i + 1] += 255 * p * rgb[1];
      img.data[i + 2] += 255 * p * rgb[2];
      img.data[i + 3] = 255;
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
  dcheck(is_real(temp));
  FFT.abs(temp2, output);
  dcheck(is_even(output));
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

function $(s) {
  return document.querySelector(s);
}

window.onload = () => main();
