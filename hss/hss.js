import * as log from '../log.js';
import { FFT } from '../audio/fft.js';

const ARGS = new URLSearchParams(location.search);

const SAMPLE_RATE = 48000;
const FFT_SIZE = 1024;
const NUM_FRAMES = 1024;
// On 48 kHz audio, FFT_SIZE/2 bins maps to 24 kHz.
// This is also the max possible value: FFT can't
// detect frequencies higher than FFT_SIZE/2.
let fftMax = +ARGS.get('fmax') || 256;
// 0.2 means the 0..255 rgba range maps to 1e-5..1.0.
// This seems excessive, but ear is able to hear the
// 1e-5 signal clearly. Can be tested on bird songs.
const AMP2_LOG = 0.2;

const $ = s => document.querySelector(s);
const sleep = dt => new Promise(resolve => setTimeout(resolve, dt));
const clamp = (x, min = 0, max = 1) => x < min ? min : x > max ? max : x;
const fract = (x) => x - Math.floor(x);
const mix = (min, max, x) => min * (1 - x) + max * x;

const vTimeBar = $('#vtimebar');
const canvasFFT = $('#fft');
const fft = new FFT(FFT_SIZE);
const fftSqrAmp = new Float32Array(FFT_SIZE * NUM_FRAMES);
const rgba_data = new Uint8ClampedArray(FFT_SIZE * NUM_FRAMES * 4);

canvasFFT.height = FFT_SIZE;
canvasFFT.width = NUM_FRAMES;

let audioCtx = null;
let abuffer = null;
let audio32 = null;
let aviewport = { min: 0, len: 0 };
let fftCToken = { cancelled: false };
let audioCtxStartTime = 0;
let vTimeBarAnimationId = 0;
let usePolarCoords = false;
let fftSqrAmpPos = 0; // NUM_FRAMES starting from here in abuffer.
let fftSqrAmpLen = 0;

function assert(x) {
  if (!x) {
    debugger;
    throw new Error('assert() failed');
  }
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
  return !amp2 ? 0 : clamp(Math.log10(amp2) * AMP2_LOG + 1.0);
}

async function renderFFT(ctoken = fftCToken) {
  let n = FFT_SIZE;
  let ns = FFT_SIZE / fftMax;
  let f32data = audio32.subarray(aviewport.min, aviewport.min + aviewport.len + n);
  let s2t = k => (k / audio32.length * abuffer.duration | 0) + 's';

  let cw = canvasFFT.width;
  let ch = canvasFFT.height;
  let step = aviewport.len / cw;
  log.i('FFT input:', s2t(aviewport.len),
    'at', s2t(aviewport.min), 'out of', s2t(audio32.length), 'total;',
    cw, 'frames', 'x', n, 'freq bins', 'x', ns, 'shifted inter-layers;',
    'step', step | 0);
  if (cw * n < aviewport.len)
    log.w('Too much audio data: spectrogram will be sparse');

  let tprev = Date.now();
  let ctx2d = canvasFFT.getContext('2d');
  let image = ctx2d.getImageData(0, 0, cw, n);
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
    let a = fftSqrAmp;
    if (s > 0) {
      // a shl s
      a.set(a.subarray(s * n), 0);
      xmin = s;
    } else if (s < 0) {
      // a shr s
      a.set(a.subarray(0, s * n), -s * n);
      xmax = -s;
    }
  }

  fftSqrAmpPos = aviewport.min;
  fftSqrAmpLen = aviewport.len;

  for (let x = xmin; x <= xmax; x++) {
    let offset = x * step | 0;
    getPaddedSlice(f32data, offset, offset + n, input1);
    let frame = fftSqrAmp.subarray(x * n, x * n + n);
    FFT.expand(input1, input2);

    // This is called shifted DFT. Normal DFT with 1024 bins
    // on a 48 kHz input has a max resolution of 1024/48000 s.
    // or 47 Hz per bin. One way to get higher resolution is
    // to use CWT. Another way is to use the DFT Shift Theorem:
    // multiplying the input by the exp(i*pi/2*k/n) function
    // and applying DFT on it yields the original
    // DFT shifted by half-bin or 25 Hz. This can be repeated
    // to shift DFT by 1/4-th bin and so on. Assembling the
    // shifted DFTs gets a result almost identical to CWT.
    for (let s = 0; s < ns; s++) {
      FFT.shift(input2, input3, -s / ns);
      fft.transform(input3, output);
      FFT.sqr_abs(output, ampsqr);
      for (let i = 0; i < fftMax; i++)
        frame[i * ns + s] = ampsqr[i];
    }

    if (Date.now() > tprev + 150) {
      log.v('FFT progress:', x / cw * 100 | 0, '%');
      await sleep(0);
      tprev = Date.now();
      if (ctoken.cancelled)
        return;
    }
  }

  for (let x = 0; x < cw; x++) {
    let frame = fftSqrAmp.subarray(x * n, x * n + n);
    let hue = getSpectrumColor(frame); // 0..1
    let maxamp2 = 0;

    for (let y = 0; y < frame.length; y++)
      maxamp2 = Math.max(maxamp2, frame[y]);

    for (let y = 0; y < ch; y++) {
      let amp2 = frame[ch - y - 1];
      let vol = getLoudness(amp2);
      let sat = 1 - amp2 / maxamp2;
      let [r, g, b] = hsv2rgb(hue, sat, vol);

      let offset = (y * cw + x) * 4;
      rgba_data[offset + 0] = vol * r * 255;
      rgba_data[offset + 1] = vol * g * 255;
      rgba_data[offset + 2] = vol * b * 255;
      rgba_data[offset + 3] = 255;
    }
  }

  if (!usePolarCoords) {
    image.data.set(rgba_data);
  } else {
    for (let x = 0; x < cw; x++) {
      for (let y = 0; y < ch; y++) {
        let dx = 2 * x / cw - 1;
        let dy = 2 * y / cw - 1;
        let a = Math.atan2(dx, -dy) / Math.PI * 0.5 + 0.5; // 0..1
        let r = Math.hypot(dx, dy); // 0..1
        a = Math.abs(a - 0.5) * 2;
        r = 1 - Math.abs(r - 0.25);
        let sx = clamp(a) * cw | 0;
        let sy = clamp(r) * ch | 0;
        let src = (sy * cw + sx) * 4;
        let res = (y * cw + x) * 4;
        image.data[res + 0] = rgba_data[src + 0];
        image.data[res + 1] = rgba_data[src + 1];
        image.data[res + 2] = rgba_data[src + 2];
        image.data[res + 3] = rgba_data[src + 3];
      }
    }
  }

  ctx2d.putImageData(image, 0, 0);
}

function getSpectrumColor(frame) {
  assert(frame.length == FFT_SIZE);
  let s = 0, t = 0;
  for (let i = 0; i < frame.length; i++) {
    let v = getLoudness(frame[i]);
    t += v;
    s += i * v;
  }
  return s / t / frame.length; // * fftMax / FFT_SIZE * 2;
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
  document.title = dt.toFixed(1) + 's ' + hz.toFixed(0) + ' Hz';
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
  aviewport.len = Math.min(audio32.length, SAMPLE_RATE * 5);
  await renderFFT();
  playAudioSample(abuffer);
});

$('#polar').onclick = (e) => {
  if (!abuffer) return;
  usePolarCoords = !usePolarCoords;
  renderFFT();
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
