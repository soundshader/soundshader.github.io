import { GpuMultiPassProgram } from "../webgl/multipass-program.js";
import { shaderUtils } from "./basics.js";

const LAYERS = 64;

export class GpuPolarHarmonicsProgram extends GpuMultiPassProgram {
  constructor(webgl, { size, maxFreq }) {
    super(webgl, {
      size,
      layers: LAYERS,
      layerShader: `
        in vec2 v;
          
        uniform sampler2D uFFT; // 1 x FFT size
        uniform vec2 uMousePos;
        uniform int uLayerIndex;

        const float H_NUM = 30.0;
        const float PI = ${Math.PI};
        const float N_FFT = float(${size});
        const float MAX_FREQ = float(${maxFreq});
        const float MIN_FREQ = 55.0;
        const float W_MIN = log2(MIN_FREQ / MAX_FREQ);
        const float W_MAX = log2(MAX_FREQ / MAX_FREQ);

        float w_to_y(float w) {
          return (log2(w) - W_MIN) / (W_MAX - W_MIN);
        }

        float volume_sdb(float vol) {
          if (vol <= 0.0) return 0.0;
          return max(0.0, (log(vol) + 8.203) / 9.032);
        }

        void main () {
          float r = length(v);
          float arg = atan(v.y, v.x);
          float sum = 0.0;
          float w = float(1 + uLayerIndex) / float(${2 * LAYERS});
          float radius = w_to_y(w);

          float vol_0 = texture(uFFT, vec2(0.5, w)).x;
          float sdb = volume_sdb(vol_0);
          if (sdb < 0.01) discard;

          for (float k = 1.0; k <= H_NUM; k += 1.0) {
            float h_freq = w * k;
            if (h_freq > 1.0) break;

            vec2 fft = texture(uFFT, vec2(0.5, h_freq)).xy;
            float vol = fft.x;
            float phase = fft.y;

            sum += volume_sdb(vol) / k * cos(arg * k + phase);
          }

          float a = exp((1.0 + uMousePos.x) * 5.0);
          float b = exp((uMousePos.y - 1.0) * 5.0);
          float d = sdb * exp(-a * abs(r - (1.0 + b * sum) * radius));

          v_FragColor = vec4(d);
        }      
      `,
      colorShader: `
        in vec2 vTex;

        uniform sampler2D uInput;

        void main () {
          float sum = texture(uInput, vTex).x;
          v_FragColor = vec4(vec3(sum), 1.0);
        }
      `,
    });
  }
}
