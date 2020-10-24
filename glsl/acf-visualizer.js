import { FFT } from "../audio/fft.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";
import { GpuTransformProgram } from "../webgl/transform.js";
import { shaderUtils, textureUtils } from "./basics.js";
import { GpuStatsProgram } from "./stats.js";

export class GpuAcfVisualizerProgram {
  constructor(webgl, { size }) {
    this.webgl = webgl;
    this.image1 = new GpuFrameBuffer(webgl, { size: size * 2 });
    this.image2 = new GpuFrameBuffer(webgl, { size: size * 2 });

    this.recorder = new GpuRecorder(webgl, { size: size * 2 });
    this.heightMap = new GpuHeightMapProgram(webgl, { size });
    this.gradMap = new GpuGradientProgram(webgl, { size });
    this.stats = new GpuStatsProgram(webgl, { size });
    this.colorizer = new GpuColorizer(webgl);
    this.mixer = new GpuMixer(webgl);

    this.heightMapStats = new GpuFrameBuffer(webgl, { size, channels: 4 });
    this.gradMapStats = new GpuFrameBuffer(webgl, { size, channels: 4 });
    this.heightMapRGBA = new GpuFrameBuffer(webgl, { size, channels: 4 });
    this.gradMapRGBA = new GpuFrameBuffer(webgl, { size, channels: 4 });

    // canvas = size x size
    // FFT = 2*size x (re, im)
    // ACF = 2*size x (re)

    this.gpuACF = new GpuACF(webgl, { size: size * 2 });

    this.acfBuffer = new GpuFrameBuffer(webgl, {
      width: 1,
      height: size * 2,
    });
  }

  exec({ uWaveForm, uMousePos }, output) {
    this.gpuACF.exec({ uWaveForm }, this.acfBuffer);

    [this.image1, this.image2] =
      [this.image2, this.image1];

    let [mx, my] = uMousePos;
    let zoom = 1.0 + Math.exp(my * 5.0);
    let balance = mx * 0.5 + 0.5;

    this.recorder.exec({
      uImage: this.image1,
      uSlice: this.acfBuffer,
    }, this.image2);

    this.heightMap.exec({
      uZoom: zoom,
      uACF: this.image2,
    });

    if (balance > 0.01) {
      this.stats.exec({
        uData: this.heightMap.output,
      }, this.heightMapStats);

      this.colorizer.exec({
        uColor: [1, 2, 4],
        uAverage: 1,
        uHeightMap: this.heightMap.output,
        uHeightMapStats: this.heightMapStats,
      }, this.heightMapRGBA);
    }

    if (balance < 0.99) {
      this.gradMap.exec({
        uACF: this.heightMap.output,
      });

      this.stats.exec({
        uData: this.gradMap.output,
      }, this.gradMapStats);

      this.colorizer.exec({
        uColor: [4, 2, 1],
        uAverage: 0,
        uHeightMap: this.gradMap.output,
        uHeightMapStats: this.gradMapStats,
      }, this.gradMapRGBA);
    }

    this.mixer.exec({
      uBalance: balance,
      uImage1: this.gradMapRGBA,
      uImage2: this.heightMapRGBA,
    }, output);
  }
}

class GpuACF {
  constructor(webgl, { size }) {
    this.size = size;
    this.fft = new FFT(size, { webgl });

    let width = this.fft.shader.width;
    let height = this.fft.shader.height;

    this.temp = new Float32Array(size * 2);
    this.temp1 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });
    this.temp2 = new GpuFrameBuffer(webgl, { width, height, channels: 2 });

    this.sqrabs = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;
        void main() {
          vec2 z = texture(uInput, vTex).xy;
          v_FragColor = vec4(dot(z, z), 0.0, 0.0, 0.0);
        }
      `,
    });

    this.justre = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform sampler2D uInput;
        void main() {
          float re = texture(uInput, vTex).x;
          v_FragColor = vec4(re, 0.0, 0.0, 0.0);
        }
      `,
    });

    this.reshape = new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uInput;

        void main() {
          ivec2 size = textureSize(uInput, 0);
          int i = int(vTex.y * float(size.x * size.y) - 0.5);
          int x = i % size.x;
          int y = i / size.x;
          v_FragColor = texelFetch(uInput, ivec2(x, y), 0);
        }
      `,
    });
  }

  exec({ uWaveForm }, uACF) {
    if (uACF.width != 1 || uACF.height != this.size)
      throw new Error('ACF output must be a 1xN buffer');
    this.fft.transform(uWaveForm, this.temp2);
    this.sqrabs.exec({ uInput: this.temp2 }, this.temp1);
    // In general, ACF[X] needs to do inverseFFT[S]
    // here, but since S is real and ACF[X] is also
    // real, inverseFFT here is equivalent to FFT.
    this.fft.transform(this.temp1, this.temp2);
    this.justre.exec({ uInput: this.temp2 }, this.temp1);
    this.reshape.exec({ uInput: this.temp1 }, uACF);
  }
}

// Maps ACF values to a disk height map.
class GpuHeightMapProgram extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      size,
      fshader: `
        in vec2 v;

        uniform sampler2D uACF;
        uniform float uZoom;

        const float N = float(${size});
        const float PI = ${Math.PI};

        ${textureUtils}

        float h_acf(float a) {
          float r = length(v);
          float t = 1.0 - r * 0.5 / uZoom;
          return textureSmooth(uACF, vec2(t, a)).x;
        }

        void main () {
          float a = atan(v.y, v.x) / PI * 0.5;
          float h = h_acf(a - 0.25);
          v_FragColor = vec4(h);
        }
      `,
    });
  }
}

class GpuGradientProgram extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      size,
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uACF;

        const float N = float(${size});
        const vec2 DX = vec2(1.0/N, 0.0);
        const vec2 DY = vec2(0.0, 1.0/N);

        float fetch(vec2 vTex) {
          return texture(uACF, vTex).x;
        }

        float grad(vec2 vTex) {
          float h1 = fetch(vTex - DX);
          float h2 = fetch(vTex + DX);
          float h3 = fetch(vTex - DY);
          float h4 = fetch(vTex + DY);

          float d1 = fetch(vTex + DX - DY);
          float d2 = fetch(vTex + DX + DY);
          float d3 = fetch(vTex - DX + DY);
          float d4 = fetch(vTex - DX - DY);

          float gx1 = (h2 - h1) * 0.5;
          float gy1 = (h4 - h3) * 0.5;
          float gx2 = (d2 - d4) * 0.5 / sqrt(2.0);
          float gy2 = (d1 - d3) * 0.5 / sqrt(2.0);

          float g1 = sqrt(gx1*gx1 + gy1*gy1);
          float g2 = sqrt(gx2*gx2 + gy2*gy2);

          return (g1 + g2) * 0.5 * N;
        }

        void main () {
          float g = grad(vTex);
          v_FragColor = vec4(g);
        }
      `,
    });
  }
}

class GpuColorizer extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform vec3 uColor;
        uniform float uAverage;
        uniform sampler2D uHeightMap;
        uniform sampler2D uHeightMapStats;

        void main () {
          float h = texture(uHeightMap, vTex).x;
          vec4 stats = texture(uHeightMapStats, vec2(0.0));

          float h_min = stats.x; // -5*sigma
          float h_max = stats.y; // +5*sigma
          float h_avg = stats.z; // +/- 0.0
          float sigma = stats.w; // 0.3..0.5

          float val = abs(mix(h, h - h_avg, uAverage));
          vec3 rgb = uColor * val / 3.0 / sigma;
          v_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
        }
      `,
    });
  }
}

// Saves all vertical slices into a 2D buffer.
class GpuRecorder extends GpuTransformProgram {
  constructor(webgl, { size }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uImage;
        uniform sampler2D uSlice;

        const float N = float(${size});

        void main() {
          float dx = 1.0 / N;
          v_FragColor = vTex.x > 1.0 - 1.0 * dx ?
            texture(uSlice, vec2(0.5, vTex.y)) :
            texture(uImage, vTex + vec2(dx, 0.0));
        }
      `,
    });
  }
}

class GpuMixer extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uImage1;
        uniform sampler2D uImage2;
        uniform float uBalance;

        void main() {
          vec4 tex1 = texture(uImage1, vTex);
          vec4 tex2 = texture(uImage2, vTex);
          v_FragColor = mix(tex1, tex2, uBalance);
        }
      `,
    });
  }
}
