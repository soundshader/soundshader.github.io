import { GpuMultiPassProgram } from "../webgl/multipass-program.js";
import { shaderUtils } from "./basics.js";

const LAYERS = 16;
const LOOKUPS = 64;

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
        const float W_MIN = log2(MIN_FREQ / MAX_FREQ);
        const float W_MAX = log2(MAX_FREQ / MAX_FREQ);

        float y_to_w(float y) {
          return pow(2.0, mix(W_MIN, W_MAX, y));
        }        

        void main () {
          float r = length(v);
          float arg = atan(v.y, v.x);
          if (r > 1.0) discard;

          float sum = 0.0;

          for (int k = 0; k < ${LOOKUPS}; k++) {
            int h = 1 + uLayerIndex * ${LOOKUPS} + k; // harmonic number
            float f_freq = y_to_w(r); // fundamental frequency
            float h_freq = f_freq * float(h); // harmonic frequency
            if (f_freq < MIN_FREQ / MAX_FREQ || h_freq > 1.0) break;

            vec2 fft = texture(uFFT, vec2(0.5, h_freq)).xy;
            float volume = fft.x;
            float phase = fft.y;

            float r_freq = floor(h_freq * N_FFT); // radial frequency of the pattern
            float cos_arg = cos(r_freq * (arg + phase));
            sum += volume * cos_arg;
          }

          v_FragColor = vec4(sum);
        }      
      `,
      colorShader: `
        in vec2 vTex;

        uniform vec2 uMousePos;
        uniform sampler2D uInput;

        const vec3 COLOR = vec3(4.0, 2.0, 1.0);
        const float N = float(${LAYERS * LOOKUPS});

        ${shaderUtils}

        float volume_sdb(float vol) {
          if (vol <= 0.0) return 0.0;
          return max(0.0, (log(vol) + 8.203) / 9.032);
        }

        void main () {
          // float a = exp(uMousePos.x * 3.0);
          // float b = exp(uMousePos.y * 3.0);

          float vol = texture(uInput, vTex).x;
          float sdb = volume_sdb(vol);
          float hue = (1.0 - min(sdb, 1.0)) * 5.0/6.0;
          vec3 rgb = hsv2rgb(vec3(hue, 1.0, sdb));
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}
