import * as log from '../log.js';
import * as vargs from '../vargs.js';
import { GpuContext } from "../webgl/gpu-context.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuAcfVisualizerProgram } from '../glsl/acf-visualizer.js';

// Uses WebAudio's getFloatTimeDomainData() to read the raw audio samples
// and then applies FFT to compute amplitudes and phases (important!).
export class AudioController {
  get audioStream() {
    return this.destNode.stream;
  }

  // seconds
  get currentTime() {
    return !this.activeAudio ? null :
      this.audioCtx.currentTime - this.playbackStarted;
  }

  // seconds
  get audioDuration() {
    return !this.activeAudio ? null :
      this.activeAudio.buffer.duration;
  }

  get polarCoords() {
    let node = this.renderers[this.rendererId];
    return !node.flat;
  }

  set polarCoords(value) {
    let node = this.renderers[this.rendererId];
    node.flat = !value;
  }

  constructor(canvas, { stats, fftSize }) {
    this.canvas = canvas;
    this.webgl = null;
    this.stats = stats;
    this.fft_size = fftSize;
    this.offsetMin = 0;
    this.offsetMax = 0;
    this.activeAudio = null;
    this.rendererId = 0;
    this.renderers = [];
    this.waveform_fb = null;
  }

  init() {
    this.initGpu();
    this.initMouse();
  }

  canvasXtoT(offsetX) {
    let x = offsetX / this.canvas.clientWidth;
    return this.offsetMin * (1 - x) + this.offsetMax * x;
  }

  canvasYtoF(offsetY) {
    let y = offsetY / this.canvas.clientHeight;
    return vargs.SAMPLE_RATE / 2 * (1 - y);
  }

  initMouse() {
    // this.mouseX = 0;
    // this.mouseY = 0;

    if (!vargs.USE_MOUSE) return;

    this.canvas.onmousemove = e => {
      if (e.offsetX < 0 || e.offsetX >= this.canvas.clientWidth) {
        this.stats.textContent = '';
      } else {
        let t = this.canvasXtoT(e.offsetX);
        let f = this.canvasYtoF(e.offsetY);
        stats.textContent = 'T+' + (t / vargs.SAMPLE_RATE).toFixed(2)
          + 's' + ' ' + f.toFixed(0) + ' Hz';
      }
    };

    this.canvas.onclick = e => {
      let t = this.canvasXtoT(e.offsetX);

      if (e.ctrlKey && e.shiftKey) {
        this.offsetMin = 0;
        this.offsetMax = this.audioSamples.length;
        requestAnimationFrame(() =>
          this.drawFrame());
      } else if (e.ctrlKey) {
        this.offsetMin = t | 0;
        requestAnimationFrame(() =>
          this.drawFrame());
      } else if (e.shiftKey) {
        this.offsetMax = t | 0;
        requestAnimationFrame(() =>
          this.drawFrame());
      }
    };
  }

  initGpu() {
    this.webgl = new GpuContext(this.canvas);
    this.webgl.init();

    let args = {
      fft_size: this.fft_size,
      img_size: this.canvas.width,
    };

    this.renderers.push(
      new GpuAcfVisualizerProgram(this.webgl, args));
  }

  switchCoords() {
    this.polarCoords = !this.polarCoords;
    requestAnimationFrame(() =>
      this.drawFrame(null));
  }

  switchRenderer() {
    let node = this.renderers[this.rendererId];
    node.show_acf = !node.show_acf;
    requestAnimationFrame(() =>
      this.drawFrame());
  }

  drawFrame(input = this.waveform_fb) {
    let node = this.renderers[this.rendererId];
    let t_min = this.offsetMin - this.fft_size/2;
    let t_max = this.offsetMax - this.fft_size/2;

    log.v('FFT step:', (t_max - t_min) / this.canvas.width | 0);

    node.exec({
      uWaveFormFB: input,
      uOffsetMin: t_min,
      uOffsetMax: t_max,
    }, null);
  }

  async start(audioFile) {
    stop();

    // The audio wave is packed in a NxNx1 buffer.
    // N here has nothing to do with FFT size.
    let fb_size = 4096 ** 2;
    this.waveform_fb = new GpuFrameBuffer(this.webgl,
      { size: fb_size ** 0.5 });

    let encodedAudio = await audioFile.arrayBuffer();
    this.audioCtx = this.createAudioContext();
    this.destNode = this.audioCtx.createMediaStreamDestination();
    log.i('Decoding audio data:', audioFile.type);
    let ts = Date.now();
    this.audioBuffer = await this.audioCtx.decodeAudioData(encodedAudio);
    log.i('Decoded in', (Date.now() - ts) / 1000 | 0, 'sec');
    this.audioSamples = new Float32Array(this.audioBuffer.getChannelData(0));
    this.audioSamples = this.fixAudioBufferRate(this.audioSamples);

    if (this.audioSamples.length > fb_size)
      this.audioSamples = this.audioSamples.slice(0, fb_size);

    // TODO: Add N/2 zeros on the left and on the right.

    this.offsetMin = 0;
    this.offsetMax = this.audioSamples.length;
    this.waveform_fb.upload(this.audioSamples); // send to GPU

    log.i('Decoded sound:', this.audioBuffer.duration.toFixed(1), 'sec',
      '@', this.audioBuffer.sampleRate, 'Hz',
      'x', this.audioBuffer.numberOfChannels, 'channels');

    requestAnimationFrame(() =>
      this.drawFrame());
  }

  stop() {
    this.stopAudio();

    if (this.waveform_fb) {
      this.waveform_fb.destroy();
      this.waveform_fb = null;
    }
  }

  async playAudio() {
    this.stopAudio();
    let audioCtx = this.audioCtx;
    let src_sr = this.audioCtx.sampleRate;
    let res_sr = vargs.SAMPLE_RATE;
    let n_sr = 2 ** (Math.log2(src_sr / res_sr) | 0);
    let t_min = this.offsetMin * n_sr;
    let t_max = this.offsetMax * n_sr;
    let t_len = t_max - t_min;
    let tmpbuf = audioCtx.createBuffer(1, t_len, src_sr);
    this.audioBuffer.copyFromChannel(tmpbuf.getChannelData(0), 0, t_min);
    let source = audioCtx.createBufferSource();
    source.buffer = tmpbuf;
    source.connect(audioCtx.destination);
    source.connect(this.destNode);
    this.activeAudio = source;
    this.playbackStarted = audioCtx.currentTime;
    log.i('Playing audio sample', tmpbuf.duration.toFixed(1), 'sec');
    source.start();
    return new Promise((resolve) => {
      source.onended = () => {
        this.activeAudio = null;
        log.i('Done playing audio');
        resolve();
      };
    });
  }

  stopAudio() {
    if (this.activeAudio) {
      this.activeAudio.stop();
      this.activeAudio.disconnect();
      this.activeAudio = null;
    }
  }

  createAudioContext() {
    // AudioContext doesn't support too low sample rates.
    for (let sr = vargs.SAMPLE_RATE | 0; ; sr *= 2) {
      try {
        return new AudioContext({ sampleRate: sr });
      } catch (e) {
        log.i('AudioContext doesnt support', sr, 'Hz');
        if (sr > 48000) {
          log.w('Giving up. AudioContext must support 48 kHz.');
          throw e;
        }
      }
    }
  }

  fixAudioBufferRate(a) {
    let src_sr = this.audioCtx.sampleRate;
    let res_sr = vargs.SAMPLE_RATE;
    let n = Math.log2(src_sr / res_sr);
    if (n < 1) return a;

    log.i('Downsampling', a.length, 'samples from',
      src_sr, 'Hz to', res_sr, 'Hz');

    for (let i = 0; i < n; i++) {
      this.downsample2x(a);
      a = a.slice(a.length / 2 | 0);
    }

    return a;
  }

  downsample2x(a) {
    for (let i = 0; i < a.length / 2; i++) {
      let j = 2 * i;
      // Simpson's formula.
      // a[i] = ((a[j - 1] || 0) + 4 * a[j] + (a[j + 1] || 0)) / 6;
      a[i] = 0.5 * a[j] + 0.5 * a[j + 1];
    }
  }
}
