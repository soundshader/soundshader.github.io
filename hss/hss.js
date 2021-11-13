import * as log from '../log.js';
import { FFT } from '../audio/fft.js';

const ARGS = new URLSearchParams(location.search);
const SAMPLE_RATE = +ARGS.get('srate') || 48000;
const USE_WDF = +ARGS.get('wdf') || 0;
const FFT_SIZE = +ARGS.get('bins') || 1024;
const NUM_FREQS = +ARGS.get('ch') || 1024;
const NUM_FRAMES = +ARGS.get('cw') || 1024;
// On 48 kHz audio, FFT_SIZE/2 bins maps to 24 kHz.
// This is also the max possible value: FFT can't
// detect frequencies higher than FFT_SIZE/2.
let freqMax = +ARGS.get('fmax') || FFT_SIZE / 4;
let freqMin = +ARGS.get('fmin') || 0;
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
const vButtons = $('#buttons');
const fft = new FFT(FFT_SIZE);
const fftSqrAmp = new Float32Array(NUM_FRAMES * NUM_FREQS);

canvasFFT.height = NUM_FREQS;
canvasFFT.width = NUM_FRAMES;

let audioCtx = null;
let abuffer = null;
let audio32 = null;
let shortcuts = {}; // 'A' -> function
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
function getZeroPaddedSlice(src, min, max,
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

function loudness(amp2) {
  return amp2 <= 0 ? -Infinity : Math.log10(amp2) / AMP2_LOG;
}

async function renderFFT() {
  if (fftCToken)
    fftCToken.cancelled = true;
  fftCToken = {};
  let ctoken = fftCToken;
  await sleep(5);

  let n = FFT_SIZE;
  let nshifts = NUM_FREQS / (freqMax - freqMin);
  let cw = canvasFFT.width;
  let ch = canvasFFT.height;
  let step = aviewport.len / cw;
  let tprev = Date.now();
  let ctx2d = canvasFFT.getContext('2d');
  let image = ctx2d.getImageData(0, 0, cw, ch);
  let input0 = new Float32Array(n);
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
    let offset = aviewport.min + x * step | 0;
    getZeroPaddedSlice(audio32, offset - n / 2, offset + n / 2, input0);
    if (USE_WDF)
      applyWDF(input0, input1);
    else
      input1.set(input0);
    if (USE_WINFN) applyHannWindow(input1);
    FFT.expand(input1, input2);
    let frame = getSqrAmpFrame(x);
    assert(frame.length == (freqMax - freqMin) * nshifts);

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
      for (let i = freqMin; i < freqMax; i++)
        frame[(i - freqMin) * nshifts + s] = ampsqr[i];
    }

    // WDF is already squared.
    if (USE_WDF) applyFn(frame, Math.sqrt);

    if (Date.now() > tprev + 150) {
      log.v('FFT progress:', x / cw * 100 | 0, '%');
      await sleep(5);
      tprev = Date.now();
      if (ctoken.cancelled) {
        log.i('FFT cancelled');
        return;
      }
    }
  }

  let gmax = 0;
  for (let i = 0; i < fftSqrAmp.length; i++)
    gmax = Math.max(gmax, fftSqrAmp[i]);

  for (let x = 0; x < cw; x++) {
    let frame = getSqrAmpFrame(x);
    let hue = getSpectrumColor(frame); // 0..1
    let fmax = 0;
    for (let y = 0; y < frame.length; y++)
      fmax = Math.max(fmax, frame[y]);

    for (let y = 0; y < ch; y++) {
      let a = frame[ch - y - 1];
      let vol = clamp(loudness(a) - loudness(gmax) + 1);
      let sat = 1 - a / fmax;
      let [r, g, b] = hsv2rgb(hue, sat, vol);
      let offset = (y * cw + x) * 4;
      image.data[offset + 0] = r * 255;
      image.data[offset + 1] = g * 255;
      image.data[offset + 2] = b * 255;
      image.data[offset + 3] = 255;
    }
  }

  ctx2d.putImageData(image, 0, 0);
}

function applyFn(a, fn) {
  for (let i = 0; i < a.length; i++)
    a[i] = fn(a[i]);
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

function interpolate(src, x) {
  if (!fract(x)) return src[x];
  let i = x | 0, j = i + 1;
  return src[i] * (j - x) + src[j] * (x - i);
}

function applyWDF(src, res) {
  let n = src.length;
  assert(res.length == n);
  for (let i = 0; i < n; i++) {
    let j = i / 2 + n / 4;
    res[i] = interpolate(src, j) * interpolate(src, n - 1 - j);
  }
}

function applyHannWindow(frame) {
  let n = frame.length;
  for (let i = 0; i < n; i++) {
    let s = Math.sin(Math.PI * i / n);
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
  return clamp(mix(freqMin, freqMax, s / sum) / FFT_SIZE * 4);
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

async function refreshViewport() {
  aviewport.min = Math.max(0, aviewport.min | 0);
  aviewport.len = Math.min(audio32.length - aviewport.min, aviewport.len | 0);
  await renderFFT();
}

function setShortcut(key, spec) {
  assert(!shortcuts[key]);
  assert(spec.handler);
  assert(spec.title);
  shortcuts[key] = spec;
  let button = document.createElement('button');
  button.setAttribute('title', spec.title);
  button.textContent = key;
  button.onclick = () => shortcuts[key].handler();
  vButtons.append(button);
}

function defineShortcuts() {
  setShortcut('\uD83D\uDCC2', {
    title: 'Upload audio',
    handler: async () => {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      let file = await selectAudioFile();
      if (!file) return;
      document.title = file.name;
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
      aviewport.len = Math.min(audio32.length, 10 * SAMPLE_RATE);
      await renderFFT();
      playAudioSample(abuffer);
    },
  });

  setShortcut('A', {
    title: 'Move backwards',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min -= dx / 2;
      refreshViewport();
    },
  });

  setShortcut('D', {
    title: 'Move forward',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min += dx / 2;
      refreshViewport();
    },
  });

  setShortcut('Q', {
    title: 'Zoom in',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min += dx / 2;
      aviewport.len *= 0.5;
      refreshViewport();
    },
  });

  setShortcut('E', {
    title: 'Zoom out',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min -= dx;
      aviewport.len *= 2;
      refreshViewport();
    },
  });

  setShortcut('F', {
    title: 'Reduce max freq',
    handler: () => {
      let df = freqMax - freqMin;
      if (freqMax - df / 2 <= freqMin) return;
      freqMax -= df / 2;
      log.v('New max freq:', freqMax / FFT_SIZE * 2);
      refreshViewport();
    },
  });

  setShortcut('R', {
    title: 'Increase max freq',
    handler: () => {
      let df = freqMax - freqMin;
      if (freqMax + df > FFT_SIZE / 2) return;
      freqMax += df;
      log.v('New max freq:', freqMax / FFT_SIZE * 2);
      refreshViewport();
    },
  });

  setShortcut('W', {
    title: 'Increase freq min..max window',
    handler: () => {
      let df = freqMax - freqMin;
      freqMax = Math.min(FFT_SIZE / 2, freqMax + df / 2);
      freqMin = freqMax - df;
      log.v('New min freq:', freqMin / FFT_SIZE * 2);
      refreshViewport();
    },
  });

  setShortcut('S', {
    title: 'Shrink freq min..max window',
    handler: () => {
      let df = freqMax - freqMin;
      freqMin = Math.max(0, freqMin - df / 2);
      freqMax = freqMin + df;
      log.v('New min freq:', freqMin / FFT_SIZE * 2);
      refreshViewport();
    },
  });
}

canvasFFT.onmousemove = e => {
  if (!abuffer) return;
  let x = e.offsetX / canvasFFT.clientWidth;
  let y = e.offsetY / canvasFFT.clientHeight;
  let dt = (x * aviewport.len + aviewport.min) / audio32.length * abuffer.duration;
  let hz = mix(freqMin, freqMax, 1 - y) / FFT_SIZE * SAMPLE_RATE;
  let a2 = fftSqrAmp[(x * NUM_FRAMES | 0) * NUM_FREQS + ((1 - y) * NUM_FREQS | 0)];
  eInfo.textContent = dt.toFixed(2) + 's '
    + hz.toFixed(0) + ' Hz '
    + a2.toExponential(1);
};

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
  let spec = shortcuts[key];
  if (spec) spec.handler();
};

defineShortcuts();
drawVerticalLine();
log.i('Ready');
