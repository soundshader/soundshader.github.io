import { GpuTransformProgram } from "../../../webgl/transform.js";
import { shaderUtils } from "./basics.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

export class GpuSpectrogramProgram {
  constructor(webgl, { size, maxFreq }) {
    this.webgl = webgl;
    this.buffer1 = new GpuFrameBuffer(webgl, { size, channels: 2 });
    this.buffer2 = new GpuFrameBuffer(webgl, { size, channels: 2 });
    this.buffer3 = new GpuFrameBuffer(webgl, { size, channels: 2 });
    this.buffer4 = new GpuFrameBuffer(webgl, { size, channels: 2 });
    this.recorder = new GpuRecorder(webgl, { size });
    this.accumulator = new GpuAccumulator(webgl, { size });
    this.colorizer = new GpuColorizer(webgl, { maxFreq });
  }

  exec({ uFFT, uTime, uMaxTime, uMousePos }, output) {
    [this.buffer1, this.buffer2] =
      [this.buffer2, this.buffer1];

    /* [this.buffer3, this.buffer4] =
      [this.buffer4, this.buffer3];

    this.accumulator.exec({
      uPrev: this.buffer3,
      uFFT,
    }, this.buffer4); */

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

class GpuAccumulator extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uPrev;
        uniform sampler2D uFFT;

        const float PI = ${Math.PI};
        const float N = float(${size});

        // u * exp(2*pi*i*t)
        vec2 c2mul(vec2 u, float t) {
          float phi = 2.0 * PI * t;
          float c = cos(phi);
          float s = sin(phi);
          float re = u.x * c - u.y * s;
          float im = u.x * s + u.y * c;
          return vec2(re, im);
        }

        vec2 c2pol(vec2 ra) {
          return ra.x * vec2(cos(ra.y), sin(ra.y));
        }

        vec2 c2dec(vec2 u) {
          return vec2(length(u), atan(u.y, u.x));
        }

        void main() {
          float w = round(vTex.x * N - 0.5); // 0..N-1
          vec2 Xw = c2pol(texture(uPrev, vTex).xy);
          vec2 x0 = c2pol(texture(uPrev, vec2(0.5 / N, vTex.y)).xy);
          vec2 xN = c2pol(vec2(texture(uFFT, vec2(0.5, vTex.y)).xy));
          vec2 Yw = c2mul(Xw - x0, w / N) + c2mul(xN, w / N - w);
          v_FragColor = vec4(c2dec(Yw), 0.0, 0.0);
        }
      `,
    });
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl, { maxFreq }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;
        uniform vec2 uMousePos;
        uniform float uTime;
        uniform float uMaxTime;
        uniform float uTimeStep;

        const float PI = ${Math.PI};
        const float MAX_FREQ = float(${maxFreq});
        const float C4_NOTE = 220.0 * pow(2.0, 0.25);

        ${shaderUtils}

        float getSoundFreq(float y) {
          float f = pow(2.0, y * 9.0) * 27.5 / MAX_FREQ;
          return clamp(f, 0.0, 1.0);
        }

        float getFreqLine(float y) {
          float n = float(textureSize(uInput, 0).y);
          float f1 = getSoundFreq(y + 1.0 / n);
          float f0 = getSoundFreq(y - 1.0 / n);
          float s1 = log2(f1 * MAX_FREQ / C4_NOTE);
          float s0 = log2(f0 * MAX_FREQ / C4_NOTE);

          return mod(s1, 1.0) > mod(s0, 1.0) ? 0.0 :
            s1 * s0 >= 0.0 ? 0.25 : 1.0;
        }

        float getTimeLine(float x) {
          if (uTimeStep == 0.0) return 0.0;
          float n = float(textureSize(uInput, 0).x);
          float dt = uTimeStep / uMaxTime;
          float t1 = x + uTime;
          float t0 = t1 - 1.0 / n;
          return mod(t1, dt) < mod(t0, dt) ?
            0.25 : 0.0;
        }

        vec3 getPhaseColor(float vol, float arg, float my) {
          float hue = arg / PI * 0.5 + 0.5;
          float val = pow(vol, exp(-2.0 * my));
          float sat = 1.0;
          return vec3(hue, sat, val);
        }

        vec3 getVolumeColor(float vol, float arg, float my) {
          float hue = clamp(1.0 - vol, 0.0, 1.0) * 5.0 / 6.0;
          float val = pow(vol, exp(-2.0 * my));
          float sat = 1.0;
          return vec3(hue, sat, val);
        }        

        void main () {
          float mx = uMousePos.x;
          float my = uMousePos.y;

          float freq = getSoundFreq(vTex.y);

          vec2 pix = texture(uInput, vec2(vTex.x, freq)).xy;
          float vol = pix.x;
          float arg = pix.y;

          vec3 hsv = mix(
            getPhaseColor(vol, arg, my),
            getVolumeColor(vol, arg, my),
            mx * 0.5 + 0.5);

          // this draws a horizontal line every uFreqStep
          float freqLine = getFreqLine(vTex.y);
          float timeLine = getTimeLine(vTex.x);

          if (max(timeLine, freqLine) > 0.0) {
            hsv.z = max(timeLine, freqLine);
            hsv.y = 0.0;
          }

          vec3 rgb = hsv2rgb(hsv);
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}
