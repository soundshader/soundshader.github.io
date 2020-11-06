import * as log from '../log.js';
import * as vargs from "../vargs.js";
import { GpuFFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { shaderUtils, colorUtils, complexMath, textureUtils } from "./basics.js";
import { GpuStatsProgram } from "./stats.js";
import { GpuDownsampler } from './downsampler.js';

// https://en.wikipedia.org/wiki/Bispectrum
// https://en.wikipedia.org/wiki/Triple_correlation
export class GpuAcf3VisualizerProgram {
  constructor(webgl, { waveformLen, imgSize }) {
    this.webgl = webgl;
    this.flat = !!vargs.ACF_COORDS;

    let size = waveformLen;

    this.bispectrum = new GpuACF3(webgl, { size });
    this.stats = new GpuStatsProgram(webgl, { size });
    this.colorizer = new GpuColorizer(webgl, { size, sigma: vargs.ACF_SIGMA });
    this.recorder = new GpuRecorder(webgl);
    this.downsampler = new GpuDownsampler(webgl,
      { width: size, height: size, channels: 4, aa: Math.log2(size / imgSize) });

    this.texBispectrum = new GpuFrameBuffer(webgl, { size });
    this.texStats = new GpuFrameBuffer(webgl, { size: 1, channels: 4 });
    this.texImage = new GpuFrameBuffer(webgl, { size, channels: 4 });
    this.texImageA = new GpuFrameBuffer(webgl, { size, channels: 4 });
    this.texImageB = new GpuFrameBuffer(webgl, { size, channels: 4 });

    log.i('ACF3 config:', size);
  }

  exec({ uWaveFormRaw, uMousePos }, output) {
    let [mx, my] = uMousePos;

    if (uWaveFormRaw) {
      this.bispectrum.exec({
        uWaveFormRaw,
      }, this.texBispectrum);

      this.stats.exec({
        uData: this.texBispectrum,
      }, this.texStats);

      // log.i('ACF3 stats:', this.texStats.download());

      this.colorizer.exec({
        uFlat: this.flat,
        uData: this.texBispectrum,
        uStats: this.texStats,
      }, this.texImage);

      this.recorder.exec({
        uImage: this.texImageA,
        uFrame: this.texImage,
        uDecay: 1.0 - Math.exp(-vargs.ACF_DECAY),
      }, this.texImageB);

      [this.texImageA, this.texImageB] =
        [this.texImageB, this.texImageA];
    }

    if (output != GpuFrameBuffer.DUMMY) {
      this.downsampler.exec({
        uImage: this.texImageA,
      }, output);
    }
  }
}

class GpuACF3 {
  constructor(webgl, { size }) {
    this.size = size;
    this.fft = new GpuFFT(webgl, { width: size, height: 1, layout: 'rows' });
    this.fft_w = new GpuFFT(webgl, { width: size, height: size, layout: 'rows' });
    this.fft_h = new GpuFFT(webgl, { width: size, height: size, layout: 'cols' });

    this.wave1 = new GpuFrameBuffer(webgl, { width: size, height: 1 });
    this.wave2 = new GpuFrameBuffer(webgl, { width: size, height: 1, channels: 2 });
    this.img1 = new GpuFrameBuffer(webgl, { size, channels: 2 });
    this.img2 = new GpuFrameBuffer(webgl, { size, channels: 2 });

    this.conjugate = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;
        void main() {
          vec2 u = texture(uInput, vTex).xy;
          v_FragColor = vec4(u.x, -u.y, 0.0, 0.0);
        }
      `,
    });

    this.scalar = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;
        uniform vec2 uZ;

        void main() {
          vec2 u = texture(uInput, vTex).xy;
          v_FragColor = vec4(dot(u, uZ), 0.0, 0.0, 0.0);
        }
      `,
    });

    this.bispectrum = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uFFT;
        const float N = ${size}.0;

        ${complexMath}

        vec2 fft(int k) {
          return texelFetch(uFFT, ivec2(k, 0), 0).xy;
        }

        void main() {
          ivec2 r = ivec2(vTex * N - 0.5);

          vec2 rx = fft(r.x);
          vec2 ry = fft(r.y);
          vec2 rxy = fft(r.x + r.y);
          vec2 bs = imul(imul(rx, ry), iconj(rxy));

          v_FragColor = vec4(bs, 0.0, 0.0);
        }
      `,
    });
  }

  exec({ uWaveFormRaw }, uTarget) {
    if (uTarget.width != this.size || uTarget.height != this.size)
      throw new Error('ACF3 output must be a NxN buffer');
    if (uWaveFormRaw.length != this.size)
      throw new Error('ACF3 waveform must have N samples');
    this.wave1.source = uWaveFormRaw;
    this.fft.exec({ uInput: this.wave1 }, this.wave2);
    this.bispectrum.exec({ uFFT: this.wave2 }, this.img1);

    this.conjugate.exec({ uInput: this.img1 }, this.img2);
    this.fft_w.exec({ uInput: this.img2 }, this.img1);
    this.fft_h.exec({ uInput: this.img1 }, this.img2);
    this.conjugate.exec({ uInput: this.img2 }, this.img1);

    this.scalar.exec({ uInput: this.img1, uZ: [1, 0] }, uTarget);
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { size, sigma }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        const float N = ${size}.0;
        const float N_SIGMA = float(${sigma});
        const float PI = ${Math.PI};
        const vec4 COLOR_1 = vec4(1.0, 2.0, 4.0, 1.0);
        const vec4 COLOR_2 = vec4(4.0, 2.0, 1.0, 1.0);

        uniform bool uFlat;
        uniform sampler2D uData;
        uniform sampler2D uStats;

        ${colorUtils}

        ${shaderUtils}

        ${textureUtils}

        float h_acf(vec2 vTex) {
          float h = textureSmooth(uData, vTex).x;
          vec4 stats = texture(uStats, vec2(0.5));
          return h / (N_SIGMA * stats.w);
        }

        vec4 hcolor_2(float h) {
          float s = sign(h) * 0.5 + 0.5;
          vec4 rgb = mix(COLOR_2, COLOR_1, s);
          return clamp(abs(h) * rgb, 0.0, 1.0);
        }

        vec4 rgba(vec2 vTex) {
          float r = length(v);
          float a = atan(v.y, v.x) / PI * 0.5;
          float h = h_acf(vec2(r, a));
          return hcolor_${vargs.ACF_COLOR_SCHEME}(h);
        }

        void main () {
          v_FragColor = rgba(vTex);
        }
      `,
    });
  }
}

class GpuRecorder extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uImage;
        uniform sampler2D uFrame;
        uniform float uDecay;

        void main() {
          vec4 prev = texture(uImage, vTex);
          vec4 next = texture(uFrame, vTex);
          v_FragColor = mix(next, prev, uDecay);
        }
      `,
    });
  }
}
