import * as log from '../log.js';
import * as vargs from '../vargs.js';
import { GpuContext } from "../webgl/gpu-context.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuSpectrogramProgram } from "../glsl/spectrogram.js";
import { GpuAcfVisualizerProgram } from '../glsl/acf-visualizer.js';
import { GpuWaveformProgram as GpuAcfAnalyzerProgram } from '../glsl/acf-analyzer.js';

// Uses WebAudio's getFloatTimeDomainData() to read the raw audio samples
// and then applies FFT to compute amplitudes and phases (important!).
export class AudioController {
  constructor(canvas, { stats, fftSize }) {
    this.canvas = canvas;
    this.stats = stats;
    this.fftHalfSize = fftSize / 2;
  }

  init() {
    let fftSize = this.fftHalfSize * 2;

    this.audioCtx = new AudioContext({
      sampleRate: vargs.SAMPLE_RATE * 1e3 | 0,
    });

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = fftSize;

    this.maxTime = this.fftHalfSize;
    this.maxFreq = this.audioCtx.sampleRate / 2; // usually ~22.5 kHz
    this.running = false;
    this.started = false;
    this.timeStep = 0;
    this.waveform = new Float32Array(fftSize);

    this.initGpu();
    this.initMouse();
  }

  initMouse() {
    this.mouseX = 0;
    this.mouseY = 0;

    if (!vargs.USE_MOUSE) return;

    this.canvas.onmousemove = e => {
      let x = e.offsetX / this.canvas.clientWidth;
      let y = e.offsetY / this.canvas.clientHeight;

      this.mouseX = x * 2 - 1;
      this.mouseY = 1 - y * 2;

      if (!this.running) {
        requestAnimationFrame(() =>
          this.drawFrame());
      }
    };
  }

  initGpu() {
    this.webgl = new GpuContext(this.canvas);
    this.webgl.init();

    window.gl = this.webgl.gl;    

    let args = {
      size: this.fftHalfSize,
      waveformLen: this.waveform.length,
      imgSize: this.canvas.width,
      maxFreq: this.maxFreq,
      logScale: vargs.FFT_LOG_SCALE,
    };

    this.rendererId = 0;
    this.renderers = [];

    let ctor = {
      acf: GpuAcfVisualizerProgram,
      fft: GpuSpectrogramProgram,
      acfa: GpuAcfAnalyzerProgram,
    }[vargs.SHADER];

    if (!ctor) throw new Error('Unknown visualizer id: ' + vargs.SHADER);

    this.renderers.push(
      new ctor(this.webgl, args));
  }

  switchCoords() {
    let node = this.renderers[this.rendererId];
    node.flat = !node.flat;
    requestAnimationFrame(() =>
      this.drawFrame());
  }

  drawFrame(output = null) {
    let node = this.renderers[this.rendererId];
    let time = this.timeStep / this.maxTime;

    node.exec({
      uTime: time,
      uMousePos: [this.mouseX, this.mouseY],
      uWaveFormRaw: output && this.waveform,
      uMaxTime: this.maxTime / 60, // audio captured at 60 fps
      uMaxFreq: this.maxFreq,
    }, output);
  }

  async start(audioStream, audioFile, audioEl) {
    this.audioEl = audioEl;
    this.stream = audioStream;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);

    log.i('Input sound:', this.waveform.length, 'samples/batch',
      '@', this.audioCtx.sampleRate, 'Hz',
      'x', this.source.channelCount, 'channels',
      (audioEl ? audioEl.duration : 0) | 0, 'sec');

    this.started = true;
    this.resume();
  }

  async stop() {
    if (!this.started) return;
    this.pause();
    this.source.disconnect();
    let tracks = this.stream.getTracks();
    tracks.map(t => t.stop());
    this.stream = null;
    this.source = null;
    this.started = false;
    log.i('Audio stopped');
  }

  pause() {
    this.running = false;
    this.audioEl && this.audioEl.pause();
    clearInterval(this.timerId);
    cancelAnimationFrame(this.animationId);
    this.timerId = 0;
    this.animationId = 0;
    log.i('Audio paused');
  }

  resume() {
    if (this.running)
      return;

    let time0 = 0;
    let frames = 0;

    this.timerId = setInterval(() => {
      if (!this.running)
        return;
      this.timeStep++;
      this.captureFrame();
      this.drawFrame(GpuFrameBuffer.DUMMY);
    }, 1000 / vargs.SHADER_FPS);

    let animate = (time) => {
      if (!this.running)
        return;
      this.drawFrame();
      time0 = time0 || time;

      if (time > time0 + 1000) {
        let dt = (time - time0) / 1e3;
        let fps = (this.timeStep - frames) / dt | 0;
        let sr = this.audioCtx.sampleRate;
        let nw = this.waveform.length;
        let t = this.analyser.context.currentTime | 0;
        let d = (this.audioEl ? this.audioEl.duration : 0) | 0;
        // This awkward construct avoids re-creating DOM text nodes.
        let node = this.stats.firstChild || this.stats;
        node.textContent = `${fps} fps ${sr} Hz / ${nw} @ ${t} / ${d} s`;
        time0 = time;
        frames = this.timeStep;
      }

      this.animationId = requestAnimationFrame(animate);
    };

    this.running = true;
    log.i('Audio resumed');

    animate();

    this.audioEl && this.audioEl.play();
  }

  captureFrame() {
    this.analyser.getFloatTimeDomainData(this.waveform);
  }
}
