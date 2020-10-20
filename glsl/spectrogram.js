import { GpuTransformProgram } from "../../../webgl/transform.js";
import { shaderUtils } from "./basics.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

export class GpuSpectrogramProgram {
  constructor(webgl, { size, maxFreq }) {
    this.webgl = webgl;
    this.buffer1 = new GpuFrameBuffer(webgl, { size, channels: 2 });
    this.buffer2 = new GpuFrameBuffer(webgl, { size, channels: 2 });
    this.recorder = new GpuRecorder(webgl, { size });
    this.colorizer = new GpuColorizer(webgl, { size, maxFreq });
  }

  exec({ uFFT, uTime, uMaxTime, uMousePos }, output) {
    [this.buffer1, this.buffer2] =
      [this.buffer2, this.buffer1];

    this.recorder.exec({
      uInput: this.buffer1,
      uFFT,
    }, this.buffer2);

    this.colorizer.exec({
      uTimeStep: 1.0,
      uInput: this.buffer2,
      uMousePos,
      uTime,
      uMaxTime,
    }, output);
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { size, maxFreq }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;
        uniform vec2 uMousePos;
        uniform float uTime;
        uniform float uMaxTime;
        uniform float uTimeStep;

        const float N = float(${size});
        const float PI = ${Math.PI};
        const float A4_NOTE = 440.0;
        const float MIN_AUDIBLE_FREQ = 55.0; // FFT with 1024 samples at 44.1 kHz
        const float MAX_FREQ = float(${maxFreq});
        const float W_MIN = log2(MIN_AUDIBLE_FREQ / MAX_FREQ);
        const float W_MAX = log2(MAX_FREQ / MAX_FREQ);

        ${shaderUtils}

        float y_to_w(float y) {
          return pow(2.0, mix(W_MIN, W_MAX, y));
        }

        float w_to_y(float w) {
          return (log2(w) - W_MIN) / (W_MAX - W_MIN);
        }

        vec3 getFreqLine(float y) {
          float n = float(textureSize(uInput, 0).y);
          float a4 = A4_NOTE / MAX_FREQ;
          float w1 = y_to_w(y);
          float w2 = y_to_w(y + 1.0 / n);
          float s1 = log2(w1 / a4);
          float s2 = log2(w2 / a4);
          return s1 * s2 < 0.0 ? vec3(0.15, 1.0, 1.0) :
            mod(s2, 1.0) <= mod(s1, 1.0) ? vec3(0.15, 1.0, 0.2) :
              vec3(0.0);
        }

        vec3 getTimeLine(float x) {
          if (uTimeStep == 0.0) return vec3(0.0);
          float dt = uTimeStep / uMaxTime;
          float t1 = x + uTime;
          float t0 = t1 - 1.0 / N;
          float val = mod(t1, dt) < mod(t0, dt) ?
            0.25 : 0.0;
          return vec3(0.0, 0.0, val);
        }

        vec3 getToneLine(float y) {
          float w = y_to_w(0.5 + 0.5 * uMousePos.y);
          float n1 = y_to_w(y - 1.0 / N) / w;
          float n2 = y_to_w(y + 1.0 / N) / w;
          bool is_u = mod(n2, 1.0) < mod(n1, 1.0) && n2 < 20.0;
          bool is_d = mod(1.0/n2, 1.0) > mod(1.0/n1, 1.0) && n2 > 1.0/20.0;
          float val = is_u || is_d ? 0.25 : 0.0;
          return vec3(0.5, 1.0, val);
        }

        vec3 add_rulers(vec3 hsv) {
          // vec3 hsvTone = getToneLine(vTex.y);
          // if (hsvTone.z > 0.0) return hsvTone;

          vec3 hsvFreq = getFreqLine(vTex.y);
          if (hsvFreq.z > 0.0) return hsvFreq;

          vec3 hsvTime = getTimeLine(vTex.x);
          if (hsvTime.z > 0.0) return hsvTime;

          return hsv;
        }

        vec3 getPhaseColor(float vol, float arg) {
          float hue = arg / PI * 0.5 + 0.5;
          return vec3(hue, 1.0, vol);
        }

        vec3 getVolumeColor(float vol, float arg) {
          if (vol == 0.0) return vec3(0.0);
          float sdb = (log(vol) + 8.203) / 9.032;
          float hue = (1.0 - clamp(sdb, 0.0, 1.0)) * 5.0/6.0;
          return vec3(hue, 1.0, clamp(sdb, 0.0, 1.0));
        }        

        void main () {
          float freq = clamp(y_to_w(vTex.y), 0.0, 1.0);

          vec2 pix = texture(uInput, vec2(vTex.x, freq)).xy;
          float vol = pix.x;
          float arg = pix.y;

          vec3 hsv = false ?
            getPhaseColor(vol, arg) :
            getVolumeColor(vol, arg);

          hsv = add_rulers(hsv);

          vec3 rgb = hsv2rgb(hsv);
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}

// Saves all vertical FFT slices into a 2D buffer.
class GpuRecorder extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;
        uniform sampler2D uFFT;

        const float N = float(${size});

        void main() {
          float dx = 1.0 / N;
          v_FragColor = vTex.x > 1.0 - 1.0 * dx ?
            texture(uFFT, vec2(0.5, vTex.y)) :
            texture(uInput, vTex + vec2(dx, 0.0));
        }
      `,
    });
  }
}
