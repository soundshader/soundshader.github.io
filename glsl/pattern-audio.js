import { GpuTransformProgram } from "../webgl/transform.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

export class GpuPatternAudioProgram {
  constructor(webgl, { size }) {
    this.webgl = webgl;
    this.buffer = new GpuFrameBuffer(webgl, { size });
    this.pattern = new GpuPatternProgram(webgl);
    this.colorizer = new GpuColorizerProgram(webgl);
  }

  exec({ uFFT, uMaxFreq, uMousePos }, output) {
    this.buffer.clear();
    let gl = this.webgl.gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // These 7 octaves from 55 Hz to 7 kHz usually
    // contain all the audible sound. Music usually
    // uses a very narrow band around 440 Hz. Birds
    // often use high frequencies, but wren doesn't
    // go above note A8 (7040 Hz).
    for (let k = -2; k < 4; k++) {
      this.pattern.exec({
        uFFT,
        uMaxFreq,
        uMousePos,
        uFreqLo: 440 * 2 ** k,
        uFreqHi: 440 * 2 ** (k + 1),
      }, this.buffer);
    }

    gl.disable(gl.BLEND);

    this.colorizer.exec({
      uInput: this.buffer,
      uMousePos,
    }, output);
  }
}

class GpuPatternProgram extends GpuTransformProgram {
  constructor(glctx) {
    super(glctx, {
      fshader: `
        in vec2 v;
        
        uniform sampler2D uFFT; // 1 x FFT size
        uniform float uMaxFreq; // ~22.5 kHz
        uniform float uFreqLo; // e.g. 220 Hz
        uniform float uFreqHi; // e.g. 440 Hz

        const float PI = ${Math.PI};
        const int SAMPLES = 12;

        float freqShape(vec2 v, float freq, float phase) {
          float freq_mod = 15.0;
          float s1 = ceil(freq / freq_mod);
          float s2 = ceil(1e3 / freq);
          float r0 = pow(freq / uMaxFreq, 0.2);

          float r = length(v);
          float a = atan(v.y, v.x);

          return cos(a*s1 + phase) * sin(PI*r*s2)
            * exp(-250.0 * pow(r - r0, 2.0));
        }

        float sumShape(vec2 v) {
          float sum = 0.0;

          for (int i = 0; i < SAMPLES; i++) {
            float freq_log = mix(
              log2(uFreqLo), log2(uFreqHi),
              float(i) / float(SAMPLES));
            float freq = pow(2.0, freq_log);
            vec2 tex = texture(uFFT, vec2(0.5, freq / uMaxFreq)).xy;
            float mag = tex.x;
            float arg = tex.y;
            sum += mag * freqShape(v, freq, arg);
          }

          return sum / float(SAMPLES);
        }
      
        void main () {
          float sum = sumShape(v);
          v_FragColor = vec4(sum);
        }
      `,
    });
  }
}

class GpuColorizerProgram extends GpuTransformProgram {
  constructor(glctx) {
    super(glctx, {
      fshader: `
        in vec2 vTex;

        uniform vec2 uMousePos;
        uniform sampler2D uInput;

        const vec3 COLOR = vec3(4.0, 2.0, 1.0);
      
        void main () {
          float a = 0.45 * exp(uMousePos.x * 1.0);
          float b = 4.08 * exp(uMousePos.y * 1.0);

          float sum = texture(uInput, vTex).x;
          float val = 1.0 - exp(-pow(abs(sum), a) * b);
          v_FragColor = vec4(val * COLOR, 1.0);
        }
      `,
    });
  }
}
