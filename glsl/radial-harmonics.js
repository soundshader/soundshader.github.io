import { GpuMultiPassProgram } from "../webgl/multipass-program.js";
import { shaderUtils } from "./basics.js";

const LAYERS = 8;
const LOOKUPS = 2;

export class GpuRadialHarmonicsProgram extends GpuMultiPassProgram {
  constructor(webgl, { size, maxFreq }) {
    super(webgl, {
      size,
      layers: LAYERS,
      layerShader: `
        in vec2 v;
          
        uniform sampler2D uFFT; // 1 x FFT size
        uniform int uLayerIndex;

        const float PI = ${Math.PI};
        const float N_FFT = float(${size});
        const float MAX_FREQ = float(${maxFreq});
        const float MIN_FREQ = 55.0;

        float r_to_w(float r) {
          return 1.0 - sqrt(1.0 - r * r * 0.25);
        }

        void main () {
          float r = length(v);
          float arg = atan(v.y, v.x);
          if (r > 1.0) discard;

          float sum = 0.0;

          for (int k = 0; k < ${LOOKUPS}; k++) {
            int h_num = 1 + uLayerIndex * ${LOOKUPS} + k; // harmonic number
            float f_freq = r_to_w(r); // fundamental frequency
            float h_freq = f_freq * float(h_num); // harmonic frequency
            if (f_freq < MIN_FREQ / MAX_FREQ || h_freq > 1.0) break;

            vec2 fft = texture(uFFT, vec2(0.5, h_freq)).xy;
            float volume = fft.x;
            float phase = fft.y;

            float r_freq = floor(h_freq * N_FFT); // radial frequency of the pattern
            sum += volume * cos(r_freq * (arg + phase));
          }

          v_FragColor = vec4(sum);
        }      
      `,
      colorShader: `
        in vec2 vTex;

        uniform vec2 uMousePos;
        uniform sampler2D uInput;

        ${shaderUtils}

        vec3 volume_rgb(float vol) {
          if (vol == 0.0) return vec3(0.0);

          float a = exp(uMousePos.x * 3.0);
          float b = exp(uMousePos.y * 3.0);
          
          float val = clamp(log(abs(vol)) * a + b, 0.0, 1.0);
          float hue = val;

          return hsv2rgb(vec3(hue, 1.0, val));
        }
      
        void main () {
          float a = exp(uMousePos.x * 3.0);
          float b = exp(uMousePos.y * 3.0);

          float vol = texture(uInput, vTex).x;
          vec3 rgb = volume_rgb(vol);
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}
