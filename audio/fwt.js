import { FFT } from "./fft.js";

// Fast wavelet transform.
export class FWT {
  constructor(size, { context, canvas }) {
    console.log('Fast Wavelet Transform', size);
    this.audioCtx = context;
    this.canvas = canvas;
    this.size = size; // ~1024
  }

  async init(audioFile) {
    console.log('Reading audio file:', (audioFile.size / 1e6).toFixed(1), 'MB');
    let audioBytes = await audioFile.arrayBuffer();
    console.log('Decoding audio data...');
    this.audioBuffer = await this.audioCtx.decodeAudioData(audioBytes);
    this.audioSamples = this.audioBuffer.getChannelData(0);
    this.info(this.audioBuffer);

    this.initAudioFrame();

    let n = this.signal_fft.length;
    this.wavelet_fft = new Float32Array(n);
    this.fft_product = new Float32Array(n);
    this.convolution = new Float32Array(n);
    this.conv_abs = new Float32Array(n / 2);

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
    await this.drawArea();
  }

  async drawArea(ymin = 0, ymax = this.canvas.height - 1) {
    let image = this.image;
    let time = Date.now();

    for (let y = ymin; y <= ymax; y++) {
      this.drawLine(y);

      if (Date.now() > time + 1000) {
        this.context2d.putImageData(image, 0, 0);
        await new Promise(
          resolve => setTimeout(resolve, 0));
        time = Date.now();
      }
    }

    this.context2d.putImageData(image, 0, 0);
  }

  drawLine(y = 0) {
    let size = this.canvas.width;
    let sampleRate = this.audioCtx.sampleRate;
    let maxFreq = sampleRate / 2;
    let freq = maxFreq * 2 ** (y / size * Math.log2(55.0 / maxFreq));
    let period = sampleRate / freq;
    // console.log('y = ', y, '->', freq | 0, 'Hz', '->', period | 0, 'samples');
    let conv = this.convolve(period);

    let pixels = this.pixels;
    let image = this.image;

    // console.log('Drawing wavelet:', conv.length, '->', size);

    for (let x = 0; x < size; x++) {
      // 1 pixel averages ~1000 samples
      let n = conv.length / size;
      let avg = 0;

      for (let i = 0; i < n; i++)
        avg += conv[x * n + i] / n;

      pixels[x] = avg;
    }

    for (let x = 0; x < size; x++) {
      let avg = pixels[x];
      let log = avg <= 0 ? 0 : avg >= 1 ? 1 : -1 / Math.log(avg);
      let sdb = (Math.log(avg) + 8.203) / 9.032;
      let p = 4 * (y * size + x);
      image.data[p + 0] = sdb * 256 | 0;
      image.data[p + 1] = log * 256 | 0;
      image.data[p + 2] = 0;
      image.data[p + 3] = 255;
    }
  }

  convolve(period = 2, res = this.conv_abs) {
    // console.log('Initializing Morlet wavelet for period', period, 'samples');
    this.initMorletWavelet(period);

    // Convolution between signal and wavelet can be computed
    // in N*log(N) steps using the following relation:
    //
    //  DFT[X ** Y] = DFT[X] * DFT[Y]
    //
    // Where ** is convolution and * is the dot product.    
    // console.log('Computing FFT of input signal and wavelet function');
    FFT.dot(this.signal_fft, this.wavelet_fft, this.fft_product);
    FFT.inverse(this.fft_product, this.convolution);
    return FFT.abs(this.convolution, res);
  }

  initAudioFrame(base = 2 ** 17, size = 2 ** 17) {
    console.log('Taking a signal snapshot...');
    let time = Date.now();
    let signal = FFT.expand(this.audioSamples.slice(base, base + size));
    this.signal_fft = FFT.forward(signal);
    console.log('Signal FFT done in', Date.now() - time, 'ms');
  }

  // https://www.weisang.com/en/documentation/timefreqspectrumalgorithmscwt_en/
  initMorletWavelet(s = 2) {
    let n = this.wavelet_fft.length / 2;
    let pi4 = Math.PI ** 0.25;
    let dt = 1 / 30;
    let m = 2 * Math.PI / dt;
    
    this.wavelet_fft.fill(0);

    for (let k = 0; k <= n / 2; k++) {
      let gaussian = pi4 * Math.exp(-0.5 * (m * (s * k / n - 1)) ** 2);
      let c4 = Math.sqrt(m * s);
      this.wavelet_fft[2 * k + 0] = c4 * gaussian;
      this.wavelet_fft[2 * k + 1] = 0;
    }
  }
}
