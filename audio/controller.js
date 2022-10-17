import * as log from '../log.js';
import * as vargs from '../url_args.js';
import { GpuFrameBuffer, GpuContext } from "../webgl2.js";
import { GpuAcfVisualizerProgram } from '../glsl/acf-visualizer.js';

export class AudioController {
  get audioStream() {
    return this.destNode.stream;
  }

  // seconds
  get currentTime() {
    return !this.activeAudio ? null :
      this.audioCtx.currentTime - this.playbackStarted + this.playbackOffset;
  }

  // seconds
  get audioDuration() {
    return !this.activeAudio ? null :
      this.activeAudio.buffer.duration + this.playbackOffset;
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
    this.canvas_gpu = null;
    this.webgl = null;
    this.stats = stats;
    this.fft_size = fftSize;
    this.offsetMin = 0;
    this.offsetMax = 0;
    this.activeAudio = null;
    this.rendererId = 0;
    this.renderers = [];
    this.waveform_fb = null;
    this.pending_frames = 0;
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
    return vargs.SAMPLE_RATE / vargs.ZOOM * (1 - y);
  }

  initMouse() {
    if (!vargs.USE_MOUSE) return;
    let initial_pos = null;

    this.canvas.onmouseout = () => {
      initial_pos = null;
    };

    this.canvas.onmousedown = e => {
      initial_pos = { x: e.offsetX, y: e.offsetY };
    };

    this.canvas.onmouseup = e => {
      if (!initial_pos) return;
      if (this.pending_frames) return;
      let t2 = this.canvasXtoT(e.offsetX);
      let t1 = this.canvasXtoT(initial_pos.x);
      let dt = (t1 - t2) | 0;
      if (Math.abs(dt) < 1) return;
      this.offsetMin += dt;
      this.offsetMax += dt;
      this.drawFrame();
    };

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
        this.drawFrame();
      } else if (e.ctrlKey) {
        this.offsetMin = t | 0;
        this.drawFrame();
      } else if (e.shiftKey) {
        this.offsetMax = t | 0;
        this.drawFrame();
      }
    };

    this.canvas.onmousewheel = e => {
      if (this.pending_frames) return;
      let zoom = 1.5 ** -Math.sign(e.wheelDelta);
      let min = this.offsetMin;
      let max = this.offsetMax;
      let mid = (min + max) / 2, len = max - min;
      this.offsetMin = (mid - len / 2 * zoom) | 0;
      this.offsetMax = (mid + len / 2 * zoom) | 0;
      this.drawFrame();
    };
  }

  initGpu() {
    this.canvas_gpu = document.createElement('canvas');
    this.canvas_gpu.width = this.canvas.width;
    this.canvas_gpu.height = this.canvas.height;

    this.webgl = new GpuContext(this.canvas_gpu);
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
    this.drawFrame(null);
  }

  switchRenderer() {
    let node = this.renderers[this.rendererId];
    node.show_acf = !node.show_acf;
    this.drawFrame();
  }

  drawFrame(input = this.waveform_fb) {
    let node = this.renderers[this.rendererId];
    let t_min = this.offsetMin - this.fft_size / 2;
    let t_max = this.offsetMax - this.fft_size / 2;

    let ctx2d = this.canvas.getContext('2d');
    let w = this.canvas.width;
    let h = this.canvas.height;
    let ns = vargs.NUM_STRIPES;
    let dt = (t_max - t_min) / ns;

    log.v('FFT step:', (t_max - t_min) / this.canvas.width / ns | 0);
    this.pending_frames++;

    requestAnimationFrame(() => {
      this.pending_frames--;
      for (let k = 0; k < ns; k++) {
        node.exec({
          uWaveFormFB: input,
          uOffsetMin: t_min + dt * k | 0,
          uOffsetMax: t_min + dt * (k + 1) | 0,
        }, null);

        ctx2d.drawImage(this.canvas_gpu,
          0, 0, w, h,
          0, h / ns * k | 0, w, h / ns | 0);
      }
    });
  }

  async start(audioFile) {
    stop();

    // The audio wave is packed in a NxNx4 buffer.
    // N here has nothing to do with FFT size.
    let fb_size = 2048 ** 2 * 4;
    this.waveform_fb = new GpuFrameBuffer(this.webgl,
      { size: (fb_size / 4) ** 0.5, channels: 4 });

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

    this.drawFrame();
  }

  async stop() {
    await this.stopAudio();

    if (this.waveform_fb) {
      this.waveform_fb.destroy();
      this.waveform_fb = null;
    }
  }

  async playAudio(offset = 0) {
    await this.stopAudio();

    let audioCtx = this.audioCtx;
    let src_sr = this.audioCtx.sampleRate;
    let res_sr = vargs.SAMPLE_RATE;
    let n_sr = 2 ** (Math.log2(src_sr / res_sr) | 0);
    let t_min = this.offsetMin * n_sr;
    let t_max = this.offsetMax * n_sr;

    if (offset > 0 && offset < 1)
      t_min += offset * (t_max - t_min) | 0;

    let t_len = t_max - t_min;
    let tmpbuf = audioCtx.createBuffer(1, t_len, src_sr);
    this.audioBuffer.copyFromChannel(tmpbuf.getChannelData(0), 0, t_min);
    let source = audioCtx.createBufferSource();
    source.buffer = tmpbuf;
    source.connect(audioCtx.destination);
    source.connect(this.destNode);
    this.activeAudio = source;
    this.playbackStarted = audioCtx.currentTime;
    this.playbackOffset = tmpbuf.duration / (1 - offset) * offset;

    log.i('Playing audio sample', tmpbuf.duration.toFixed(1), 'sec');
    source.start();

    this.playAudioPromise = new Promise((resolve) => {
      source.onended = () => {
        this.activeAudio = null;
        log.i('Audio playback stopped');
        resolve();
      };
    });
  }

  async stopAudio() {
    if (!this.activeAudio) return;
    log.i('Stopping audio playback');
    this.activeAudio.stop();
    this.activeAudio.disconnect();
    await this.playAudioPromise;
    this.activeAudio = null;
    this.playAudioPromise = null;
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
