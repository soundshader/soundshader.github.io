import { GpuMultiPassProgram } from "../webgl/multipass-program.js";
import { shaderUtils } from "./basics.js";

const LAYERS = 16;
const LOOKUPS = 16;

export class GpuZTransformProgram extends GpuMultiPassProgram {
  constructor(webgl, { size, maxFreq }) {
    super(webgl, {
      size,
      channels: 2,
      layers: LAYERS,
      layerShader: `
        in vec2 v;
          
        uniform sampler2D uFFT; // 1 x FFT size
        uniform int uLayerIndex;

        const float N = float(${LAYERS * LOOKUPS});
        const float M = 8.0;

        void main () {
          float r = 1.0 * length(v);
          float arg = atan(v.y, v.x);
          float re = 0.0, im = 0.0;

          for (int k = 0; k < ${LOOKUPS}; k++) {
            int h = uLayerIndex * ${LOOKUPS} + k;
            float w = (float(h) + 0.5) / N;

            vec2 fft = texture(uFFT, vec2(0.5, w)).xy;
            float vol = fft.x;
            float phase = fft.y;

            float num = -floor(float(h) / N * M);
            float mag = vol * pow(r, num);
            float phi = phase + arg * num;

            re += mag * cos(phi);
            im += mag * sin(phi);
          }

          v_FragColor = vec4(re, im, 0.0, 0.0);
        }      
      `,
      colorShader: `
        in vec2 vTex;

        uniform vec2 uMousePos;
        uniform sampler2D uInput;

        const float PI = ${Math.PI};

        ${shaderUtils}

        float volume_sdb(float vol) {
          if (vol <= 0.0) return 0.0;
          return max(0.0, (log(vol) + 8.203) / 9.032);
        }

        void main () {
          float a = exp(uMousePos.x * 10.0);
          float b = exp(uMousePos.y * 10.0);

          vec2 sum = texture(uInput, vTex).xy;

          float vol = length(sum);
          float arg = atan(sum.y, sum.x);

          vec3 rgb = vec3(abs(mod(vol, a)) < b ? 1.0 : 0.0);

          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}
