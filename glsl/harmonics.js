import { GpuMultiPassProgram } from "../webgl/multipass-program.js";
import { shaderUtils } from "./basics.js";

export class GpuHarmonicsProgram extends GpuMultiPassProgram {
  constructor(webgl, { size, maxFreq }) {
    super(webgl, {
      size,
      layers: 1,
      layerShader: `
        in vec2 vTex;
          
        uniform sampler2D uFFT; // 1 x FFT size
        uniform vec2 uMousePos;

        const float MIN_AUDIBLE_FREQ = 55.0; // FFT with 1024 samples at 44.1 kHz
        const float MAX_FREQ = float(${maxFreq});
        const float W_MIN = log2(MIN_AUDIBLE_FREQ / MAX_FREQ);
        const float W_MAX = log2(MAX_FREQ / MAX_FREQ);        

        float y_to_w(float y) {
          return pow(2.0, mix(W_MIN, W_MAX, y));
        }

        void main () {
          float h_max = exp((1.0 + uMousePos.x) * 3.0);
          float h = ceil(vTex.x * h_max); // harmonic number
          float f_freq = y_to_w(vTex.y); // fundamental frequency
          float h_freq = f_freq * h; // harmonic frequency

          if (h_freq > 1.0) discard;

          float amp = texture(uFFT, vec2(0.5, h_freq)).x;
          v_FragColor = vec4(amp);
        }      
      `,
      colorShader: `
        in vec2 vTex;

        uniform sampler2D uInput;

        ${shaderUtils}

        float vol_to_sdb(float vol) {
          if (vol <= 0.0) return 0.0;
          return max(0.0, (log(vol) + 8.203) / 9.032);
        }

        vec3 sdb_to_hsv(float sdb) {
          float hue = (1.0 - min(sdb, 1.0)) * 5.0/6.0;
          return vec3(hue, 1.0, sdb);
        }

        void main () {
          float vol = texture(uInput, vTex).x;
          float sdb = vol_to_sdb(vol);
          vec3 hsv = sdb_to_hsv(sdb);
          v_FragColor = vec4(hsv2rgb(hsv), 1.0);
        }
      `,
    });
  }
}
