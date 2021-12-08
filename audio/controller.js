import * as log from '../log.js';
import * as vargs from '../vargs.js';
import { GpuContext } from "../webgl/gpu-context.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuSpectrogramProgram } from "../glsl/spectrogram.js";
import { GpuAcfVisualizerProgram } from '../glsl/acf-visualizer.js';
import { GpuAcf3VisualizerProgram } from '../glsl/acf3-visualizer.js';
import { GpuWaveformProgram as GpuAcfAnalyzerProgram } from '../glsl/acf-analyzer.js';

// Uses WebAudio's getFloatTimeDomainData() to read the raw audio samples
// and then applies FFT to compute amplitudes and phases (important!).
export class AudioController {
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
    this.audioCtx = new AudioContext({
      sampleRate: vargs.SAMPLE_RATE * 1e3 | 0,
    });

    this.initGpu();
    this.initMouse();
  }

  canvasXtoT(offsetX) {
    // log.assert(offsetX >= 0 && offsetX < this.canvas.clientHeight);
    let x = offsetX / this.canvas.clientWidth;
    return this.offsetMin * (1 - x) + this.offsetMax * x;
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
        stats.textContent = 'T+' + (t / this.audioCtx.sampleRate).toFixed(2) + 's';
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

    let ctor = {
      acf: GpuAcfVisualizerProgram,
      fft: GpuSpectrogramProgram,
      acfa: GpuAcfAnalyzerProgram,
      acf3: GpuAcf3VisualizerProgram,
    }[vargs.SHADER];

    if (!ctor) throw new Error('Unknown visualizer id: ' + vargs.SHADER);

    this.renderers.push(
      new ctor(this.webgl, args));
  }

  switchCoords() {
    let node = this.renderers[this.rendererId];
    node.flat = !node.flat;
    requestAnimationFrame(() =>
      this.drawFrame(null));
  }

  drawFrame(input = this.waveform_fb) {
    let node = this.renderers[this.rendererId];
    let t_min = this.offsetMin - this.fft_size / 2;
    let t_max = this.offsetMax - this.fft_size / 2;

    node.exec({
      uWaveFormFB: input,
      uOffsetMin: t_min,
      uOffsetMax: t_max,
    }, null);
  }

  async start(audioFile) {
    stop(); // Just in case.

    // The audio wave is packed in a NxNx1 buffer.
    // N here has nothing to do with FFT size.
    this.waveform_fb = new GpuFrameBuffer(this.webgl,
      { size: 4096 });
    let fb_size = this.waveform_fb.width * this.waveform_fb.height * this.waveform_fb.channels;

    log.i('Decoding audio data:', audioFile.type);
    let encodedAudio = await audioFile.arrayBuffer();
    this.audioBuffer = await this.audioCtx.decodeAudioData(encodedAudio);
    this.audioSamples = new Float32Array(this.audioBuffer.getChannelData(0))

    if (this.audioSamples.length > fb_size)
      this.audioSamples = this.audioSamples.slice(0, fb_size);

    this.offsetMin = 0;
    this.offsetMax = this.audioSamples.length;
    this.waveform_fb.upload(this.audioSamples); // send to GPU

    log.i('Decoded sound:', this.fft_size, 'samples/batch',
      '@', this.audioBuffer.sampleRate, 'Hz',
      'x', this.audioBuffer.numberOfChannels, 'channels',
      this.audioBuffer.duration.toFixed(1), 'sec');

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
    let t_min = this.offsetMin;
    let t_max = this.offsetMax;
    let t_len = t_max - t_min;
    let tmpbuf = audioCtx.createBuffer(1, t_len, audioCtx.sampleRate);
    this.audioBuffer.copyFromChannel(tmpbuf.getChannelData(0), 0, t_min);
    let source = audioCtx.createBufferSource();
    source.buffer = tmpbuf;
    source.connect(audioCtx.destination);
    this.activeAudio = source;
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
}
