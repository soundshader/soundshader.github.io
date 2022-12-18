import { GpuAcfVisualizerProgram } from "./glsl/acf-visualizer.js";

export class WebACF {
  constructor(webgl, { fft_size, img_size }) {
    this.fft_size = fft_size;
    this.webgl = webgl;
    this.acf_program = new GpuAcfVisualizerProgram(this.webgl, { fft_size, img_size });
  }

  draw(audio_samples, canvas) {
    // The audio wave is packed in a NxNx4 buffer.
    // N here has nothing to do with the FFT size.
    let fb_size = 2048 ** 2 * 4;
    let len = Math.min(audio_samples.length, fb_size);
    let fb_waveform = this.webgl.createFrameBuffer(
      { size: (fb_size / 4) ** 0.5, channels: 4 });

    fb_waveform.upload(audio_samples); // send to GPU

    this.acf_program.exec({
      uWaveFormFB: fb_waveform,
      uOffsetMin: -this.fft_size / 2 | 0,
      uOffsetMax: len + this.fft_size / 2 | 0,
    }, null);

    fb_waveform.destroy();

    let ctx2d = canvas.getContext('2d');
    let dw = canvas.width;
    let dh = canvas.height;
    let sw = this.webgl.canvas.width;
    let sh = this.webgl.canvas.height;
    ctx2d.drawImage(this.webgl.canvas,
      0, 0, sw, sh,
      0, 0, dw, dh);
  }
}
