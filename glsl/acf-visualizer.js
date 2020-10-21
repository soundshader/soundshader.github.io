import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { shaderUtils } from "./basics.js";

export class GpuAcfVisualizerProgram {
  constructor(webgl, { size }) {
    this.webgl = webgl;
    this.image1 = new GpuFrameBuffer(webgl, { size: size * 2 });
    this.image2 = new GpuFrameBuffer(webgl, { size: size * 2 });
    this.recorder = new GpuRecorder(webgl, { size: size * 2 });
    this.colorizer = new GpuColorizer(webgl, { size: size * 2 });

    // canvas = size x size
    // FFT = 2*size x (re, im)
    // ACF = 2*size x (re)

    this.temp1 = new Float32Array(size * 4);
    this.temp2 = new Float32Array(size * 4);
    this.reData = new Float32Array(size * 2);
    this.buffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size * 2,
      source: this.reData,
    });
  }

  exec({ uWaveForm, uMousePos }, output) {
    FFT.forward(uWaveForm, this.temp1);
    FFT.sqr_abs_reim(this.temp1, this.temp2);
    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    FFT.forward(this.temp2, this.temp1);
    FFT.re(this.temp1, this.reData);

    [this.image1, this.image2] =
      [this.image2, this.image1];

    this.recorder.exec({
      uImage: this.image1,
      uSlice: this.buffer,
    }, this.image2);

    this.colorizer.exec({
      uMousePos,
      uACF: this.image2,
    }, output);
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;
        in vec2 v;

        uniform sampler2D uACF;
        uniform vec2 uMousePos;

        const float N = float(${size});
        const float PI = ${Math.PI};
        const float SPEED = 0.1;

        ${shaderUtils}

        // maps ACF from -inf..inf to -1..1
        // phi = 0..1, no need to do mod()
        float h_acf(float phi) {
          float r = length(v);
          float t = 1.0 - r * SPEED;
          return texture(uACF, vec2(t, phi)).x;
        }

        // 1st derivative: h_acf'(phi)
        float dh_acf(float phi) {
          float h1 = h_acf(phi - 1.0 / N);
          float h2 = h_acf(phi + 1.0 / N);
          return (h2 - h1) * N * 0.5;
        }

        void main () {
          vec2 m = uMousePos;

          float a = atan(v.y, v.x) / PI * 0.5 - 0.25;
          float h = h_acf(a);
          float dh = dh_acf(a);

          float h_tanh = tanh(h * 20.0 * exp(m.y * 10.0));
          float dh_tanh = tanh(dh * 0.06 * exp(m.x * 10.0));

          float hue = 0.7 * (h_tanh * 0.5 + 0.5);
          float val = 1.0 - abs(dh_tanh);
          float sat = 1.0;

          val *= abs(h_tanh);

          vec3 hsv = vec3(hue, sat, val);
          vec3 rgb = hsv2rgb(hsv) * exp(-3.5 * dot(v, v));
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}

// Saves all vertical slices into a 2D buffer.
class GpuRecorder extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uImage;
        uniform sampler2D uSlice;

        const float N = float(${size});

        void main() {
          float dx = 1.0 / N;
          v_FragColor = vTex.x > 1.0 - 1.0 * dx ?
            texture(uSlice, vec2(0.5, vTex.y)) :
            texture(uImage, vTex + vec2(dx, 0.0));
        }
      `,
    });
  }
}
