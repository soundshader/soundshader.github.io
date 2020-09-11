import { FFT } from "./fft.js";
import { GpuContext } from "../webgl/gpu-context.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuSpectrogramProgram } from "../glsl/spectrogram.js";
import { GpuPatternAudioProgram } from "../glsl/pattern-audio.js";

// Uses WebAudio's getFloatTimeDomainData() to read the raw audio samples
// and then applies FFT to compute amplitudes and phases (important!).
export class AudioController {
  constructor(canvas, { stats, fftSize = 1024 }) {
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

    // FFT[time, freq] magnitide + phase
    this.fftArrayBuffer = new Float32Array(2 * this.fftHalfSize ** 2);
    this.fftArrayBuffer.fill(-10);
    this.fftFrameBuffer = new GpuFrameBuffer(this.webgl, {
      size: this.fftHalfSize,
      channels: 2,
      source: this.fftArrayBuffer,
    });

    // FFT[freq], for the latest audio sample
    this.fftLineArrayBuffer = new Float32Array(2 * this.fftHalfSize);
    this.fftLineArrayBuffer.fill(-10);
    this.fftLineFrameBuffer = new GpuFrameBuffer(this.webgl, {
      width: 1,
      height: this.fftHalfSize,
      channels: 2,
      source: this.fftLineArrayBuffer,
    });

    this.audioRenderers = [
      new GpuPatternAudioProgram(this.webgl, { size: this.fftHalfSize }),
      new GpuSpectrogramProgram(this.webgl),
    ];

    this.selectedRendererId = 0;
  }

  switchAudioRenderer() {
    this.selectedRendererId = (this.selectedRendererId + 1)
      % this.audioRenderers.length;
  }

  drawFrame() {
    let node = this.audioRenderers[this.selectedRendererId];
    let time = this.timeStep / this.maxTime;

    node.exec({
      uTimeStep: 1.0, // seconds
      uTime: time,
      uMousePos: [this.mouseX, this.mouseY],
      uFFT: this.fftLineFrameBuffer,
      uInput: this.fftFrameBuffer,
      uSize: [this.fftFrameBuffer.width, this.fftFrameBuffer.height],
      uMaxTime: this.maxTime * 1 / 60, // audio captured at 60 fps
      uMaxFreq: this.maxFreq,
      uHalfRange: 440 / this.maxFreq, // the A4 piano note = 440 Hz
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
    let t = this.timeStep % this.maxTime;

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

      this.fftLineArrayBuffer[i * 2] = mag;
      this.fftLineArrayBuffer[i * 2 + 1] = arg;

      let j = i * this.maxTime + t;
      this.fftArrayBuffer[j * 2] = mag;
      this.fftArrayBuffer[j * 2 + 1] = arg;
    }
  }
}
