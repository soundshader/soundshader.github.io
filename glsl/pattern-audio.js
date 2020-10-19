import { GpuMultiPassProgram } from "../webgl/multipass-program.js";

// GPU doesn't like shaders that do 10+ texture
// lookups. Things work much faster if lookups
// are split into individual shader calls that
// do only few lookups. However GPU doesn't like
// too many shader calls either, so there's an
// optimal number of texture lookups per call,
// which is usually around 4-6.
const SAMPLES = 12; // must be a divisor of 12
const BASE_FREQ = 440; // the A4 note
// These 7 octaves from 55 Hz to 7 kHz usually
// contain all the audible sound. Music usually
// uses a very narrow band around 440 Hz. Birds
// often get to high frequencies, but even wren
// doesn't go above note A8 (7040 Hz).
const MIN_OCTAVE = -2;
const MAX_OCTAVE = +4;

export class GpuPatternAudioProgram extends GpuMultiPassProgram {
  constructor(webgl, { size, maxFreq }) {
    super(webgl, {
      size,
      layers: (MAX_OCTAVE - MIN_OCTAVE + 1) * 12 / SAMPLES,
      layerShader: `
        in vec2 v;
          
        uniform sampler2D uFFT; // 1 x FFT size
        uniform float uLayerIndex;
        uniform vec2 uMousePos;

        const float N = float(${size});
        const float PI = ${Math.PI};
        const float MIN_FREQ = 55.0;
        const float MAX_FREQ = float(${maxFreq});
        const float FREQ_EXP = 200.0;
        const int SAMPLES = ${SAMPLES};

        float vol_sdb(float vol) {
          if (vol <= 0.0) return 0.0;
          return max(0.0, (log(vol) + 8.203) / 9.032);
        }  

        float freqShape(float freq, float phase) {
          float s1 = ceil(freq / MAX_FREQ * N / 2.0);
          float s2 = 20.0;
          float r0 = pow(freq / MAX_FREQ, 0.2);

          float r = length(v);
          float a = atan(v.y, v.x);

          return cos(s1 * (a + phase)) * cos(s2 * (r - r0))
            * exp(-FREQ_EXP * pow(r - r0, 2.0));
        }

        float sumShape() {
          float n = 12.0 / float(SAMPLES);
          float k = floor(uLayerIndex / n) + float(${MIN_OCTAVE});
          float m = mod(uLayerIndex, n);
          
          float freqLo = pow(2.0, (k + (m + 0.0) / n)) * float(${BASE_FREQ});
          float freqHi = pow(2.0, (k + (m + 1.0) / n)) * float(${BASE_FREQ});

          float sum = 0.0;

          for (int i = 0; i < SAMPLES; i++) {
            float freq_log = mix(
              log2(freqLo), log2(freqHi),
              float(i) / float(SAMPLES));
            float freq = pow(2.0, freq_log);

            vec2 tex = texture(uFFT, vec2(0.5, freq / MAX_FREQ)).xy;
            float vol = tex.x;
            float arg = tex.y;
            sum += vol_sdb(vol) * freqShape(freq, arg);
          }

          return sum / float(SAMPLES);
        }
      
        void main () {
          if (length(v) >= 1.0)
            discard;
          float sum = sumShape();
          v_FragColor = vec4(sum);
        }      
      `,
      colorShader: `
        in vec2 vTex;

        uniform vec2 uMousePos;
        uniform sampler2D uInput;

        const vec3 COLOR = vec3(4.0, 2.0, 1.0);
      
        void main () {
          float a = 1.0; // exp(uMousePos.x * 3.0);
          float b = 1.0; // exp(uMousePos.y * 3.0);

          float sum = texture(uInput, vTex).x;
          float val = 1.0 - exp(-pow(abs(sum), a) * b);
          vec3 rgb = val * COLOR;
          v_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
  }
}
