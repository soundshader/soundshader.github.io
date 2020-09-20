import { GpuTransformProgram } from "../../../webgl/transform.js";
import { shaderUtils } from "./basics.js";

export class GpuChromagramProgram extends GpuTransformProgram {
  constructor(webgl, { maxFreq }) {
    super(webgl, {
      fshader: `
        in vec2 v;

        uniform sampler2D uFFT;

        const float PI = ${Math.PI};
        const float MAX_FREQ = float(${maxFreq});
        const float C5_NOTE = 440.0 * pow(2.0, 0.25);

        ${shaderUtils}      

        void main () {
          float r = length(v);
          float phi = atan(v.y, v.x);

          float m = (phi + PI) * 6.0 / PI; // 0..12
          float n = round((2.0 * r - 1.0) * 4.0); // -4 .. +4

          float freq = pow(2.0, n + m / 12.0) * C5_NOTE / MAX_FREQ;
          if (freq > 1.0) discard;

          vec2 fft = texture(uFFT, vec2(0.5, freq)).xy;
          float vol = fft.x;
          float arg = fft.y; // phase, -PI .. +PI

          vec3 hsv = vec3(0.0, 0.0, vol);
          vec3 rgb = hsv2rgb(hsv);
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}
