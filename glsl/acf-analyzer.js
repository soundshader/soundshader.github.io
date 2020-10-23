import { GpuTransformProgram } from "../../../webgl/transform.js";
import { shaderUtils } from "./basics.js";
import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

export class GpuWaveformProgram extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uACF; // (re, im)
        uniform sampler2D uFFT; // (re, im)
        uniform vec2 uMousePos;

        const float PI = ${Math.PI};
        const float N = float(2 * ${size});

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
          float a = atan(v.y, v.x) / PI * 0.5 + 0.25;
          float h = h_acf(a) / h_acf(0.0) * 0.5 + 0.5;

          float val = r > h ? 0.0 : 0.5 * exp(-50.0 * pow(r - h, 2.0));
          float hue = fft_phase(a) / PI * 0.5;
          float sat = 1.0;
          
          vec3 hsv = vec3(hue, sat, val);
          return hsv2rgb(hsv);
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

        void main () {
          if (length(v) > 1.0) discard;
          vec3 rgb = rgb_sampled(v, 2);
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });

    // canvas = size x size
    // FFT = 2*size x (re, im)
    // ACF = 2*size x (re)

    this.temp = new Float32Array(size * 4);
    this.fftData = new Float32Array(size * 4);
    this.acfData = new Float32Array(size * 4);

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
  }

  exec(args, output) {
    FFT.forward(args.uWaveForm, this.fftData);
    FFT.sqr_abs_reim(this.fftData, this.temp);
    FFT.forward(this.temp, this.acfData);

    super.exec({
      ...args,
      uFFT: this.fftBuffer,
      uACF: this.acfBuffer,
    }, output);
  }
}
