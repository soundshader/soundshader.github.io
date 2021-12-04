import * as log from '../log.js';
import { FFT, AutoCF } from '../audio/fft.js';
import { GpuContext } from '../webgl/gpu-context.js';

const ARGS = new URLSearchParams(location.search);
const uarg = (s, v) => ARGS.get(s) == '' ? v : ARGS.get(s);
const SAMPLE_RATE = +ARGS.get('srate') || 48000;
const USE_WDF = +ARGS.get('wdf') || 0;
let FFT_SIZE = +ARGS.get('bins') || 1024;
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
const AMP2_LOG_INITIAL = +uarg('alog', 5);
const USE_WINFN = ARGS.get('winf') != '0';
const USE_GPU = ARGS.get('gpu') == 1;
const BASE_FREQ = 432; // Hz
const FREQ_LOW = +ARGS.get('f_low') || 54; // Hz

const $ = s => document.querySelector(s);
const sleep = dt => new Promise(resolve => setTimeout(resolve, dt));
const clamp = (x, min = 0, max = 1) => x < min ? min : x > max ? max : x;
const fract = (x) => x - Math.floor(x);
const mix = (min, max, x) => min * (1 - x) + max * x;
const min = Math.min;
const max = Math.max;
const hann = x => x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 2 : 0;
const hann_step = (x, a, b) => x < a ? 0 : x > b ? 1 : hann((x - a) / (b - a) * 0.5);

const vTimeBar = $('#vtimebar');
const canvasFFT = $('#fft');
const eInfo = $('#info');
const vButtons = $('#buttons');

let gl_canvas = null;
let gl_context = null;
let fft = null;
let acf = null;

canvasFFT.height = NUM_FREQS;
canvasFFT.width = NUM_FRAMES;

let audioCtx = null;
let abuffer = null;
let audio32 = null;
let shortcuts = {}; // 'A' -> function
let aviewport = { min: 0, len: 0 };
let playingAudioSource = null;
let audioCtxStartTime = 0;
let vTimeBarAnimationId = 0;
let fftSqrAmpPos = 0; // NUM_FRAMES starting from here in abuffer.
let fftSqrAmpLen = 0;
let micAudioStream = null;
let mediaRecorder = null;
let micAudioChunks = null;

let render_args = {
  image: null,
  showPhase: false,
  showPolarCoords: false,
  showACF: false,
  amp2max: 0,
  amp2log: AMP2_LOG_INITIAL,
  fft: {
    fbins: NUM_FREQS,
    tbins: NUM_FRAMES,
    phase: new Float32Array(NUM_FRAMES * NUM_FREQS), // -pi..pi
    sqr_amp: new Float32Array(NUM_FRAMES * NUM_FREQS),
    max_amp: new Float32Array(NUM_FRAMES),
    // ACF specific:
    hue_r: new Float32Array(NUM_FRAMES * NUM_FREQS),
    hue_g: new Float32Array(NUM_FRAMES * NUM_FREQS),
    hue_b: new Float32Array(NUM_FRAMES * NUM_FREQS),
  },
};

function assert(x) {
  if (x) return;
  debugger;
  throw new Error('assert() failed');
}

function initFFT() {
  if (fft)
    return;

  if (USE_GPU) {
    gl_canvas = document.createElement('canvas');
    gl_context = new GpuContext(gl_canvas);
    gl_context.init();
  }

  fft = new FFT(FFT_SIZE, { webgl: gl_context });
  acf = new AutoCF(fft);
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

function loudness(x) {
  return !render_args.amp2log ? x :
    x > 0 ? 1 + Math.log10(x) / render_args.amp2log :
      -Infinity;
}

async function renderFFT() {
  let t = Date.now();
  initFFT();
  updateFFT();
  updateCanvas();
  log.i('Image updated:', Date.now() - t, 'ms');
}

class SmoothFFT {
  constructor(fft, nshifts) {
    this.fft = fft;
    this.nshifts = nshifts;
    this.tmp1 = new Float32Array(fft.size * 2);
    this.tmp2 = new Float32Array(fft.size * 2);
    this.tmp3 = new Float32Array(fft.size * 2);
  }

  transform(input, output, nshifts = this.nshifts) {
    let fft = this.fft;
    let tmp1 = this.tmp1;
    let tmp2 = this.tmp2;

    assert(input.length == fft.size * 2);
    assert(output.length == input.length * nshifts);

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
      FFT.shift(input, tmp1, -s / nshifts);
      fft.transform(tmp1, tmp2);

      for (let i = 0; i < input.length / 2; i++) {
        let j = i * nshifts + s;
        output[j * 2 + 0] = tmp2[i * 2 + 0];
        output[j * 2 + 1] = tmp2[i * 2 + 1];
      }
    }
  }

  smoothACF(input, output, amp2mask) {
    let nshifts = this.nshifts;
    let tmp2 = this.tmp2;
    assert(input.length * nshifts == output.length);
    assert(input.length == amp2mask.length);
    acf.transform(input, tmp2, amp2mask);
    this.stretch(tmp2, output, nshifts / 2);
  }

  stretch(input, output, k) {
    assert(input.length * k <= output.length);
    let n = input.length / 2;
    for (let i = n - 1; i >= 0; i--) {
      for (let s = k - 1; s >= 0; s--) {
        let j = i * k + s;
        output[j * 2 + 0] = input[i * 2 + 0];
        output[j * 2 + 1] = input[i * 2 + 1];
      }
    }
  }
}

function updateFFT() {
  let n = FFT_SIZE;
  let nshifts = NUM_FREQS / (freqMax - freqMin);
  let time_step = aviewport.len / NUM_FRAMES;
  let input0 = new Float32Array(n);
  let input1 = new Float32Array(n);
  let input2 = new Float32Array(n * 2);
  let output = new Float32Array(n * 2 * nshifts);
  let amp_0_mask = new Float32Array(n * 2);
  let hue_r_mask = new Float32Array(n * 2);
  let hue_g_mask = new Float32Array(n * 2);
  let hue_b_mask = new Float32Array(n * 2);
  let sfft = new SmoothFFT(fft, nshifts);
  let xmin = 0, xmax = NUM_FRAMES - 1;

  if (fftSqrAmpLen != aviewport.len || render_args.showACF) {
    render_args.fft.sqr_amp.fill(0);
    render_args.fft.max_amp.fill(0);
    render_args.fft.phase.fill(0);
  } else {
    let s = (aviewport.min - fftSqrAmpPos) / time_step | 0;
    rotateArray(render_args.fft.sqr_amp, s * NUM_FREQS);
    rotateArray(render_args.fft.phase, s * NUM_FREQS);
    if (s > 0) xmin = s;
    if (s < 0) xmax = -s;
  }

  fftSqrAmpPos = aviewport.min;
  fftSqrAmpLen = aviewport.len;

  if (render_args.showACF) {
    let f_low = FREQ_LOW / SAMPLE_RATE * n;

    for (let f = 1; f < n / 2; f++) {
      let hue = getPitch(f / n * SAMPLE_RATE); // 0..1
      let val = hann_step(f / f_low, 1, 4) ** 2;
      let [r, g, b] = smooth_hsv2rgb(hue, 1.0, val);

      amp_0_mask[2 * f] = val;
      hue_r_mask[2 * f] = r;
      hue_g_mask[2 * f] = g;
      hue_b_mask[2 * f] = b;

      amp_0_mask[2 * (n - f)] = val;
      hue_r_mask[2 * (n - f)] = r;
      hue_g_mask[2 * (n - f)] = g;
      hue_b_mask[2 * (n - f)] = b;
    }
  }

  for (let x = xmin; x <= xmax; x++) {
    let offset = aviewport.min + x * time_step | 0;
    getZeroPaddedSlice(audio32, offset - n / 2, offset + n / 2, input0);

    if (USE_WDF)
      applyWDF(input0, input1);
    else
      input1.set(input0);

    if (USE_WINFN)
      applyHannWindow(input1);

    FFT.expand(input1, input2);

    let amp_frame = getSqrAmpFrame(x);
    let phase_frame = getPhaseFrame(x);

    if (render_args.showACF) {
      sfft.smoothACF(input2, output, amp_0_mask);
    } else {
      sfft.transform(input2, output);
    }

    FFT.sqr_abs(output, amp_frame);
    FFT.phase(output, phase_frame);

    if (render_args.showACF) {
      sfft.smoothACF(input2, output, hue_r_mask);
      FFT.sqr_abs(output, getSqrAmpFrame(x, render_args.fft.hue_r));
      sfft.smoothACF(input2, output, hue_g_mask);
      FFT.sqr_abs(output, getSqrAmpFrame(x, render_args.fft.hue_g));
      sfft.smoothACF(input2, output, hue_b_mask);
      FFT.sqr_abs(output, getSqrAmpFrame(x, render_args.fft.hue_b));
    }

    if (USE_WDF || render_args.showACF) {
      // WDF/ACF is already squared.
      applyFn(amp_frame, Math.sqrt);
    }
  }

  updateAmpMaxArray();
}

function updateAmpMaxArray() {
  let a = render_args.fft.max_amp;
  let s = 0;

  for (let t = 0; t < NUM_FRAMES; t++) {
    let frame_max = getArrayMax(getSqrAmpFrame(t));
    a[t] = s = max(frame_max, s * 0.95);
  }

  render_args.amp2max = getArrayMax(render_args.fft.sqr_amp);
}

function updateCanvas() {
  let cw = NUM_FRAMES;
  let ch = NUM_FREQS;
  let ctx2d = canvasFFT.getContext('2d');
  let image = ctx2d.getImageData(0, 0, cw, ch);

  image.data.fill(0);

  for (let x = 0; x < cw; x++) {
    for (let y = 0; y < ch; y++) {
      let offset = (y * cw + x) * 4;
      image.data[offset + 3] = 255;

      let t = x;
      let f = ch - 1 - y;

      if (render_args.showPolarCoords) {
        let dx = 2 * x / cw - 1;
        let dy = 2 * y / ch - 1;
        let [dr, df] = xy2rf(-dy, dx);
        t = dr * (cw - 1) | 0;
        f = Math.abs(df / Math.PI) * (ch - 1) | 0;
        if (t >= cw || f >= ch) continue;
      }

      let i = t * ch + f;
      let frame = getSqrAmpFrame(t);
      let phase = getPhaseFrame(t);
      let amp2max = render_args.fft.max_amp[t];
      let amp = frame[f] / amp2max;
      let vol = loudness(render_args.fft.sqr_amp[i] / amp2max);
      let sat = render_args.showPhase ? 1 :
        1 - amp;
      let hue = render_args.showPhase ?
        phase[f] / Math.PI * 0.5 + 0.5 :
        getFreqHue(f);
      let [r, g, b] = hsv2rgb(hue, sat, vol);

      if (render_args.showACF) {
        vol = amp;
        sat = render_args.amp2log > 0 ? 1 - vol ** 2 : 1;
        r = mix(1, loudness(render_args.fft.hue_r[i] / amp2max), sat);
        g = mix(1, loudness(render_args.fft.hue_g[i] / amp2max), sat);
        b = mix(1, loudness(render_args.fft.hue_b[i] / amp2max), sat);
      }

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

function getArrayMax(a) {
  let max = 0;
  for (let i = 0; i < a.length; i++)
    max = Math.max(max, a[i]);
  return max;
}

function rotateArray(a, m) {
  assert(Math.abs(m) < a.length);
  if (m > 0) a.set(a.subarray(m), 0);
  if (m < 0) a.set(a.subarray(0, m), -m);
}

function getSqrAmpFrame(x, src = render_args.fft.sqr_amp) {
  let n = NUM_FREQS;
  assert(x >= 0 && x < NUM_FRAMES);
  return src.subarray(x * n, (x + 1) * n);
}

function getPhaseFrame(x) {
  let n = NUM_FREQS;
  assert(x >= 0 && x < NUM_FRAMES);
  return render_args.fft.phase.subarray(x * n, (x + 1) * n);
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
  for (let i = 0; i < n; i++)
    frame[i] *= hann(i / n);
}

function getPitch(freq_hz) {
  let pitch = Math.log2(freq_hz / BASE_FREQ);
  return fract(pitch);
}

function getFreqHue(y) {
  let f_max_hz = SAMPLE_RATE * freqMax / FFT_SIZE;
  let freq_hz = y / NUM_FREQS * f_max_hz;
  return getPitch(freq_hz);
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

function smooth_hsv2rgb(hue, sat = 1, val = 1) {
  let r = 3 * Math.min(hue, 1 - hue);
  let g = 3 * Math.abs(hue - 1 / 3);
  let b = 3 * Math.abs(hue - 2 / 3);
  r = r > 1 ? 0 : 1 - hann(r / 2);
  g = g > 1 ? 0 : 1 - hann(g / 2);
  b = b > 1 ? 0 : 1 - hann(b / 2);
  r = val * mix(1, r, sat) * val;
  g = val * mix(1, g, sat) * val;
  b = val * mix(1, b, sat) * val;
  return [r, g, b];
}

function rgb2hsv(r, g, b) {
  let v = max(r, max(g, b));
  let c = v - min(r, min(g, b));
  let h = c == 0 ? 0 :
    v == r ? (g - b) / c :
      v == g ? (b - r) / c + 2 :
        v == b ? (r - g) / c + 4 : 0;
  h = fract(h / 6 + 1);
  let s = v > 0 ? c / v : 0;
  return [h, s, v];
}

// f = -PI..PI
function xy2rf(x, y) {
  let r = Math.sqrt(x * x + y * y);
  let f = r > 0 ? (y < 0 ? -1 : 1) * Math.acos(x / r) : 0;
  return [r, f];
}

function playCurrentAudioSample() {
  if (playingAudioSource) {
    playingAudioSource.stop();
    playingAudioSource = null;
  }
  let tmpbuf = audioCtx.createBuffer(1, aviewport.len, abuffer.sampleRate);
  abuffer.copyFromChannel(tmpbuf.getChannelData(0), 0, aviewport.min);
  let source = audioCtx.createBufferSource();
  source.buffer = tmpbuf;
  source.connect(audioCtx.destination);
  audioCtxStartTime = audioCtx.currentTime;
  log.i('Playing audio sample', tmpbuf.duration.toFixed(1), 'sec');
  source.start();
  playingAudioSource = source;
  source.onended = () => {
    playingAudioSource = null;
    log.i('Done playing audio sample');
  };
  drawVerticalLine();
}

function drawVerticalLine() {
  cancelAnimationFrame(vTimeBarAnimationId);
  if (!audioCtx) return;
  vTimeBarAnimationId = requestAnimationFrame(drawVerticalLine);
  let at = audioCtx.currentTime - audioCtxStartTime;
  let vd = aviewport.len / abuffer.sampleRate;
  let dt = at / vd;
  vTimeBar.style.left = (100 * dt).toFixed(2) + '%';
  vTimeBar.style.visibility = dt < 0 || dt > 1 || !playingAudioSource ?
    'hidden' : 'visible';
  if (dt > 1) cancelAnimationFrame(vTimeBarAnimationId);
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

async function prepareAudioBuffer(arrayBuffer) {
  log.v('Decoding audio data...');
  initAudioCtx();
  abuffer = await audioCtx.decodeAudioData(arrayBuffer);
  log.i('Audio buffer:',
    abuffer.numberOfChannels, 'ch',
    'x', abuffer.sampleRate, 'Hz',
    abuffer.duration.toFixed(1), 'sec');

  audio32 = abuffer.getChannelData(0);
  aviewport.min = 0;
  aviewport.len = Math.min(audio32.length, 10 * SAMPLE_RATE);
  await renderFFT();
}

function initAudioCtx() {
  if (!audioCtx) {
    audioCtx = new AudioContext({
      sampleRate: SAMPLE_RATE,
    });
  }
}

function defineShortcuts() {
  setShortcut('\uD83D\uDCC2', {
    title: 'Upload audio',
    handler: async () => {
      initAudioCtx();
      let file = await selectAudioFile();
      if (!file) return;
      document.title = file.name;
      log.i('Selected file:', file.type,
        file.size / 2 ** 10 | 0, 'KB', file.name);
      let fileData = await file.arrayBuffer();
      await prepareAudioBuffer(fileData);
    },
  });

  setShortcut('\uD83C\uDFA4', {
    title: 'Record mic audio',
    handler: async () => {
      if (!mediaRecorder) {
        log.i('Calling getUserMedia for mic access');
        micAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: SAMPLE_RATE,
            channelCount: 1,
          },
        });
        if (!micAudioStream) return;
        log.i('Starting MediaRecorder');
        mediaRecorder = new MediaRecorder(micAudioStream);
        micAudioChunks = [];
        mediaRecorder.ondataavailable =
          (e) => void micAudioChunks.push(e.data);
        mediaRecorder.start();
      } else {
        log.i('Stopping MediaRecorder');
        mediaRecorder.onstop = async () => {
          let mime = mediaRecorder.mimeType;
          let size = micAudioChunks.reduce((s, b) => s + b.size, 0);
          micAudioStream.getAudioTracks().map(t => t.stop());
          mediaRecorder = null;
          micAudioStream = null;
          log.i('Prepairing a media blob', mime, 'with',
            micAudioChunks.length, 'chunks', size / 2 ** 10 | 0, 'KB total');
          let blob = new Blob(micAudioChunks, { type: mime })
          let blobData = await blob.arrayBuffer();
          await prepareAudioBuffer(blobData);
        };
        mediaRecorder.stop();
      }
    },
  });

  setShortcut('\u25B6', {
    title: 'Play audio',
    handler: () => {
      playCurrentAudioSample();
    },
  });

  setShortcut('\u2190', {
    title: 'Move backwards',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min -= dx / 2;
      refreshViewport();
    },
  });

  setShortcut('\u2192', {
    title: 'Move forward',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min += dx / 2;
      refreshViewport();
    },
  });

  setShortcut('\u2295', {
    title: 'Zoom in',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min += dx / 2;
      aviewport.len *= 0.5;
      refreshViewport();
    },
  });

  setShortcut('\u2296', {
    title: 'Zoom out',
    handler: () => {
      let dx = aviewport.len / 2;
      aviewport.min -= dx;
      aviewport.len *= 2;
      refreshViewport();
    },
  });

  setShortcut('\u2193', {
    title: 'Reduce max freq',
    handler: () => {
      let df = freqMax - freqMin;
      if (freqMax - df / 2 <= freqMin) return;
      freqMax -= df / 2;
      log.v('New max freq:', freqMax / FFT_SIZE * 2);
      refreshViewport();
    },
  });

  setShortcut('\u2191', {
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

  setShortcut('F+', {
    title: '200% FFT bins',
    handler: () => {
      FFT_SIZE *= 2;
      freqMax *= 2;
      log.i('FFT bins:', FFT_SIZE, 'per frame');
      fft = null;
      renderFFT();
    },
  });

  setShortcut('F-', {
    title: '50% FFT bins',
    handler: () => {
      FFT_SIZE *= 0.5;
      freqMax *= 0.5;
      log.i('FFT bins:', FFT_SIZE, 'per frame');
      fft = null;
      renderFFT();
    },
  });

  setShortcut('\u267A', {
    title: 'Show phase',
    handler: () => {
      render_args.showPhase = !render_args.showPhase;
      updateCanvas();
    },
  });

  setShortcut('\u25D4', {
    title: 'Polar coords',
    handler: () => {
      render_args.showPolarCoords = !render_args.showPolarCoords;
      updateCanvas();
    },
  });

  setShortcut('ACF', {
    title: 'Show ACF',
    handler: () => {
      render_args.showACF = !render_args.showACF;
      renderFFT();
    },
  });

  setShortcut('L+', {
    title: 'Increase loudness range',
    handler: () => {
      render_args.amp2log += 0.5;
      log.i('Loudness log range:', render_args.amp2log);
      updateCanvas();
    },
  });

  setShortcut('L-', {
    title: 'Reduce loudness range',
    handler: () => {
      if (render_args.amp2log > 0.5)
        render_args.amp2log -= 0.5;
      log.i('Loudness log range:', render_args.amp2log);
      updateCanvas();
    },
  });
}

function showUnhandledError(err) {
  $('#error').textContent = err && err.message || err;
}

canvasFFT.onmousemove = e => {
  if (!abuffer) return;
  let x = e.offsetX / canvasFFT.clientWidth;
  let y = e.offsetY / canvasFFT.clientHeight;
  let dt = (x * aviewport.len + aviewport.min) / audio32.length * abuffer.duration;
  let hz = mix(freqMin, freqMax, 1 - y) / FFT_SIZE * SAMPLE_RATE;
  let a2 = render_args.fft.sqr_amp[(x * NUM_FRAMES | 0) * NUM_FREQS + ((1 - y) * NUM_FREQS | 0)];
  eInfo.textContent = dt.toFixed(3) + 's '
    + hz.toFixed(0) + ' Hz '
    + (a2 / render_args.amp2max * 100).toFixed(2) + '%';
};

canvasFFT.onclick = (e) => {
  if (!abuffer) return;

  let x = e.offsetX / canvasFFT.clientWidth;
  let y = e.offsetY / canvasFFT.clientHeight;
  let t = (x * aviewport.len + aviewport.min) | 0;

  if (e.ctrlKey && e.shiftKey) {
    let df = 2 ** Math.ceil(Math.log2(1 - y));
    freqMax = df * (freqMax - freqMin) + freqMin;
    log.i('New freq range:', freqMin, '..', freqMax);
    freqMax = Math.ceil(freqMax);
    renderFFT();
  } else if (e.ctrlKey) {
    aviewport.len -= t - aviewport.min;
    aviewport.min = t;
    renderFFT();
  } else if (e.shiftKey) {
    aviewport.len = t - aviewport.min;
    renderFFT();
  }
};

document.body.onkeypress = async (e) => {
  let key = e.key.toUpperCase();
  let spec = shortcuts[key];
  if (spec) spec.handler();
};

defineShortcuts();
log.setUnhandledErrorHandler(showUnhandledError);
log.i('FFT size:', FFT_SIZE, 'bins');
log.i('Image size:', NUM_FRAMES, 'x', NUM_FREQS);
log.i('Hann window function?', USE_WINFN);
log.i('GPU?', USE_GPU);
