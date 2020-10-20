import * as vargs from '../vargs.js';
import { FFT } from "./fft.js";
import { GpuContext } from '../webgl/gpu-context.js';

// Fast wavelet transform.
export class CWT {
  constructor(size, { context, canvas, stats }) {
    console.log('Fast Wavelet Transform');
    this.audioCtx = context;
    this.canvas = canvas;
    this.stats = stats;

    window.cwt = this;
  }

  async init(audioFile) {
    console.log('Reading audio file:', (audioFile.size / 1e6).toFixed(1), 'MB');
    let audioBytes = await audioFile.arrayBuffer();
    console.log('Decoding audio data...');
    this.audioBuffer = await this.audioCtx.decodeAudioData(audioBytes);
    this.audioSamples = this.audioBuffer.getChannelData(0);
    this.info(this.audioBuffer);

    this.m_periods = vargs.CWT_N;

    this.t_min = 0;
    this.t_max = 2 ** vargs.CWT_LEN | 0;

    this.f_min = 110.0;
    this.f_max = this.audioCtx.sampleRate / 2; // 22.5 kHz

    this.rendering = false;
    this.aborted = false;
    this.rerender = false;

    this.initKeyboardHandlers();
    this.initMouseHandlers();

    this.context2d = this.canvas.getContext('2d');
    this.image = this.context2d.getImageData(0, 0,
      this.canvas.width, this.canvas.height);
    this.pixels = new Float32Array(this.canvas.width);
  }

  info(b) {
    console.log('Decoded audio:',
      b.length.toExponential(1), 'samples',
      'x', b.numberOfChannels, 'channels',
      '@', (b.sampleRate / 1e3).toFixed(1), 'kHz',
      b.duration.toFixed(1), 'sec');
  }

  async render() {
    if (this.rendering) {
      this.aborted = true;
      this.rerender = true;
      return;
    }

    let t2s = t => (t / this.audioCtx.sampleRate).toFixed(1) + 's';
    let f2s = f => (f / 1e3).toFixed(1) + 'kHz'

    let info = [
      t2s(this.t_min) + '..' + t2s(this.t_max),
      f2s(this.f_min) + '..' + f2s(this.f_max),
    ].join(', ');

    console.log('Rendering a frame:', info);
    this.stats.textContent = info;
    this.rerender = false;
    this.initAudioFrame();
    this.image.data.fill(0);
    await this.drawArea();

    if (this.rerender)
      await this.render();
  }

  initMouseHandlers() {
    let canvas = this.canvas;
    let selecting = false;
    let area = document.createElement('div');
    area.className = 'selected-area';

    let x1, x2, y1, y2;

    canvas.addEventListener('mousedown', e => {
      if (selecting)
        document.body.removeChild(area);
      selecting = true;
      x1 = e.offsetX;
      y1 = e.offsetY;
      document.body.appendChild(area);
    });

    canvas.addEventListener('mouseup', e => {
      selecting = false;
      document.body.removeChild(area);
      x2 = e.offsetX;
      y2 = e.offsetY;

      let cx = canvas.clientWidth;
      let cy = canvas.clientHeight;

      this.renderSelectedArea(
        x1 / cx, x2 / cx,
        y1 / cy, y2 / cy);
    });

    canvas.addEventListener('mousemove', e => {
      if (!selecting) return;

      x2 = e.offsetX;
      y2 = e.offsetY;

      let bcr = canvas.getBoundingClientRect();

      area.style.left = bcr.left + Math.min(x1, x2) + 'px';
      area.style.top = bcr.top + Math.min(y1, y2) + 'px';
      area.style.width = Math.abs(x2 - x1) + 'px';
      area.style.height = Math.abs(y2 - y1) + 'px';
    });
  }

  initKeyboardHandlers() {
    document.addEventListener('keydown', e => {
      let size = this.t_max - this.t_min;

      switch (e.key) {
        case 'ArrowRight':
          this.t_min += size;
          this.t_max += size;
          this.render();
          break;
        case 'ArrowLeft':
          this.t_min -= size;
          this.t_max -= size;
          this.render();
          break;
        case 'ArrowUp':
          this.m_periods *= 1.1;
          console.log('m = ' + this.m_periods);
          this.render();
          break;
        case 'ArrowDown':
          this.m_periods /= 1.1;
          console.log('m = ' + this.m_periods);
          this.render();
          break;
        default:
          console.log('Unhandled key:', e.key);
      }
    });
  }

  async renderSelectedArea(x1, x2, y1, y2) {
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];

    let dx = x2 - x1;
    let dy = y2 - y1;

    if (dx < 0.01 || dy < 0.01) {
      console.log('The selected area is too small');
      return;
    }

    [this.t_min, this.t_max] = [
      mix(this.t_min, this.t_max, x1),
      mix(this.t_min, this.t_max, x2),
    ];

    [this.f_min, this.f_max] = [
      log2mix(this.f_min, this.f_max, 1 - y2),
      log2mix(this.f_min, this.f_max, 1 - y1),
    ];

    await this.render();
  }

  async drawArea(ymin = 0, ymax = this.canvas.height - 1) {
    let image = this.image;
    let time = Date.now();
    this.aborted = false;
    this.rendering = true;

    let n = ymax - ymin + 1;
    let y = 0;

    for (let i = 0; i < n && !this.aborted; i++) {
      this.drawLine(y + ymin);
      y = (22695477 * y + 1) % n; // LCG to pick y randomly

      if (Date.now() > time + 500) {
        this.context2d.putImageData(image, 0, 0);
        // yield to keyboard input, etc.
        await sleep(0);
        time = Date.now();
      }
    }

    if (!this.aborted)
      this.context2d.putImageData(image, 0, 0);
    this.rendering = false;
  }

  getPeriodSize(freq = this.f_min) {
    // 40 Hz corresponds to about 1000 samples at 44.1 kHz.
    return this.audioCtx.sampleRate / freq;
  }

  y2freq(y) {
    let size = this.canvas.width;
    return log2mix(this.f_min, this.f_max, 1 - y / size);
  }

  drawLine(y = 0) {
    let size = this.canvas.width;
    let freq = this.y2freq(y);
    let period = this.getPeriodSize(freq);
    let conv = this.convolve(period);

    let padding = Math.floor(this.getPeriodSize() * this.m_periods);
    let view_size = Math.floor(this.t_max - this.t_min);
    let view = conv.subarray(padding, padding + view_size);

    let pixels = this.pixels;
    let image = this.image;
    // 1 pixel averages ~1000 samples
    let psize = view.length / size;

    pixels.fill(0);

    for (let i = 0; i < view.length; i++)
      pixels[i / psize | 0] += view[i] ** 2 / psize;

    for (let x = 0; x < size; x++) {
      let avg = pixels[x];
      let log = -vargs.CWT_BRIGHTNESS / Math.log2(Math.min(0.95, avg));
      let p = 4 * (y * size + x);
      image.data[p + 0] = log * 1 * 256;
      image.data[p + 1] = log * 2 * 256;
      image.data[p + 2] = log * 4 * 256;
      image.data[p + 3] = 255;
    }
  }

  convolve(period = 2, res = this.conv_abs) {
    this.initMorletWavelet(period);
    this.initFFT(this.fft_product.length / 2);

    // Convolution between signal and wavelet can be computed
    // in N*log(N) steps using the following relation:
    //
    //  DFT[X ** Y] = DFT[X] * DFT[Y]
    //
    // Where ** is convolution and * is the dot product.    
    // console.log('Computing FFT of input signal and wavelet function');
    FFT.dot(this.signal_fft, this.wavelet_fft, this.fft_product);
    this.fft.inverse(this.fft_product, this.convolution);
    return FFT.abs(this.convolution, res);
  }

  initFFT(size) {
    if (vargs.CWT_GL && !this.webgl) {
      let glcanvas = document.createElement('canvas');
      this.webgl = new GpuContext(glcanvas);
      this.webgl.init();
    }

    if (!this.fft || this.fft.size != size) {
      console.log('Re-initiailzing FFT:', size);
      this.fft = new FFT(size, { webgl: this.webgl });
    }
  }

  initAudioFrame() {
    let base = Math.floor(this.t_min);
    let size = Math.floor(this.t_max - this.t_min);

    // FFT is circular, meaning that audio samples on
    // the right will interfere with audio samples on
    // the left. To avoid this side effect, run FFT on
    // a slightly wider signal sample, and then discard
    // the paddings when rendering.
    let padding = Math.floor(this.getPeriodSize() * this.m_periods);
    let padded_size = size + 2 * padding; // on the left and on the right
    // FFT works with 2**N inputs only.
    padded_size = 2 ** Math.ceil(Math.log2(padded_size));

    let padded_base = base - padding; // can be negative
    let signal = getPaddedSlice(this.audioSamples,
      padded_base, padded_base + padded_size);

    console.log('Running FFT over', signal.length, 'audio samples =',
      (signal.length / this.audioCtx.sampleRate).toFixed(2), 'sec of audio');
    this.initFFT(signal.length);
    let time = Date.now();
    this.signal_fft = new Float32Array(signal.length * 2);
    this.fft.transform(FFT.expand(signal), this.signal_fft);
    console.log('FFT done in', Date.now() - time, 'ms');

    let n = this.signal_fft.length;
    this.wavelet_fft = new Float32Array(n);
    this.fft_product = new Float32Array(n);
    this.convolution = new Float32Array(n);
    this.conv_abs = new Float32Array(n / 2);
  }

  // Returns precomputed FFT of the Morlet wavelet:
  //
  //  W(t) = exp(i*w*t)*exp(-t*t/2)
  //
  // FFT of the gaussian is another gaussian with a scaled stddev.
  // The exp(i*w*t) multiplier shifts the FFT. While the idea is
  // trivial, getting all these coefficients right is not. See:
  // https://www.weisang.com/en/documentation/timefreqspectrumalgorithmscwt_en/
  initMorletWavelet(s = 2) {
    let n = this.wavelet_fft.length / 2;
    let pi4 = Math.PI ** 0.25;
    let m = 2 * Math.PI * this.m_periods;

    this.wavelet_fft.fill(0);

    for (let k = 0; k <= n / 2; k++) {
      let gaussian = pi4 * Math.exp(-0.5 * (m * (s * k / n - 1)) ** 2);
      this.wavelet_fft[2 * k + 0] = Math.sqrt(m * s) * gaussian;
      this.wavelet_fft[2 * k + 1] = 0;
    }
  }
}

// Same as GLSL mix().
function mix(x, y, a) {
  return y * a + x * (1 - a);
}

function log2mix(x, y, a) {
  return 2 ** mix(Math.log2(x), Math.log2(y), a);
}

function sleep(time) {
  return new Promise(
    resolve => setTimeout(resolve, time));
}

// Same as src.slice(min, ax), but padded with zeros.
function getPaddedSlice(src, min, max) {
  let n = src.length;
  let res = new Float32Array(max - min);
  res.set(
    src.subarray(
      Math.max(0, min),
      Math.min(n, max)),
    Math.max(0, -min));
  return res;
}
