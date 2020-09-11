import { GpuTransformProgram } from "../../../webgl/transform.js";
import { shaderUtils } from "./basics.js";

export class GpuSpectrogramProgram extends GpuTransformProgram {
  constructor(glctx) {
    super(glctx, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;
        uniform vec2 uMousePos;
        uniform vec2 uSize; // x = maxtime, y = maxfreq
        uniform float uTime;
        uniform float uMaxTime; // seconds
        uniform float uTimeStep; // seconds
        uniform float uHalfRange; // 440/22.5k
        uniform float uMaxFreq; // ~22.5 kHz

        const float PI = ${Math.PI};

        ${shaderUtils}

        float getSoundTime(float x) {
          return x - 1.0 + uTime;
        }

        // maps vTex.y=0..1 to uInput[0..1]
        float getSoundFreq(float y) {
          y = clamp(y, 0.0, 1.0);
          return pow(y, 4.0);
        }

        float getFreqLine(float y) {
          float n = uSize.y;
          float freq1 = getSoundFreq(min(1.0, y + 1.0 / n));
          float freq0 = getSoundFreq(max(0.0, y - 1.0 / n));
          float s1 = log2(freq1 / uHalfRange);
          float s0 = log2(freq0 / uHalfRange);

          // A bright line at 440 Hz or the A4 piano note,
          // and a grey line at each Ai note = 2**k * 440 Hz.
          return mod(s1, 1.0) > mod(s0, 1.0) ? 0.0 :
            s1 * s0 > 0.0 ? 0.25 : 1.0;
        }

        float getTimeLine(float time) {
          float dt = uTimeStep/uMaxTime;
          float time0 = getSoundTime(vTex.x - 1.0/uSize.x);
          return mod(time, dt) < mod(time0, dt) ?
            0.25 : 0.0;
        }

        void main () {
          float mx = uMousePos.x;
          float my = uMousePos.y;

          float time = getSoundTime(vTex.x);
          float freq = getSoundFreq(vTex.y);

          vec2 pix = texture(uInput, vec2(time, freq)).xy;
          float vol = pix.x;
          float arg = pix.y;

          float hue = arg / PI * 0.5 + 0.5;
          float val = exp((vol - exp(mx*3.0)) * exp(my*3.0));
          float sat = 1.0;

          // this draws a horizontal line every uFreqStep
          float freqLine = getFreqLine(vTex.y);
          float timeLine = getTimeLine(time);

          if (max(timeLine, freqLine) > 0.0) {
            val = max(timeLine, freqLine);
            sat = 0.0;
          }

          vec3 hsv = vec3(hue, sat, val);
          vec3 rgb = hsv2rgb(hsv);

          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}
