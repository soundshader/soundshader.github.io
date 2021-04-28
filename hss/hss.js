import * as log from '../log.js';
import { FFT } from '../audio/fft.js';

const FFT_SIZE = 1024;
const FFT_FMAX = 512;
const AMP2_LOG = 0.25; // 10**(-1/AMP2_LOG) = the min non zero amp2
const FBIN_MUL = 5;
const HW_LEN = 15;
const SPEC_BINS = 512;

const $ = s => document.querySelector(s);
const sleep = dt => new Promise(resolve => setTimeout(resolve, dt));

const canvasFFT = $('#fft');
const canvasSpectrum = $('#spectrum');
const canvasImage = $('#image');
const audio = $('audio');
const fft = FFT.get(FFT_SIZE);
const numFrames = canvasFFT.width;
const fftSqrAmp = new Float32Array(FFT_SIZE / 2 * numFrames);
const fbins = new Int32Array(FFT_FMAX * SPEC_BINS);

canvasFFT.height = FFT_FMAX;
canvasSpectrum.width = FFT_FMAX;
canvasSpectrum.height = SPEC_BINS;

let audio32 = null;
let aviewport = { min: 0, len: 0 };
let sdrawing = false;

function clamp(x, min = 0, max = 1) {
  return x < min ? min : x > max ? max : x;
}

async function selectAudioFile() {
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/mpeg; audio/wav; audio/webm';
  input.click();
  return new Promise((resolve, reject) => {
    input.onchange = () => {
      let files = input.files || [];
      resolve(files[0] || null);
    };
  });
}

// Same as src.slice(min, max), but padded with zeros.
function getPaddedSlice(src, min, max,
  res = new Float32Array(max - min)) {
  let n = src.length;
  res.fill(0);
  res.set(
    src.subarray(
      Math.max(0, min),
      Math.min(n, max)),
    Math.max(0, -min));
  return res;
}

function getAmp2LogVal(amp2) {
  return !amp2 ? 0 : clamp(Math.log10(amp2) * AMP2_LOG + 1.0);
}

async function renderFFT() {
  let f32data = audio32.subarray(aviewport.min, aviewport.min + aviewport.len);
  log.i('Input audio:', f32data.length, 'float32 samples');
  let n = FFT_SIZE;
  let cw = canvasFFT.width;
  let ch = canvasFFT.height;
  let dist = f32data.length / cw;
  log.i('FFT:', cw, 'frames', 'x', n, 'freq bins');
  log.i('FFT overlapping:', (n - dist) | 0, 'samples',
    '=', (1 - dist / n) * 100 | 0, '% per frame');
  if (cw * n < f32data.length)
    log.w('Too much audio data: spectrogram will be sparse');

  let tprev = Date.now();
  let ctx2d = canvasFFT.getContext('2d');
  let image = ctx2d.getImageData(0, 0, cw, n);
  let input1 = new Float32Array(n);
  let input2 = new Float32Array(n * 2); // (re, im), im = 0
  let output = new Float32Array(n * 2);
  let ampsqr = new Float32Array(n); // |FFT[i]|^2

  fftSqrAmp.fill(0);

  for (let x = 0; x < cw; x++) {
    let offset = x * dist | 0;
    getPaddedSlice(f32data, offset, offset + n, input1);
    FFT.expand(input1, input2);
    fft.transform(input2, output);
    FFT.sqr_abs(output, ampsqr);
    fftSqrAmp.set(ampsqr.subarray(0, n / 2), x * n / 2);

    for (let y = 0; y < ch; y++) {
      let b = (y * cw + x) * 4;
      let d = image.data;
      let a = ampsqr[ch - y - 1];
      let q = (1 - getAmp2LogVal(a)) * 256;
      d[b + 0] = q;
      d[b + 1] = q;
      d[b + 2] = q;
      d[b + 3] = 256;
    }

    if (Date.now() > tprev + 1000) {
      ctx2d.putImageData(image, 0, 0);
      log.i('FFT progress:', x / cw * 100 | 0, '%');
      await sleep(10);
      tprev = Date.now();
    }
  }

  log.i('Done rendering FFT');
  ctx2d.putImageData(image, 0, 0);
}

function getAudioFrame(afid) {
  let n2 = FFT_SIZE / 2;
  let offset = afid * n2;
  let ampsqr = fftSqrAmp.subarray(offset, offset + n2);
  if (ampsqr.length != n2)
    throw new Error('Invalid ampsqr size: ' + ampsqr.length + ' at x=' + afid);
  return ampsqr;
}

function renderSpectrum(frameFrom = 0, frameTo = -1) {
  log.i(`Rendering spectrum: frames ${frameFrom}..${frameTo}`);
  if (frameTo < 0)
    frameTo += numFrames;
  if (frameFrom < 0)
    frameFrom += numFrames;

  let n2 = FFT_SIZE / 2;
  let cw = canvasSpectrum.width;
  let ch = canvasSpectrum.height;
  log.i(`Spectrum window: ${cw} freq bins, ${ch} amp2 bins`);

  // Pick only the first cw freq bins.
  if (cw > n2)
    throw new Error('Spectrum canvas is too wide: ' + cw + ' > ' + n2);

  fbins.fill(0);
  for (let fid = frameFrom; fid <= frameTo; fid++) {
    let frame = getAudioFrame(fid);
    for (let x = 0; x < cw; x++) {
      let s = frame[x];
      s = getAmp2LogVal(s);
      let y = clamp(s, 0, 1) * ch | 0;
      fbins[y * cw + x]++;
    }
  }

  let ctx2d = canvasSpectrum.getContext('2d');
  let image = ctx2d.getImageData(0, 0, cw, ch);

  for (let x = 0; x < cw; x++) {
    for (let y = 0; y < ch; y++) {
      let s = fbins[y * cw + x];
      // s = Math.log(1 + s) / Math.log(cw * ch) * FBIN_MUL;
      s = s / ch * 5 * FBIN_MUL;
      let b = ((ch - 1 - y) * cw + x) * 4;
      let q = (1 - clamp(s)) * 256 | 0;
      image.data[b + 0] = q;
      image.data[b + 1] = q;
      image.data[b + 2] = q;
      image.data[b + 3] = 256;
    }
  }

  ctx2d.putImageData(image, 0, 0);
  log.i('Done rendering spectrum');
}

function pdraw(canvas, weights = [1, 1, 1], clevel = 1, zoom = 5) {
  let cw = canvas.width;
  let ch = canvas.height; 5
  let ctx = canvas.getContext('2d');
  let img = ctx.getImageData(0, 0, cw, ch);

  for (let x = 0; x < cw; x++) {
    for (let y = 0; y < ch; y++) {
      let cx = x / cw - 0.5;
      let cy = y / ch - 0.5;
      let pv = peval(weights, cy * zoom, cx * zoom);
      let color = pv < clevel ? 0 : 255;
      let offset = 4 * (x + cw * (ch - 1 - y));
      img.data[offset + 0] = color;
      img.data[offset + 1] = color;
      img.data[offset + 2] = color;
      img.data[offset + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// weights[k] * (cx + i*cy)^k
function peval(weights, cx, cy) {
  let sx = 0, sy = 0;
  let zx = 1, zy = 0;

  for (let k = 0; k < weights.length; k++) {
    let w = weights[k];
    sx += w * zx;
    sy += w * zy;
    let zx2 = zx * cx - zy * cy;
    let zy2 = zx * cy + zy * cx;
    zx = zx2;
    zy = zy2;
  }

  return Math.sqrt(sx * sx + sy * sy);
}

canvasSpectrum.addEventListener('click', async (e) => {
  e.preventDefault();
  if (sdrawing) return;
  sdrawing = true;
  let frame = getAudioFrame(numFrames / 2); // middle frame
  let fbase = e.offsetX / canvasSpectrum.clientWidth * FFT_FMAX;
  let weights = [1];
  let wsum = 0;
  log.i('Base freq bin:', fbase | 0, fbase / FFT_FMAX * 22500 | 0, 'Hz');

  for (let k = 1; k < HW_LEN; k++) {
    let x = fbase * k | 0;
    let w = x < frame.length ? frame[x] : 0;
    w = getAmp2LogVal(w);
    weights[k] = w;
    wsum += w;
  }

  for (let k = 1; k < HW_LEN; k++)
    weights[k] /= wsum;

  log.i('Weights:', weights.map(w => w.toFixed(3)).join(' '));
  pdraw(canvasImage, weights, 1);
  sdrawing = false;
});

canvasFFT.addEventListener('click', async (e) => {
  e.preventDefault();
  let audioContext = new AudioContext;
  let file = await selectAudioFile();
  if (!file) return;
  log.i('Selected file:', file.type,
    file.size / 2 ** 10 | 0, 'KB', file.name);
  audio.src = URL.createObjectURL(file);
  audio.play();

  let fileData = await file.arrayBuffer();
  let abuffer = await audioContext.decodeAudioData(fileData);
  log.i('Audio buffer:',
    abuffer.numberOfChannels, 'ch',
    'x', abuffer.sampleRate, 'Hz',
    abuffer.duration.toFixed(1), 'sec');

  audio32 = abuffer.getChannelData(0);
  aviewport.min = 0;
  aviewport.len = Math.min(audio32.length, numFrames * FFT_SIZE);
  await renderFFT();
  renderSpectrum();
});

document.body.onkeypress = async (e) => {
  e.preventDefault();
  let key = e.key.toUpperCase();
  console.log('Press:', key);
  let dx = aviewport.len / 2;
  let changed = false;

  switch (key) {
    case 'A':
      if (aviewport.min < dx) break;
      log.i('Moving backward by', dx, 'samples');
      aviewport.min -= dx;
      changed = true;
      break;
    case 'D':
      if (aviewport.min > audio32.length - dx) break;
      log.i('Moving forward by', dx, 'samples');
      aviewport.min += dx;
      changed = true;
      break;
    case 'W':
      if (aviewport.len < FFT_SIZE * 2) break;
      log.i('Zooming in 2x');
      aviewport.min += dx / 2;
      aviewport.len *= 0.5;
      changed = true;
      break;
    case 'S':
      if (aviewport.len > audio32.length / 2) break;
      if (aviewport.min < dx) break;
      log.i('Zooming out 2x');
      aviewport.min -= dx;
      aviewport.len *= 2;
      changed = true;
      break;
  }

  if (changed) {
    await renderFFT();
    renderSpectrum();
  }
};

log.i('Ready.');
