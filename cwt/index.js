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
import { GpuFFT } from '../audio/fft.js';
import { GpuContext } from '../webgl/gpu-context.js';
import { GpuFrameBuffer } from '../webgl/framebuffer.js';
import { GpuTransformProgram } from '../webgl/transform.js';
import { shaderUtils, complexMath } from '../glsl/basics.js';

const DEFAULT_CONFIG = `
  // SAMPLE_RATE = 48000
  // FREQ_MIN = 40
  // FREQ_MAX = 12000
  // TIME_MIN = 0
  // TIME_MAX = 1.5
  // AMP_MIN = -5
  // AMP_MAX = 5
  // FB_W = 256
  // FB_H = 256
  // IMG_W = 1024
  // IMG_H = 1024

  vec2 wavelet(float ts, float freq_hz) {
    float width = 25.0 / freq_hz + 0.025;
    float amp = 1.0 - hann_step(abs(float(ts)), 0.0, width * 0.5);
    float phase = ts * freq_hz * PI * 2.0;
    float re = cos(phase);
    float im = sin(phase);
    return amp / width * vec2(re, im);
  }
`;

let conf = parseConfig(location.search ||
  '?conf=' + encodeURIComponent(DEFAULT_CONFIG));

const SAMPLE_RATE = conf.get('SAMPLE_RATE');
const FREQ_MIN = conf.get('FREQ_MIN');
const FREQ_MAX = conf.get('FREQ_MAX');
const TIME_MIN = conf.get('TIME_MIN'); // sec
const TIME_MAX = conf.get('TIME_MAX');
const AMP_MIN = conf.get('AMP_MIN');
const AMP_MAX = conf.get('AMP_MAX');
const FB_W = conf.get('FB_W');
const FB_H = conf.get('FB_H');
const IMG_W = conf.get('IMG_W');
const IMG_H = conf.get('IMG_H');
const MAX_WAVEFORM_LEN = FB_W * FB_H; // FFT wraps around
const WAVELET_SHADER = conf.get();

const $ = s => document.querySelector(s);
const sleep = dt => new Promise(resolve => setTimeout(resolve, dt));
const mix = (min, max, x) => min * (1 - x) + max * x;

let audio_ctx, webgl, fft, sh_wavelet, sh_dot_product, sh_sample, sh_draw;
let fb_audio, fb_audio_fft, fb_wavelet, fb_wavelet_fft, fb_conv, fb_conv_fft, fb_image1, fb_image2;
let running = false;
let canvas = $('canvas');
let btn_config = $('button#config');
let btn_render = $('button#render');
let btn_update = $('button#update');
let textarea = $('textarea');

btn_render.onclick = () => renderSpectrogram();
btn_config.onclick = () => showConfig();
btn_update.onclick = () => updateConfig();
textarea.value = WAVELET_SHADER;

function assert(x) {
  if (x) return;
  debugger;
  throw new Error('assert() failed');
}

function showConfig() {
  btn_render.remove();
  btn_config.remove();
  btn_update.style.display = '';
  canvas.style.display = 'none';
  textarea.style.display = '';
  btn_update.style.display = '';
}

function updateConfig() {
  location.search = '?conf=' + encodeURIComponent(textarea.value);
}

async function initGPU() {
  if (audio_ctx) return;
  audio_ctx = new AudioContext({ sampleRate: SAMPLE_RATE });

  canvas.width = IMG_W;
  canvas.height = IMG_H;
  webgl = new GpuContext(canvas);
  await webgl.init();

  fft = new GpuFFT(webgl, { width: FB_W, height: FB_H });

  fb_audio = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 1 });
  fb_audio_fft = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  fb_wavelet = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  fb_wavelet_fft = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  fb_conv = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  fb_conv_fft = new GpuFrameBuffer(webgl, { width: FB_W, height: FB_H, channels: 2 });
  fb_image1 = new GpuFrameBuffer(webgl, { width: IMG_W, height: IMG_H, channels: 2 });
  fb_image2 = new GpuFrameBuffer(webgl, { width: IMG_W, height: IMG_H, channels: 2 });

  sh_wavelet = new GpuTransformProgram(webgl, {
    fshader: `
      in vec2 vTex;

      const int W = ${FB_W};
      const int H = ${FB_H};
      const float WH = float(W * H);
      const float SR = float(${SAMPLE_RATE});
      const float PI = ${Math.PI};

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

        v_FragColor = vec4(imul(u, v), 0.0, 0.0);
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

      const float A_MIN = float(${AMP_MIN});
      const float A_MAX = float(${AMP_MAX});

      const vec3 RGB_0 = vec3(0.0, 0.0, 0.0); // 0.00 = black
      const vec3 RGB_1 = vec3(0.1, 0.0, 0.1); // 0.25 = purple
      const vec3 RGB_2 = vec3(0.3, 0.0, 0.0); // 0.50 = red
      const vec3 RGB_3 = vec3(0.8, 0.6, 0.0); // 0.75 = yellow
      const vec3 RGB_4 = vec3(1.0, 1.0, 1.0); // 1.00 = white

      float log10_scaled(float x) {
        float a = log(abs(x)) / log(10.0);
        return (a - A_MIN) / (A_MAX - A_MIN);
      }

      vec3 flame_color(float a) {
        float x = a * 4.0;
        if (x < 1.0) return mix(RGB_0, RGB_1, x - 0.0);
        if (x < 2.0) return mix(RGB_1, RGB_2, x - 1.0);
        if (x < 3.0) return mix(RGB_2, RGB_3, x - 2.0);
        if (x < 4.0) return mix(RGB_3, RGB_4, x - 3.0);
        return vec3(1.0);
      }

      void main() {
        vec2 uv = texture(uImage, vTex).xy;
        vec3 rgb = flame_color(log10_scaled(dot(uv, uv)));
        v_FragColor = vec4(rgb, 1.0);
      }
    `
  });
}

async function renderSpectrogram() {
  assert(!running);
  running = true;
  await initGPU();

  let file = await openAudioFile();
  let buffer = await file.arrayBuffer();
  let waveform = await decodeAudioData(buffer);

  let ts_min = TIME_MIN * SAMPLE_RATE | 0;
  let ts_max = Math.min(ts_min + MAX_WAVEFORM_LEN, TIME_MAX * SAMPLE_RATE | 0);
  waveform = waveform.slice(ts_min, ts_max);
  log.i('Uploading audio data to GPU:', waveform.length, 'samples');
  fb_audio.clear();
  fb_audio.upload(waveform);

  log.i('Computing FFT of the audio signal');
  fft.exec({ uInput: fb_audio }, fb_audio_fft);

  log.i('Computing wavelet transform');
  let time = Date.now();
  fb_image1.clear();
  fb_image2.clear();

  for (let y = 0; y < IMG_H; y++) {
    let freq_hz = mix(FREQ_MIN, FREQ_MAX, y / (IMG_H - 1));

    sh_wavelet.exec({ uFreqHz: freq_hz }, fb_wavelet);
    fft.exec({ uInput: fb_wavelet }, fb_wavelet_fft);
    sh_dot_product.exec({ uInput1: fb_audio_fft, uInput2: fb_wavelet_fft }, fb_conv_fft);
    fft.exec({ uInput: fb_conv_fft, uInverseFFT: true }, fb_conv);
    sh_sample.exec({ uSignal: fb_conv, uImage: fb_image1, uOffsetY: y, uTimeMin: 0, uTimeMax: (ts_max - ts_min) / (FB_W * FB_H) }, fb_image2);
    [fb_image1, fb_image2] = [fb_image2, fb_image1];

    if (time + 250 < Date.now()) {
      sh_draw.exec({ uImage: fb_image1 }, null);
      log.i((y / IMG_H * 100 | 0) + '% ' + freq_hz.toFixed(0) + ' Hz');
      await sleep(0);
      time = Date.now();
    }
  }

  sh_draw.exec({ uImage: fb_image1 }, null);
  running = false;
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
  let abuffer = await audio_ctx.decodeAudioData(arrayBuffer);
  log.i('Audio buffer:',
    abuffer.numberOfChannels, 'ch',
    'x', abuffer.sampleRate, 'Hz',
    abuffer.duration.toFixed(1), 'sec');
  return abuffer.getChannelData(0);
}

function parseConfig(query) {
  let args = new URLSearchParams(query);
  let conf = args.get('conf');
  return {
    get(name) {
      if (!name)
        return conf;
      let regex = new RegExp('^\\s*//\\s*' + name + '\\s*=\\s*(\\S+)\\s*$', 'gm');
      let match = regex.exec(conf);
      if (!match)
        throw new Error('Missing config param: ' + name);
      let num = parseFloat(match[1]);
      if (!Number.isFinite(num))
        throw new Error('Invalid param value: ' + name + ' = ' + match[1]);
      return num;
    }
  };
}
