import { GpuTransformProgram } from "../webgl/transform.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

export class GpuPatternAudioProgram {
  constructor(webgl, { size, maxFreq }) {
    this.webgl = webgl;
    this.samples = 6; // must be a divisor of 12
    this.buffer = new GpuFrameBuffer(webgl, { size });
    this.pattern = new GpuPatternProgram(webgl, { maxFreq, samples: this.samples });
    this.colorizer = new GpuColorizerProgram(webgl);

  }

  exec({ uFFT, uMousePos }, output) {
    this.buffer.clear();
    let gl = this.webgl.gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // The C4 note, aka "middle C".
    let base = 440 * 2.0 ** 0.25;

    // These 7 octaves from 55 Hz to 7 kHz usually
    // contain all the audible sound. Music usually
    // uses a very narrow band around 440 Hz. Birds
    // often get to high frequencies, but even wren
    // doesn't go above note A8 (7040 Hz).
    for (let k = -2; k < 4; k++) {
      // GPU doesn't like shaders that do 10+ texture
      // lookups. Things work much faster if lookups
      // are split into individual shader calls that
      // do only few lookups. However GPU doesn't like
      // too many shader calls either, so there's an
      // optimal number of texture lookups per call,
      // which is usually around 4-6.
      let n = 12 / this.samples;

      for (let i = 0; i < n; i++) {
        this.pattern.exec({
          uFFT,
          uMousePos,
          uFreqLo: base * 2 ** (k + i / n),
          uFreqHi: base * 2 ** (k + (i + 1) / n),
        }, this.buffer);
      }
    }

    gl.disable(gl.BLEND);

    this.colorizer.exec({
      uInput: this.buffer,
      uMousePos,
    }, output);
  }
}

class GpuPatternProgram extends GpuTransformProgram {
  constructor(webgl, { maxFreq, samples }) {
    super(webgl, {
      fshader: `
        in vec2 v;
        
        uniform sampler2D uFFT; // 1 x FFT size
        uniform float uFreqLo; // e.g. 220 Hz
        uniform float uFreqHi; // e.g. 440 Hz

        const float PI = ${Math.PI};
        const float MAX_FREQ = float(${maxFreq});
        const float FREQ_MOD = 15.0;
        const float FREQ_EXP = 200.0;
        const int SAMPLES = ${samples};

        float freqShape(vec2 v, float freq, float phase) {
          float s1 = ceil(freq / FREQ_MOD);
          float s2 = ceil(1e3 / freq);
          float r0 = pow(freq / MAX_FREQ, 0.2);

          float r = length(v);
          float a = atan(v.y, v.x);

          return cos(a*s1 + phase) * sin(PI*r*s2)
            * exp(-FREQ_EXP * pow(r - r0, 2.0));
        }

        float sumShape(vec2 v) {
          float sum = 0.0;

          for (int i = 0; i < SAMPLES; i++) {
            float freq_log = mix(
              log2(uFreqLo), log2(uFreqHi),
              float(i) / float(SAMPLES));
            float freq = pow(2.0, freq_log);
            vec2 tex = texture(uFFT, vec2(0.5, freq / MAX_FREQ)).xy;
            float vol = tex.x;
            float arg = tex.y;
            sum += vol * freqShape(v, freq, arg);
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
  constructor(webgl) {
    super(webgl, {
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
