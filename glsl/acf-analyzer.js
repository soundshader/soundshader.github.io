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

        uniform sampler2D uACF;
        uniform vec2 uMousePos;

        const float PI = ${Math.PI};
        const float N = float(2 * ${size});

        ${shaderUtils}

        // maps ACF from -inf..inf to -1..1
        // phi = 0..1, no need to do mod()
        float h_acf(float phi) {
          vec2 m = uMousePos;
          float acf = texture(uACF, vec2(0.5, phi)).x;
          return tanh(acf * exp(m.y * 9.0));
        }

        // 1st derivative: (d/dphi h_acf)(phi)
        float dh_acf(float phi) {
          float h1 = h_acf(phi - 1.0 / N);
          float h2 = h_acf(phi + 1.0 / N);
          return (h2 - h1) * N * 0.5;
        }

        void main () {
          vec2 m = uMousePos;

          float r = length(v);
          float a = atan(v.y, v.x) / PI * 0.5 - 0.25;

          float acf = texture(uACF, vec2(0.5, a)).x;
          float val = r < h_acf(a) * 0.5 + 0.5 ? 1.0 : 0.0;
          float hue = 0.8 * tanh(exp(m.x * 5.0) / abs(dh_acf(a)));

          vec3 hsv = vec3(hue, 1.0, val * 0.5);
          vec3 rgb = hsv2rgb(hsv);
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });

    // canvas = size x size
    // FFT = 2*size x (re, im)
    // ACF = 2*size x (re)

    this.acfOutputReIm = new Float32Array(size * 4);
    this.acfBufferData = new Float32Array(size * 2);
    this.acfBuffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size * 2,
      channels: 1,
      source: this.acfBufferData,
    });    
  }

  exec(args, output) {
    FFT.auto_cf(args.uWaveForm, this.acfOutputReIm);
    FFT.re(this.acfOutputReIm, this.acfBufferData);
    super.exec({ ...args, uACF: this.acfBuffer }, output);
  }
}
