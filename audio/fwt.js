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
    this.wavelet = new Float32Array(n);
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

  async drawArea(ymin = 0, ymax = -1) {
    if (ymax < 0)
      ymax += this.canvas.height;

    for (let y = ymax; y >= ymin; y--) {
      this.drawLine(y);
      await new Promise(
        resolve => setTimeout(resolve, 0));
    }
  }

  drawLine(y = 0) {
    let size = this.canvas.width;
    let sampleRate = this.audioCtx.sampleRate;
    let maxFreq = sampleRate / 2;
    let freq = maxFreq * 2 ** (y / size * Math.log2(55.0 / maxFreq));
    let period = sampleRate / freq;
    // console.log('y = ', y, '->', freq | 0, 'Hz', '->', period | 0, 'samples');
    let conv = this.convolve(period);

    let time = Date.now();

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

    this.context2d.putImageData(image, 0, 0);
    let diff = Date.now() - time;
    if (diff > 15) console.log('Drawing time:', diff, 'ms');
  }

  convolve(period = 2, res = this.conv_abs) {
    // console.log('Initializing Morlet wavelet for period', period, 'samples');
    this.initMorletWavelet(this.wavelet, period);

    // Convolution between signal and wavelet can be computed
    // in N*log(N) steps using the following relation:
    //
    //  DFT[X ** Y] = DFT[X] * DFT[Y]
    //
    // Where ** is convolution and * is the dot product.    
    // console.log('Computing FFT of input signal and wavelet function');
    let time = Date.now();
    FFT.forward(this.wavelet, this.wavelet_fft);
    FFT.dot(this.signal_fft, this.wavelet_fft, this.fft_product);
    FFT.inverse(this.fft_product, this.convolution);

    let diff = Date.now() - time;
    if (diff > 150) {
      console.log('Convolution FFT perf:', Date.now() - time, 'ms',
        'period', period, 'samples');
    }

    return FFT.abs(this.convolution, res);
  }

  initAudioFrame(base = 0, size = 2 ** 18) {
    console.log('Taking a signal snapshot...');
    let time = Date.now();
    let signal = FFT.expand(this.audioSamples.slice(base, base + size));
    this.signal_fft = FFT.forward(signal);
    console.log('Signal FFT done in', Date.now() - time, 'ms');
  }

  // https://en.wikipedia.org/wiki/Morlet_wavelet
  // https://atoc.colorado.edu/research/wavelets/wavelet2.html
  // 
  // W(t) = PI**0.25 * exp(i*PI*k) * exp(-0.5*(PI*k)**2)
  //
  // 1. exp(i*PI*k) turns into a +1,-1,+1,-1,... sequence to
  //    capture signals with the shortest period = 2 (samples).
  //    
  // 2. exp(-0.5*x**2) is the normal distribution (up to a const)
  //    that's scaled to capture the 3 sigma area under |x| < 1.
  //
  // Finally, the base wavelet function is scaled to W(t*2/period).
  //
  // The smallest possible period is 2, because no discrete sequence
  // can oscillate faster than +1, -1, +1, -1, ...
  initMorletWavelet(wavelet, period = 2) {
    let n = wavelet.length / 2;
    let pi4 = Math.PI ** 0.25;

    // The 1 sigma range of the gaussian, measured in periods.
    // 99.7% of the wavelet function lies within |x| < 3*sigma.
    // The smallest period is 2 samples. Smaller sigma detects
    // smaller patterns in the source signal.
    //
    // Values smaller than 0.01 (i.e. 1 sigma = 100 periods) produce
    // a wavelet that's not much different from simple exp(i*w*t),
    // so the wavelet transform turns into fourier transform, except
    // that it's applied to a long range (10-20 sec) of sound. The
    // result is a blurry mess.
    //
    // Values higher than 1.0 (i.e. 99.7% of the wavelet function is
    // inside the 3*sigma = 3 periods area), produce a wavelet function
    // that's too narrow, i.e. it's like applying fourier transform to
    // a small range of 4-6 periods. As a result, it's unable to detect
    // repetitive patterns longer than those 4-6 periods.
    let s = 1 / 30;
    // This param can't be changed. It's used to make the exp(i*w*t) term
    // flip between -1 and +1 when the period is the smallest = 2. Changing
    // this param effectively changes the sound frequency being detected:
    // increasing it above this value, makes the wavelet detect patterns
    // with periods smaller than 2 samples (impossible), which produces
    // curious artifacts in the high frequency range. Lowering this param
    // has the effect of zooming into the wavelet image, i.e. instead of
    // displaying the 0..20kHz range, it would display 0..5kHz.
    let w = Math.PI / s;
    // The normalization constant to make the integral of the squared
    // wavelet function equal to 1. However, given that w > 50, this const
    // is effectively 1.
    let cnorm = 1 / Math.sqrt(1 + Math.exp(-w * w) - 2 * Math.exp(-0.75 * w * w));

    for (let i = 0; i < n / 2; i++) {
      let t = s * (i + 0.5) * 2 / period;
      let gaussian = cnorm * pi4 * Math.exp(-0.5 * t * t);

      let exp_re = Math.cos(w * t);
      let exp_im = Math.sin(w * t);

      // the left half = the positive t > 0 side
      wavelet[2 * i + 0] = exp_re * gaussian;
      wavelet[2 * i + 1] = exp_im * gaussian;

      // the right half = the negative t < 0 side
      wavelet[2 * (n - 1 - i) + 0] = exp_re * gaussian;
      wavelet[2 * (n - 1 - i) + 1] = -exp_im * gaussian;
    }
  }
}
