import * as log from '../log.js';
import { FFT } from '../audio/fft.js';

const ARGS = new URLSearchParams(location.search);
const SAMPLE_RATE = +ARGS.get('srate') || 48000;
const USE_WDF = +ARGS.get('wdf') || 0;
const FFT_SIZE = +ARGS.get('bins') || (USE_WDF ? 2048 : 1024);
const NUM_FREQS = +ARGS.get('ch') || 1024;
const NUM_FRAMES = +ARGS.get('cw') || 1024;
// On 48 kHz audio, FFT_SIZE/2 bins maps to 24 kHz.
// This is also the max possible value: FFT can't
// detect frequencies higher than FFT_SIZE/2.
let fftMax = +ARGS.get('fmax') || FFT_SIZE / 4;
// 5.0 means the 0..255 rgba range maps to 1e-5..1.0.
// This seems excessive, but ear is able to hear the
// 1e-5 signal clearly. Can be tested on bird songs.
const AMP2_LOG = +ARGS.get('alog') || 5;
const USE_WINFN = +ARGS.get('winf') || (USE_WDF ? 1 : 0);

const $ = s => document.querySelector(s);
const sleep = dt => new Promise(resolve => setTimeout(resolve, dt));
const clamp = (x, min = 0, max = 1) => x < min ? min : x > max ? max : x;
const fract = (x) => x - Math.floor(x);
const mix = (min, max, x) => min * (1 - x) + max * x;

const vTimeBar = $('#vtimebar');
const canvasFFT = $('#fft');
const eInfo = $('#info');
const fft = new FFT(FFT_SIZE);
const fftSqrAmp = new Float32Array(NUM_FRAMES * NUM_FREQS);

canvasFFT.height = NUM_FREQS;
canvasFFT.width = NUM_FRAMES;

let audioCtx = null;
let abuffer = null;
let audio32 = null;
let aviewport = { min: 0, len: 0 };
let fftCToken = { cancelled: false };
let audioCtxStartTime = 0;
let vTimeBarAnimationId = 0;
let fftSqrAmpPos = 0; // NUM_FRAMES starting from here in abuffer.
let fftSqrAmpLen = 0;

function assert(x) {
  if (x) return;
  debugger;
  throw new Error('assert() failed');
}

async function selectAudioFile() {
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/mpeg; audio/wav; audio/webm';
  input.click();
  return new Promise((resolve) => {
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

function getLoudness(amp2) {
  return !amp2 ? 0 : clamp(Math.log10(amp2) / AMP2_LOG + 1.0);
}

async function renderFFT(ctoken = fftCToken) {
  let n = FFT_SIZE;
  let nshifts = NUM_FREQS / fftMax;
  let f32data = audio32.subarray(aviewport.min, aviewport.min + aviewport.len + n);
  let cw = canvasFFT.width;
  let ch = canvasFFT.height;
  let step = aviewport.len / cw;
  let tprev = Date.now();
  let ctx2d = canvasFFT.getContext('2d');
  let image = ctx2d.getImageData(0, 0, cw, ch);
  let input1 = new Float32Array(n);
  let input2 = new Float32Array(n * 2); // (re, im), im = 0
  let input3 = new Float32Array(n * 2); // input2 shifted
  let output = new Float32Array(n * 2);
  let ampsqr = new Float32Array(n); // |FFT[i]|^2

  let xmin = 0, xmax = cw - 1;
  if (fftSqrAmpLen != aviewport.len) {
    fftSqrAmp.fill(0);
  } else {
    let s = (aviewport.min - fftSqrAmpPos) / step | 0;
    rotateArray(fftSqrAmp, s * NUM_FREQS);
    if (s > 0) xmin = s;
    if (s < 0) xmax = -s;
  }
  fftSqrAmpPos = aviewport.min;
  fftSqrAmpLen = aviewport.len;

  for (let x = xmin; x <= xmax; x++) {
    let offset = x * step | 0;
    getPaddedSlice(f32data, offset - n / 2, offset + n / 2, input1);
    if (USE_WDF) applyWDF(input1);
    if (USE_WINFN) applyHannWindow(input1);
    FFT.expand(input1, input2);
    let frame = getSqrAmpFrame(x);
    assert(frame.length == fftMax * nshifts);

    // This is called shifted DFT. Normal DFT with 1024 bins
    // on a 48 kHz input has a max resolution of 1024/48000 s.
    // or 47 Hz per bin. One way to get higher resolution is
    // to use CWT. Another way is to use the DFT Shift Theorem:
    // multiplying the input by the exp(i*pi/2*k/n) function
    // and applying DFT on it yields the original
    // DFT shifted by half-bin or 25 Hz. This can be repeated
    // to shift DFT by 1/4-th bin and so on. Assembling the
    // shifted DFTs gets a result almost identical to CWT.
    for (let s = 0; s < nshifts; s++) {
      FFT.shift(input2, input3, -s / nshifts);
      fft.transform(input3, output);
      FFT.sqr_abs(output, ampsqr);
      for (let i = 0; i < fftMax; i++)
        frame[i * nshifts + s] = ampsqr[i];
    }

    if (USE_WDF) {
      // While WDF is a strictly real function (Im = 0),
      // WDF of a FFT.shift'd wave has the Im != 0 component.
      for (let i = 0; i < frame.length; i++)
        frame[i] = Math.sqrt(frame[i]);
    }

    if (Date.now() > tprev + 250) {
      log.v('FFT progress:', x / cw * 100 | 0, '%');
      await sleep(0);
      ctx2d.putImageData(image, 0, 0);
      tprev = Date.now();
      if (ctoken.cancelled) return;
    }
  }

  let maxvol = 0;
  for (let i = 0; i < fftSqrAmp.length; i++) {
    let a = fftSqrAmp[i];
    let v = getLoudness(a);
    maxvol = Math.max(maxvol, v);
  }

  for (let x = 0; x < cw; x++) {
    let frame = getSqrAmpFrame(x);
    let hue = getSpectrumColor(frame); // 0..1
    let maxamp2 = 0;

    for (let y = 0; y < frame.length; y++)
      maxamp2 = Math.max(maxamp2, frame[y]);

    for (let y = 0; y < ch; y++) {
      let a = frame[ch - y - 1];
      let v = getLoudness(a);
      let vol = v / maxvol;
      let sat = 1 - a / maxamp2;
      let [r, g, b] = hsv2rgb(hue, sat, vol);
      let offset = (y * cw + x) * 4;
      image.data[offset + 0] = vol * r * 255;
      image.data[offset + 1] = vol * g * 255;
      image.data[offset + 2] = vol * b * 255;
      image.data[offset + 3] = 255;
    }
  }

  ctx2d.putImageData(image, 0, 0);
}

function rotateArray(a, m) {
  assert(Math.abs(m) < a.length);
  if (m > 0) a.set(a.subarray(m), 0);
  if (m < 0) a.set(a.subarray(0, m), -m);
}

function getSqrAmpFrame(x) {
  let n = NUM_FREQS;
  assert(x >= 0 && x < NUM_FRAMES);
  return fftSqrAmp.subarray(x * n, (x + 1) * n);
}

function applyWDF(wave) {
  let n = wave.length;
  for (let i = 0; i < n / 2; i++)
    wave[i] *= wave[n - 1 - i];
  for (let i = 0; i < n / 2; i++)
    wave[i] = wave[n / 2 + i >> 1];
  for (let i = 0; i < n / 2; i++)
    wave[n - 1 - i] = wave[i];
}

function applyHannWindow(frame) {
  let n = frame.length;
  for (let i = 0; i < n; i++) {
    let s = Math.sin(Math.PI * (i + 0.5) / n);
    frame[i] *= (s * s);
  }
}

function getSpectrumColor(frame) {
  let s = 0, sum = 0, n = frame.length;
  for (let i = 0; i < n; i++) {
    let w = frame[i];
    sum += w;
    s += w * i / n;
  }
  return s / sum;
}

function hsv2rgb(hue, sat = 1, val = 1) {
  // vec3 hsv2rgb(vec3 c) {
  //   vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  //   vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  //   return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  // }
  let Kx = 1, Ky = 2 / 3, Kz = 1 / 3, Kw = 3;
  let px = Math.abs(fract(hue + Kx) * 6 - Kw);
  let py = Math.abs(fract(hue + Ky) * 6 - Kw);
  let pz = Math.abs(fract(hue + Kz) * 6 - Kw);
  let r = val * mix(Kx, clamp(px - Kx, 0, 1), sat);
  let g = val * mix(Kx, clamp(py - Kx, 0, 1), sat);
  let b = val * mix(Kx, clamp(pz - Kx, 0, 1), sat);
  return [r, g, b];
}

function playAudioSample(abuffer) {
  let source = audioCtx.createBufferSource();
  source.buffer = abuffer;
  source.connect(audioCtx.destination);
  audioCtxStartTime = audioCtx.currentTime;
  log.i('Playing audio at', audioCtxStartTime.toFixed(1), 's');
  source.start();
}

function drawVerticalLine() {
  cancelAnimationFrame(vTimeBarAnimationId);
  vTimeBarAnimationId = requestAnimationFrame(drawVerticalLine);
  if (!abuffer) return;
  let at = audioCtx.currentTime - audioCtxStartTime;
  let cp = at / abuffer.duration * audio32.length;
  let dt = (cp - aviewport.min) / aviewport.len;
  vTimeBar.style.left = (100 * dt).toFixed(2) + '%';
  vTimeBar.style.visibility = dt < 0 || dt > 1 ? 'hidden' : 'visible';
  if (at > abuffer.duration)
    cancelAnimationFrame(vTimeBarAnimationId);
}

canvasFFT.onmousemove = e => {
  if (!abuffer) return;
  let x = e.offsetX / canvasFFT.clientWidth;
  let y = e.offsetY / canvasFFT.clientHeight;
  let dt = (x * aviewport.len + aviewport.min) / audio32.length * abuffer.duration;
  let hz = (1 - y) * fftMax / FFT_SIZE * SAMPLE_RATE;
  eInfo.textContent = dt.toFixed(2) + 's ' + hz.toFixed(0) + ' Hz';
};

$('#upload').addEventListener('click', async (e) => {
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  let file = await selectAudioFile();
  if (!file) return;
  log.i('Selected file:', file.type,
    file.size / 2 ** 10 | 0, 'KB', file.name);

  let fileData = await file.arrayBuffer();
  log.v('Decoding audio data...');
  abuffer = await audioCtx.decodeAudioData(fileData);
  log.i('Audio buffer:',
    abuffer.numberOfChannels, 'ch',
    'x', abuffer.sampleRate, 'Hz',
    abuffer.duration.toFixed(1), 'sec');

  audio32 = abuffer.getChannelData(0);
  aviewport.min = 0;
  aviewport.len = audio32.length;
  await renderFFT();
  playAudioSample(abuffer);
});

canvasFFT.onclick = (e) => {
  if (!abuffer) return;
  let x = e.offsetX / canvasFFT.clientWidth;
  let t = (x * aviewport.len + aviewport.min) | 0;
  let changed = false;
  if (e.ctrlKey) {
    changed = true;
    aviewport.len -= t - aviewport.min;
    aviewport.min = t;
  } else if (e.shiftKey) {
    changed = true;
    aviewport.len = t - aviewport.min;
  }
  if (changed)
    renderFFT();
};

document.body.onkeypress = async (e) => {
  let key = e.key.toUpperCase();
  let dx = aviewport.len / 2;
  let changed = false;

  switch (key) {
    case 'A':
      log.v('Moving backward by', dx / 2, 'samples');
      aviewport.min -= dx / 2;
      changed = true;
      break;
    case 'D':
      log.v('Moving forward by', dx / 2, 'samples');
      aviewport.min += dx / 2;
      changed = true;
      break;
    case 'W':
      log.v('Zooming in 2x');
      aviewport.min += dx / 2;
      aviewport.len *= 0.5;
      changed = true;
      break;
    case 'S':
      log.v('Zooming out 2x');
      aviewport.min -= dx;
      aviewport.len *= 2;
      changed = true;
      break;
    case 'Q':
      if (fftMax <= 32) break;
      fftMax /= 2;
      log.v('New max freq:', fftMax / FFT_SIZE * 2);
      changed = true;
      break;
    case 'E':
      if (fftMax >= FFT_SIZE / 2) break;
      fftMax *= 2;
      log.v('New max freq:', fftMax / FFT_SIZE * 2);
      changed = true;
      break;
  }

  if (changed) {
    aviewport.min = Math.max(0, aviewport.min | 0);
    aviewport.len = Math.min(audio32.length - aviewport.min, aviewport.len | 0);
    await sleep(0);
    if (fftCToken)
      fftCToken.cancelled = true;
    fftCToken = {};
    await renderFFT();
  }
};

drawVerticalLine();
log.i('Ready.');
