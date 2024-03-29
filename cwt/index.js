// This is a FFT-based CWT that convolves the audio signal
// with a wavelet for each frequency separately, producing
// the wavelet spectrogram row-by-row. The wavelets are
// cosine functions bounded by the Hann window function so
// that precisely 50 periods of the cisone function fit.
//
// It's a somewhat slow H*T*log(T) algorithm, where H is
// the canvas height (1024) and T is the length of audio
// signal (65536, 1.6 sec of audio at 41 kHz).

import * as log from '../log.js';
import { GpuFFT } from '../webfft.js';
import { GpuContext, GpuTransformProgram, GpuFrameBuffer } from '../webgl2.js';
import { shaderUtils, complexMath } from '../glsl/basics.js';

const DEFAULT_CONFIG = `
  const int SAMPLE_RATE = 48000;
  const int FREQ_MIN = 40;
  const int FREQ_MAX = 12000;
  const float TIME_MIN = 0.0;
  const float TIME_MAX = 1.5;
  const float AMP_MIN = -4.0;
  const float AMP_MAX = 1.0;
  const int FB_W = 256;
  const int FB_H = 256;
  const int IMG_W = 1024;
  const int IMG_H = 1024;
  const int FREQ_MARKERS = 10;
  const int TIME_MARKERS = 10;

  // ts = -0.5..0.5
  vec2 wavelet(float ts, float freq_hz) {
    float width = 25.0 / freq_hz + 0.025;
    // float amp = 1.0 - hann_step(abs(ts), 0.0, width * 0.5);
    float amp = rcosf2(ts, width*0.1, -width*0.5, width*0.5);
    float phase = ts * freq_hz * PI * 2.0;
    float re = cos(phase);
    float im = sin(phase);
    return amp / width * vec2(re, im);
  }

  float brightness(vec2 re_im) {
    float x = dot(re_im, re_im);
    float a = log(abs(x)) / log(10.0);
    float b = (a - AMP_MIN) / (AMP_MAX - AMP_MIN);
    return b;
  }

  vec2 coords(vec2 vTex) {
    return vTex; // comment out to use polar coords

    vec2 v = vTex * 2.0 - 1.0;
    float r = length(v);
    float t = 1.0 - r;
    float arg = atan2(v.y, v.x);
    return vec2(-0.25 + 0.5 * arg / PI, 1.0 - abs(r / 0.75 - 1.0));
  }
`;

const CFG = parseConfig(localStorage.cwt_config || DEFAULT_CONFIG);
const SAMPLE_RATE = CFG.get('SAMPLE_RATE');
const FREQ_MIN = CFG.get('FREQ_MIN');
const FREQ_MAX = CFG.get('FREQ_MAX');
const TIME_MIN = CFG.get('TIME_MIN'); // sec
const TIME_MAX = CFG.get('TIME_MAX');
const FB_W = CFG.get('FB_W', 1, 4096);
const FB_H = CFG.get('FB_H', 1, 4096);
const IMG_W = CFG.get('IMG_W', 1, 4096);
const IMG_H = CFG.get('IMG_H', 1, 4096);
const FREQ_MARKERS = CFG.get('FREQ_MARKERS', 0, 100);
const TIME_MARKERS = CFG.get('TIME_MARKERS', 0, 100);
const MAX_WAVEFORM_LEN = FB_W * FB_H;
const WAVELET_SHADER = CFG.get();

const $ = s => document.querySelector(s);
const sleep = dt => new Promise(resolve => setTimeout(resolve, dt));
const mix = (min, max, x) => min * (1 - x) + max * x;

let audio_ctx, webgl, fft, sh_wavelet, sh_dot_product, sh_sample, sh_draw;
let rendering = false;
let canvas = $('canvas');
let btn_config = $('button#config');
let btn_render = $('button#render');
let btn_abort = $('button#abort');
let btn_update = $('button#update');
let textarea = $('textarea');

window.onload = () => renderCachedSpectrogram();
btn_render.onclick = () => renderSpectrogram();
btn_abort.onclick = () => abortRendering();
btn_config.onclick = () => showConfig();
btn_update.onclick = () => updateConfig();

textarea.value = WAVELET_SHADER;
btn_abort.style.display = 'none';

function assert(x) {
  if (x) return;
  debugger;
  throw new Error('assert() failed');
}

function showConfig() {
  btn_render.remove();
  btn_config.remove();
  btn_abort.remove();
  btn_update.style.display = '';
  canvas.style.display = 'none';
  textarea.style.display = '';
  btn_update.style.display = '';
}

function updateConfig() {
  localStorage.cwt_config = textarea.value;
  location.reload();
}

function abortRendering() {
  rendering = false;
  btn_abort.style.display = 'none';
  btn_render.style.display = '';
  btn_config.style.display = '';
}

async function initWebGL() {
  addFreqMarkers();
  addTimeMarkers();

  canvas.width = IMG_W;
  canvas.height = IMG_H;
  webgl = new GpuContext(canvas);
  await webgl.init();

  fft = new GpuFFT(webgl, { width: FB_W, height: FB_H });

  sh_wavelet = new GpuTransformProgram(webgl, {
    fshader: `
      in vec2 vTex;

      const int W = ${FB_W};
      const int H = ${FB_H};
      const float WH = float(W * H);
      const float SR = float(${SAMPLE_RATE});

      uniform float uFreqHz;

      ${shaderUtils}

      ${WAVELET_SHADER}
  
      void main() {
        ivec2 vTexN = ivec2(vTex * vec2(ivec2(W, H)) - 0.5);
        float ts = float(vTexN.x + W * vTexN.y) / WH;
        if (ts > 0.5) ts -= 1.0;
        vec2 re_im = wavelet(ts * WH / SR, uFreqHz);
        v_FragColor = vec4(re_im, 0.0, 0.0);
      }
    `
  });

  sh_dot_product = new GpuTransformProgram(webgl, {
    fshader: `
      in vec2 vTex;

      uniform sampler2D uInput1;
      uniform sampler2D uInput2;

      ${complexMath}

      void main() {
        // The effect of multiplying by gaussian g is
        // the same as averaging spectrogram values.
        float dx = 0.1 * min(vTex.x, 1.0 - vTex.x);
        float g = exp(-dx*dx);

        vec2 u = texture(uInput1, vTex).xy;
        vec2 v = texture(uInput2, vTex).xy;

        v_FragColor = vec4(imul(u, v*vec2(1.0, -1.0)), 0.0, 0.0);
      }
    `
  });

  sh_sample = new GpuTransformProgram(webgl, {
    fshader: `
      in vec2 vTex;

      uniform sampler2D uSignal;
      uniform sampler2D uImage;
      uniform float uTimeMin;
      uniform float uTimeMax;
      uniform int uOffsetY;

      void main() {
        ivec2 img_size = textureSize(uImage, 0);
        ivec2 sig_size = textureSize(uSignal, 0);
        ivec2 vTexN = ivec2(vTex * vec2(img_size) - 0.5);

        int sw = sig_size.x;
        int sh = sig_size.y;
        float t = mix(uTimeMin, uTimeMax, vTex.x);
        int i = int(t * float(sw * sh));
        ivec2 sxy = ivec2(i % sw, i / sw);
        vec4 sig = texelFetch(uSignal, sxy, 0);
        vec4 img = texture(uImage, vTex);
        v_FragColor = vTexN.y == uOffsetY ? sig : img;
      }
    `
  });

  sh_draw = new GpuTransformProgram(webgl, {
    fshader: `
      in vec2 vTex;
      uniform sampler2D uImage;

      const vec3 RGB_0 = vec3(0.0, 0.0, 0.0); // 0.00 = black
      const vec3 RGB_1 = vec3(0.1, 0.0, 0.1); // 0.25 = purple
      const vec3 RGB_2 = vec3(0.3, 0.0, 0.0); // 0.50 = red
      const vec3 RGB_3 = vec3(1.2, 0.6, 0.0); // 0.75 = yellow
      const vec3 RGB_4 = vec3(1.5, 1.5, 1.5); // 1.00 = white

      ${shaderUtils}

      ${WAVELET_SHADER}

      vec3 flame_color(float a) {
        float x = a * 4.0;
        if (x < 1.0) return mix(RGB_0, RGB_1, x - 0.0);
        if (x < 2.0) return mix(RGB_1, RGB_2, x - 1.0);
        if (x < 3.0) return mix(RGB_2, RGB_3, x - 2.0);
        if (x < 4.0) return mix(RGB_3, RGB_4, x - 3.0);
        return vec3(1.0);
      }

      void main() {
        vec2 pos = coords(vTex);
        vec2 w = texture(uImage, pos).xy;
        float a = brightness(w);
        v_FragColor = vec4(flame_color(a), 1.0);
      }
    `
  });
}

async function renderCachedSpectrogram() {
  let waveform = loadWaveform();
  return waveform && renderSpectrogram(waveform);
}

async function renderSpectrogram(waveform = null) {
  assert(!rendering);
  rendering = true;
  btn_render.style.display = 'none';
  btn_config.style.display = 'none';
  btn_abort.style.display = '';

  if (!waveform) {
    let file = await openAudioFile();
    let buffer = await file.arrayBuffer();
    waveform = await decodeAudioData(buffer);
  }

  await initWebGL();

  let fb_audio = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 1 });
  let fb_audio_fft = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  let fb_wavelet = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  let fb_conv = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  let fb_image1 = new GpuFrameBuffer(webgl, { width: IMG_W, height: IMG_H, channels: 2 });
  let fb_image2 = new GpuFrameBuffer(webgl, { width: IMG_W, height: IMG_H, channels: 2 });

  let ts_min = TIME_MIN * SAMPLE_RATE | 0;
  let ts_max = Math.min(ts_min + MAX_WAVEFORM_LEN, TIME_MAX * SAMPLE_RATE | 0);
  waveform = waveform.slice(ts_min, ts_max);
  log.i('Uploading audio data to GPU:', waveform.length, 'samples',
    (waveform.length / SAMPLE_RATE).toFixed(2), 'sec');

  setTimeout(() => saveWaveform(waveform), 0);

  fb_audio.clear();
  fb_audio.upload(waveform);

  log.i('Computing FFT of the audio signal');
  fft.exec({ uInput: fb_audio }, fb_audio_fft);

  log.i('Computing wavelet transform');
  let time = Date.now();
  fb_image1.clear();
  fb_image2.clear();

  for (let y = 0; y < IMG_H && rendering; y++) {
    let freq_hz = mix(FREQ_MIN, FREQ_MAX, y / (IMG_H - 1));

    sh_wavelet.exec({ uFreqHz: freq_hz }, fb_wavelet);
    fft.exec({ uInput: fb_wavelet }, fb_wavelet);
    sh_dot_product.exec({ uInput1: fb_audio_fft, uInput2: fb_wavelet }, fb_conv);
    fft.exec({ uInput: fb_conv, uInverseFFT: true }, fb_conv);
    sh_sample.exec({ uSignal: fb_conv, uImage: fb_image1, uOffsetY: y, uTimeMin: 0, uTimeMax: (ts_max - ts_min) / (FB_W * FB_H) }, fb_image2);
    [fb_image1, fb_image2] = [fb_image2, fb_image1];

    if (time + 250 < Date.now()) {
      sh_draw.exec({ uImage: fb_image1 }, null);
      log.i((y / IMG_H * 100 | 0) + '% ' + freq_hz.toFixed(0) + ' Hz');
      await sleep(50);
      time = Date.now();
    }
  }

  sh_draw.exec({ uImage: fb_image1 }, null);

  fb_audio.destroy();
  fb_audio_fft.destroy();
  fb_wavelet.destroy();
  fb_conv.destroy();
  fb_image1.destroy();
  fb_image2.destroy();

  rendering = false;
  btn_render.style.display = '';
  btn_config.style.display = '';
  btn_abort.style.display = 'none';
}

function addFreqMarkers(count = FREQ_MARKERS) {
  for (let i = 1; i < count; i++) {
    let freq_hz = mix(FREQ_MIN, FREQ_MAX, i / count);
    let el = document.createElement('div');
    el.className = 'mark-v';
    el.style.top = ((1 - i / count) * 100).toFixed(1) + '%';
    el.style.left = '0';
    el.textContent = freq_hz.toFixed(0) + 'Hz';
    document.body.appendChild(el);
  }
}

function addTimeMarkers(count = TIME_MARKERS) {
  let ts_min = TIME_MIN;
  let ts_max = Math.min(TIME_MAX, ts_min + MAX_WAVEFORM_LEN / SAMPLE_RATE);

  for (let i = 1; i < count; i++) {
    let time_sec = mix(ts_min, ts_max, i / count);
    let el = document.createElement('div');
    el.className = 'mark-h';
    el.style.left = ((i / count) * 100).toFixed(1) + '%';
    el.style.bottom = '0';
    el.textContent = time_sec.toFixed(2) + 's';
    document.body.appendChild(el);
  }
}

async function openAudioFile() {
  log.v('Creating an <input> to pick a file');
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/mpeg; audio/wav; audio/webm';
  input.click();

  let file = await new Promise((resolve, reject) => {
    input.onchange = () => {
      let files = input.files || [];
      let file = files[0];
      file ? resolve(file) : reject('No file selected');
    };
  });

  log.i('Selected file:', file.name);
  return file;
}

async function decodeAudioData(arrayBuffer) {
  log.v('Decoding audio data...');
  audio_ctx = audio_ctx || new AudioContext({ sampleRate: SAMPLE_RATE });
  let abuffer = await audio_ctx.decodeAudioData(arrayBuffer);
  log.i('Audio buffer:',
    abuffer.numberOfChannels, 'ch',
    'x', abuffer.sampleRate, 'Hz',
    abuffer.duration.toFixed(1), 'sec');
  return abuffer.getChannelData(0);
}

function parseConfig(conf) {
  return {
    get(name, min, max) {
      if (!name)
        return conf;
      let regex = new RegExp('^\\s*const (int|float) ' + name + ' = (\\S+);\\s*$', 'gm');
      let [, type, str_val] = regex.exec(conf) || [];
      if (!type)
        throw new Error('Missing config param: ' + name);
      let num = parseFloat(str_val);
      if (!Number.isFinite(num))
        throw new Error('Invalid param value: ' + name + ' = ' + str_val);
      if (num < min || num > max)
        throw new Error('Value out of range: ' + name + ' = ' + str_val + '; ' + min + '..' + max);
      return num;
    }
  };
}

function saveWaveform(waveform) {
  try {
    let ts = Date.now();
    localStorage.audio = [...waveform]
      .map(f => f * 2 ** 15 | 0)
      .join(',')
      .replace(/(0,){3,}/g, s => '0x' + s.length / 2 + ',');
    log.i('Saved audio to local storage in', Date.now() - ts, 'ms;',
      waveform.length, 'samples;', localStorage.audio.length, 'bytes');
  } catch (err) {
    log.i('Failed to save audio:', err.message);
  }
}

function loadWaveform() {
  if (localStorage.audio) {
    let ts = Date.now();
    let waveform = new Float32Array(
      localStorage.audio
        .replace(/(\d+)x(\d+),/g, (_, x, n) => (x + ',').repeat(+n))
        .split(',')
        .map(s => parseInt(s))
        .map(i => i / 2 ** 15));
    log.i('Loaded audio from local storage in', Date.now() - ts, 'ms;',
      waveform.length, 'samples');
    return waveform;
  }
}
