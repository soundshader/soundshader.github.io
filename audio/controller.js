import { FFT } from "./fft.js";
import { GpuContext } from "../webgl/gpu-context.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuSpectrogramProgram } from "../glsl/spectrogram.js";
import { GpuPatternAudioProgram } from "../glsl/pattern-audio.js";
import { GpuChromagramProgram } from "../glsl/chromagram.js";

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

    this.webgl = new GpuContext(this.canvas);
    this.audioCtx = new AudioContext();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = fftSize;

    this.maxTime = this.fftHalfSize;
    this.maxFreq = this.audioCtx.sampleRate / 2; // usually ~22.5 kHz
    this.running = false;
    this.started = false;
    this.timeStep = 0;

    this.fft = new FFT(fftSize);
    this.waveform = new Float32Array(fftSize);
    this.fftInput = new Float32Array(fftSize * 2);
    this.fftOutput = new Float32Array(fftSize * 2);

    this.initGpu();
    this.initMouse();
  }

  initMouse() {
    this.mouseX = 0;
    this.mouseY = 0;

    this.canvas.onmousemove = e => {
      let x = e.clientX / this.canvas.clientWidth;
      let y = e.clientY / this.canvas.clientHeight;

      this.mouseX = x * 2 - 1;
      this.mouseY = 1 - y * 2;
    };
  }

  initGpu() {
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
      maxFreq: this.maxFreq,
    };

    this.renderers = [
      new GpuPatternAudioProgram(this.webgl, args),
      new GpuSpectrogramProgram(this.webgl, args),
      new GpuChromagramProgram(this.webgl, args),
    ];

    this.rendererId = 0;
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
      uFFT: this.fftFrameBuffer,
      uMaxTime: this.maxTime / 60, // audio captured at 60 fps
      uMaxFreq: this.maxFreq,
    }, null);
  }

  async start(audioStream) {
    this.stream = audioStream;
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);
    this.started = true;
    this.resume();
  }

  async stop() {
    if (!this.started) return;
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
        // This awkward construct avoids re-creating DOM text nodes.
        let node = this.stats.firstChild || this.stats;
        node.textContent = `${fps} fps`;
        time0 = time;
        frames = this.timeStep;
      }

      requestAnimationFrame(animate);
    };

    this.running = true;
    console.log('Audio resumed');
    animate();
  }

  pause() {
    this.running = false;
    console.log('Audio paused');
  }

  captureFrame() {
    let n = this.fftHalfSize * 2;

    this.waveform.fill(0);
    this.analyser.getFloatTimeDomainData(this.waveform);

    this.fftInput.fill(0);
    for (let i = 0; i < n; i++)
      this.fftInput[i * 2] = this.waveform[i];

    this.fftOutput.fill(0);
    this.fft.transform(this.fftInput, this.fftOutput);

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
