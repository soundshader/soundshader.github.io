import * as vargs from '../vargs.js';
import { FFT } from "./fft.js";
import { CWT } from "./cwt.js";
import { GpuContext } from "../webgl/gpu-context.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuSpectrogramProgram } from "../glsl/spectrogram.js";
import { GpuPatternAudioProgram } from "../glsl/pattern-audio.js";
import { GpuChromagramProgram } from "../glsl/chromagram.js";
import { GpuRadialHarmonicsProgram } from "../glsl/radial-harmonics.js";
import { GpuHarmonicsProgram } from "../glsl/harmonics.js";
import { GpuZTransformProgram } from "../glsl/ztransform.js";
import { GpuPolarHarmonicsProgram } from "../glsl/polar-harmonics.js";
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

    this.audioCtx = new AudioContext();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = fftSize;

    this.maxTime = this.fftHalfSize;
    this.maxFreq = this.audioCtx.sampleRate / 2; // usually ~22.5 kHz
    this.running = false;
    this.started = false;
    this.timeStep = 0;

    this.waveform = new Float32Array(fftSize);
    this.fftInput = new Float32Array(fftSize * 2);
    this.fftOutput = new Float32Array(fftSize * 2);

    if (vargs.USE_CWT) {
      this.cwt = new CWT(this.fftHalfSize, {
        context: this.audioCtx,
        canvas: this.canvas,
        stats: this.stats,
      });
    } else {
      this.initGpu();
    }

    this.fft = new FFT(fftSize, {
      webgl: vargs.FFT_GL && this.webgl,
    });

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
    };
  }

  initGpu() {
    this.webgl = new GpuContext(this.canvas);
    this.webgl.init();

    // FFT[freq], for the latest audio sample
    this.fftArrayBuffer = new Float32Array(2 * this.fftHalfSize);
    this.fftFrameBuffer = new GpuFrameBuffer(this.webgl, {
      width: 1,
      height: this.fftHalfSize,
      channels: 2,
      source: this.fftArrayBuffer,
    });

    let args = {
      size: this.fftHalfSize,
      waveformLen: this.waveform.length,
      canvasSize: this.canvas.width,
      maxFreq: this.maxFreq,
      logScale: vargs.FFT_LOG_SCALE,
    };

    this.rendererId = 0;
    this.renderers = [];

    if (vargs.USE_FFT) {
      this.renderers.push(
        new GpuSpectrogramProgram(this.webgl, args));
    } else if (vargs.USE_ACF) {
      this.renderers.push(
        new GpuAcfVisualizerProgram(this.webgl, args));
    } else {
      this.renderers.push(
        new GpuAcfAnalyzerProgram(this.webgl, args),
        new GpuPatternAudioProgram(this.webgl, args),
        new GpuPolarHarmonicsProgram(this.webgl, args),
        new GpuZTransformProgram(this.webgl, args),
        new GpuHarmonicsProgram(this.webgl, args),
        new GpuRadialHarmonicsProgram(this.webgl, args),
        new GpuChromagramProgram(this.webgl, args));
    }
  }

  switchAudioRenderer() {
    this.rendererId = (this.rendererId + 1)
      % this.renderers.length;
  }

  drawFrame() {
    let node = this.renderers[this.rendererId];
    let time = this.timeStep / this.maxTime;

    node.exec({
      uTime: time,
      uMousePos: [this.mouseX, this.mouseY],
      uWaveForm: this.fftInput,
      uWaveFormRaw: this.waveform,
      uFFT: this.fftFrameBuffer,
      uMaxTime: this.maxTime / 60, // audio captured at 60 fps
      uMaxFreq: this.maxFreq,
    }, null);
  }

  async start(audioStream, audioFile, audioEl) {
    if (vargs.USE_CWT) {
      await this.cwt.init(audioFile);
      await this.cwt.render();
      return;
    }

    this.audioEl = audioEl;
    this.stream = audioStream;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);

    console.log('Audio waveform:', this.waveform.length, 'samples',
      '@', this.audioCtx.sampleRate, 'Hz',
      'x', this.source.channelCount, 'channels',
      (audioEl?.duration || 0) | 0, 'sec');

    this.started = true;
    this.resume();
  }

  async stop() {
    if (!this.started) return;
    this.audioEl?.pause();
    this.source.disconnect();
    let tracks = this.stream.getTracks();
    tracks.map(t => t.stop());
    this.stream = null;
    this.source = null;
    this.running = false;
    this.started = false;
    console.log('Audio stopped');
  }

  resume() {
    if (this.running)
      return;

    let time0 = 0;
    let frames = 0;

    let animate = (time) => {
      if (!this.running)
        return;

      this.captureFrame();
      this.drawFrame();
      this.timeStep++;
      time0 = time0 || time;

      if (time > time0 + 1000) {
        let dt = (time - time0) / 1e3;
        let fps = (this.timeStep - frames) / dt | 0;
        let sr = this.audioCtx.sampleRate;
        let nw = this.waveform.length;
        let t = this.analyser.context.currentTime | 0;
        // This awkward construct avoids re-creating DOM text nodes.
        let node = this.stats.firstChild || this.stats;
        node.textContent = `${fps} fps ${sr} Hz / ${nw} @ ${t} s`;
        time0 = time;
        frames = this.timeStep;
      }

      requestAnimationFrame(animate);
    };

    this.running = true;
    this.audioEl?.play();
    console.log('Audio resumed');

    animate();
  }

  pause() {
    this.running = false;
    this.audioEl?.pause();
    console.log('Audio paused');
  }

  captureFrame() {
    let n = this.fftHalfSize * 2;

    this.waveform.fill(0);
    this.analyser.getFloatTimeDomainData(this.waveform);

    if (vargs.USE_ACF) return;

    FFT.expand(this.waveform, this.fftInput);
    FFT.forward(this.fftInput, this.fftOutput);

    for (let i = 0; i < n / 2; i++) {
      let re = this.fftOutput[i * 2];
      let im = this.fftOutput[i * 2 + 1];

      let mag = Math.sqrt(re * re + im * im);
      let arg = !mag ? 0 : Math.acos(re / mag);
      if (im < 0) arg = -arg;

      this.fftArrayBuffer[i * 2] = mag;
      this.fftArrayBuffer[i * 2 + 1] = arg;
    }
  }
}
