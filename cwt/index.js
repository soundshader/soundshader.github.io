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

const SAMPLE_RATE = 48000;
const FREQ_MIN = 20; // can't be zero
const FREQ_MAX = 10000;
const MAX_FB_SIZE = 256;
const MAX_WAVEFORM_LEN = MAX_FB_SIZE ** 2;
const WAVELET_SIZE = 80; // wavelengths
const DOC_TITLE = document.title;

const $ = s => document.querySelector(s);
const sleep = dt => new Promise(resolve => setTimeout(resolve, dt));
const hann = x => x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 2 : 0;
const mix = (min, max, x) => min * (1 - x) + max * x;
const log2 = x => Math.log2(x);

let audio_ctx, webgl, fft, sh_wavelet, sh_dot_product, sh_sampler, sh_draw;
let running = false;
let canvas = $('canvas');
canvas.width = 2048;
canvas.height = 1024;
canvas.onclick = () => updateImage();

function assert(x) {
  if (x) return;
  debugger;
  throw new Error('assert() failed');
}

async function init() {
  if (audio_ctx) return;
  audio_ctx = new AudioContext({ sampleRate: SAMPLE_RATE });

  webgl = new GpuContext(canvas);
  await webgl.init();

  fft = new GpuFFT(webgl, { width: MAX_FB_SIZE, height: MAX_FB_SIZE });

  sh_wavelet = new GpuTransformProgram(webgl, {
    fshader: `
      in vec2 vTex;

      uniform float uWindowWidth;
      uniform float uWavePeriod;
      uniform int uTexSize;

      ${shaderUtils}

      const float PI = ${Math.PI};
  
      void main() {
        int uTexSize2 = uTexSize * uTexSize;
        ivec2 vTexN = ivec2(vTex * float(uTexSize) - 0.5);
        int x = vTexN.x + uTexSize * vTexN.y;
        if (x > uTexSize2/2) x -= uTexSize2;

        float amp = 1.0 - hann_step(abs(float(x)), 0.0, uWindowWidth * 0.5);
        float t = float(x) / float(uWavePeriod) * PI * 2.0;
        float re = cos(t);
        float im = sin(t);
        v_FragColor = amp * vec4(re, im, 0.0, 0.0);
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

        float dx = 0.5 * min(vTex.x, 1.0 - vTex.x);
        float g = exp(-dx*dx);
        vec2 u = texture(uInput1, vTex).xy;
        vec2 v = texture(uInput2, vTex).xy;
        v_FragColor = g * vec4(imul(u, v), 0.0, 0.0);
      }
    `
  });

  sh_sampler = new GpuTransformProgram(webgl, {
    fshader: `
      in vec2 vTex;

      uniform sampler2D uSignal;
      uniform sampler2D uImage;
      uniform int uOffsetY;

      void main() {
        ivec2 img_size = textureSize(uImage, 0);
        ivec2 sig_size = textureSize(uSignal, 0);
        ivec2 vTexN = ivec2(vTex * vec2(img_size) - 0.5);

        int sw = sig_size.x;
        int sh = sig_size.y;
        int i = int(vTex.x * float(sw * sh));
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

      const vec3 RGB_0 = vec3(0.0);
      const vec3 RGB_1 = vec3(0.8, 0.2, 0.0);
      const vec3 RGB_2 = vec3(1.0, 0.8, 0.0);

      vec3 log10_rgb(float r) {
        float a = clamp(log(r)/log(10.0)/3.5 + 1.0, 0.0, 1.0);
        return a < 0.5 ? mix(RGB_0, RGB_1, a * 2.0) :
          mix(RGB_1, RGB_2, 2.0 * a - 1.0);
      }

      void main() {
        vec2 uv = texture(uImage, vTex).xy;
        vec3 u = log10_rgb(abs(uv.x));
        vec3 v = log10_rgb(abs(uv.y));
        v_FragColor = vec4(u, 1.0);
      }
    `
  });
}

async function updateImage() {
  assert(!running);
  running = true;
  await init();

  let w = canvas.width;
  let h = canvas.height;
  let file = await selectAudioFile();
  let buffer = await file.arrayBuffer();
  let waveform = await decodeAudioData(buffer);

  waveform = waveform.slice(0, MAX_WAVEFORM_LEN);

  let fb_audio = new GpuFrameBuffer(webgl, { width: MAX_FB_SIZE, height: MAX_FB_SIZE, channels: 1 });
  let fb_audio_fft = new GpuFrameBuffer(webgl, { width: MAX_FB_SIZE, height: MAX_FB_SIZE, channels: 2 });
  let fb_wavelet = new GpuFrameBuffer(webgl, { width: MAX_FB_SIZE, height: MAX_FB_SIZE, channels: 2 });
  let fb_wavelet_fft = new GpuFrameBuffer(webgl, { width: MAX_FB_SIZE, height: MAX_FB_SIZE, channels: 2 });
  let fb_conv = new GpuFrameBuffer(webgl, { width: MAX_FB_SIZE, height: MAX_FB_SIZE, channels: 2 });
  let fb_conv_fft = new GpuFrameBuffer(webgl, { width: MAX_FB_SIZE, height: MAX_FB_SIZE, channels: 2 });
  let fb_image1 = new GpuFrameBuffer(webgl, { width: w, height: h, channels: 2 });
  let fb_image2 = new GpuFrameBuffer(webgl, { width: w, height: h, channels: 2 });

  log.i('Uploading audio data to GPU:', waveform.length, 'samples');
  fb_audio.upload(waveform);

  log.i('Computing FFT of the audio signal');
  fft.exec({ uInput: fb_audio }, fb_audio_fft);

  let time = Date.now();

  for (let y = 0; y < h; y++) {
    let freq_hz = mix(FREQ_MIN, FREQ_MAX, y / (h - 1));
    let wave_len = SAMPLE_RATE / freq_hz;

    sh_wavelet.exec({
      uTexSize: MAX_FB_SIZE,
      uWindowWidth: wave_len * WAVELET_SIZE,
      uWavePeriod: wave_len,
    }, fb_wavelet);

    fft.exec({ uInput: fb_wavelet }, fb_wavelet_fft);
    sh_dot_product.exec({ uInput1: fb_audio_fft, uInput2: fb_wavelet_fft }, fb_conv_fft);
    fft.exec({ uInput: fb_conv_fft, uInverseFFT: true }, fb_conv);
    sh_sampler.exec({ uSignal: fb_conv, uImage: fb_image1, uOffsetY: y }, fb_image2);
    [fb_image1, fb_image2] = [fb_image2, fb_image1];

    if (time + 500 < Date.now()) {
      time = Date.now();
      sh_draw.exec({ uImage: fb_image1 }, null);
      document.title = (y / h * 100 | 0) + '% ' + freq_hz.toFixed(0) + ' Hz';
      await sleep(0);
    }
  }

  sh_draw.exec({ uImage: fb_image1 }, null);

  fb_audio.destroy();
  fb_audio_fft.destroy();
  fb_wavelet.destroy();
  fb_wavelet_fft.destroy();
  fb_conv.destroy();
  fb_conv_fft.destroy();
  fb_image1.destroy();
  fb_image2.destroy();

  document.title = DOC_TITLE;
  running = false;
}

async function selectAudioFile() {
  log.v('Creating an <input> to pick a file');
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/mpeg; audio/wav; audio/webm';
  input.click();

  let file = await new Promise((resolve, reject) => {
    input.onchange = () => {
      let files = input.files || [];
      resolve(files[0] || null);
    };
  });

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
