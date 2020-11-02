import { GpuTransformProgram } from "../../../webgl/transform.js";
import { shaderUtils } from "./basics.js";
import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import * as conf from "../vargs.js";

export class GpuWaveformProgram extends GpuTransformProgram {
  constructor(webgl, { size, imgSize }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uACF; // (re, im)
        uniform sampler2D uFFT; // (re, im)
        uniform sampler2D uRGBA;
        uniform sampler2D uBins; // imgSize x 1
        uniform float uMaxBins;
        uniform vec2 uMousePos;

        const float PI = ${Math.PI};
        const float N = float(2 * ${size});
        const vec3 COLOR = vec3(1.0, 2.0, 4.0);
        const float DECAY = 1.0 - exp(-float(${conf.ACF_EXP}));

        ${shaderUtils}

        vec4 textureSmooth(sampler2D tex, float y) {
          float ds = fract(y*N + 0.5)/N; // y=0..1
          return mix(
            texture(tex, vec2(0.5, y - ds)),
            texture(tex, vec2(0.5, y - ds + 1.0/N)),
            1.0 - ds);
        }

        float h_acf(float a) {
          return textureSmooth(uACF, a).x;
        }

        float fft_energy(float a) {
          vec2 fft = textureSmooth(uFFT, a).xy;
          return dot(fft, fft);
        }

        float fft_phase(float a) {
          vec2 fft = textureSmooth(uFFT, a).xy;
          return atan2(fft.y, fft.x);
        }

        vec3 rgb_color(vec2 v) {
          float r = length(v);
          float a = atan2(v.y, v.x) / PI * 0.5 - 0.25;
          float h = h_acf(a) / h_acf(0.0);
          float s = h * 0.5 + 0.5;

          float val = exp(-300.0 * (r - s) * (r - s));
          vec3 color = mix(COLOR, COLOR.bgr,
            sign(h) * 0.5 + 0.5);

          return clamp(val * color, 0.0, 1.0);
        }

        vec3 rgb_sampled(vec2 v, int samples) {
          vec3 rgb = vec3(0.0);

          for (int i = 0; i < samples; i++) {
            vec2 dv = vec2(
              rand(float(i + 1)*3.0) - 0.5,
              rand(float(i + 1)*5.0) - 0.5);
            rgb += rgb_color(v + dv/N);
          }

          return rgb / float(samples);
        }

        vec4 rgba_1(vec2 vTex) {
          vec3 next = rgb_sampled(vTex * 2.0 - 1.0, 2);
          vec3 prev = texture(uRGBA, vTex).rgb;
          vec3 rgb = mix(next, prev, DECAY);
          return vec4(rgb, 1.0);
        }

        vec4 rgba_2(vec2 vTex) {
          float h = texture(uBins, vec2(vTex.x, 0.5)).x;
          float s = sign(h / uMaxBins - vTex.y) * 0.5 + 0.5;
          vec3 c = vTex.x > 0.5 ? 
            vec3(1.0, 0.5, 0.2) :
            vec3(0.2, 0.5, 1.0);
          return vec4(s * c, 1.0);
        }

        void main () {
          v_FragColor = max(vTex.x, vTex.y) < 0.2 ?
            rgba_2(vTex * 5.0) : rgba_1(vTex);
        }
      `,
    });

    this.copy = new GpuTransformProgram(webgl);

    // canvas = size x size
    // FFT = 2*size x (re, im)
    // ACF = 2*size x (re)

    this.temp = new Float32Array(size * 4);
    this.fftData = new Float32Array(size * 4);
    this.acfData = new Float32Array(size * 4);
    this.acfBins = new Float32Array(imgSize);
    this.maxBins = 0;

    this.rgba1 = new GpuFrameBuffer(webgl, {
      size: imgSize,
      channels: 4,
    });

    this.rgba2 = new GpuFrameBuffer(webgl, {
      size: imgSize,
      channels: 4,
    });

    this.acfBuffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size * 2,
      channels: 2, // (re, im)
      source: this.acfData,
    });

    this.fftBuffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size * 2,
      channels: 2, // (re, im)
      source: this.fftData,
    });

    this.binsBuffer = new GpuFrameBuffer(webgl, {
      width: this.acfBins.length,
      height: 1,
      source: this.acfBins,
    });
  }

  updateACF(uWaveFormRaw) {
    FFT.expand(uWaveFormRaw, this.temp);
    FFT.forward(this.temp, this.fftData);
    FFT.sqr_abs_reim(this.fftData, this.temp);
    FFT.forward(this.temp, this.acfData);
  }

  updateBins() {
    let bins = this.acfBins;
    let acf = this.acfData;

    for (let i = 0; i < acf.length / 2; i++) {
      let re = acf[2 * i];
      let x = re / conf.ACF_ABS_MAX * 0.5 + 0.5;
      let m = Math.floor(x * bins.length);

      if (m < 0 || m >= bins.length)
        continue;

      bins[m]++;

      this.maxBins = Math.max(
        this.maxBins, bins[m]);
    }
  }

  exec(args, output) {
    if (args.uWaveFormRaw) {
      this.updateACF(args.uWaveFormRaw);
      this.updateBins();

      [this.rgba1, this.rgba2] =
        [this.rgba2, this.rgba1];

      super.exec({
        ...args,
        uMaxBins: this.maxBins,
        uBins: this.binsBuffer,
        uFFT: this.fftBuffer,
        uACF: this.acfBuffer,
        uRGBA: this.rgba1,
      }, this.rgba2);
    }

    this.copy.exec({
      uInput: this.rgba2,
    }, output);
  }
}
