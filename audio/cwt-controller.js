import * as vargs from '../vargs.js';
import { CWT } from "./cwt.js";

export class CwtController {
  constructor(canvas, { stats, fftSize }) {
    this.canvas = canvas;
    this.stats = stats;
    this.fftHalfSize = fftSize / 2;
  }

  init() {
    this.audioCtx = new AudioContext({
      sampleRate: vargs.SAMPLE_RATE | 0,
    });

    this.cwt = new CWT(this.fftHalfSize, {
      context: this.audioCtx,
      canvas: this.canvas,
      stats: this.stats,
    });
  }

  async start(audioStream, audioFile) {
    await this.cwt.init(audioFile);
    await this.cwt.render();
  }

  async stop() {

  }

  resume() {
    
  }

  pause() {
    
  }
}
