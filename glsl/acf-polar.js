import { GpuSpectrogramProgram } from "./spectrogram.js";
import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

export class GpuAcfPolarProgram extends GpuSpectrogramProgram {
  constructor(webgl, { size, maxFreq }) {
    super(webgl, {
      size,
      maxFreq,
      logScale: false,
      radialCoords: true,
    });

    this.fftOutput = new Float32Array(size * 4);
    this.acfOutput = new Float32Array(size * 2);
    this.acfBuffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size,
      channels: 2,
      source: this.acfOutput,
    });
  }

  exec(args, output) {
    FFT.auto_cf(args.uWaveForm, this.fftOutput);
    FFT.abs(this.fftOutput, this.acfOutput);
    super.exec({ ...args, uFFT: this.acfBuffer }, output);
  }
}
