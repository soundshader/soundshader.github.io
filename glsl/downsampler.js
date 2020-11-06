import { GpuTransformProgram } from "../webgl/transform.js";
import { GpuFrameBuffer } from "../webgl/framebuffer.js";

class GpuDownsampler1x2 extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 v;
        in vec2 vTex;

        uniform sampler2D uImage;

        const float A = 1.0 / 6.0;
        const float B = 4.0 / 6.0;
        const float C = 1.0 / 6.0;

        vec4 rgba(int i) {
          return texelFetch(uImage, ivec2(0, i), 0);
        }

        void main () {
          int n = textureSize(uImage, 0).y;
          int i = int(vTex.y * float(n) - 0.5);

          vec4 a = A * rgba(i - 1);
          vec4 b = B * rgba(i);
          vec4 c = C / 6.0 * rgba(i + 1);

          v_FragColor = a + b + c;
        }
      `,
    });
  }
}

class GpuDownsampler2x2 extends GpuTransformProgram {
  constructor(webgl) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        uniform sampler2D uImage;

        const float A = 1.0 / 6.0;
        const float B = 4.0 / 6.0;
        const float C = 1.0 / 6.0;

        const ivec2 dx = ivec2(1, 0);
        const ivec2 dy = ivec2(0, 1);

        vec4 rgba(ivec2 v) {
          return texelFetch(uImage, v, 0);
        }

        vec4 xavg(ivec2 v) {
          vec4 a = A * rgba(v - dx);
          vec4 b = B * rgba(v);
          vec4 c = C * rgba(v + dx);

          return a + b + c;
        }

        vec4 yavg(ivec2 v) {
          vec4 a = A * xavg(v - dy);
          vec4 b = B * xavg(v);
          vec4 c = C * xavg(v + dy);

          return a + b + c;
        }

        void main () {
          ivec2 size = textureSize(uImage, 0);
          ivec2 v = ivec2(vTex * vec2(size) - 0.5);
          v_FragColor = yavg(v);
        }
      `,
    });
  }
}

export class GpuDownsampler {
  constructor(webgl, { width, height, channels, aa }) {
    if (!(aa >= 0 && aa == Math.floor(aa)))
      throw new Error('Invalid downsampler AA: ' + aa);
    this.aa = aa;
    this.shader = width == 1 ?
      new GpuDownsampler1x2(webgl) :
      new GpuDownsampler2x2(webgl);
    this.copy = new GpuTransformProgram(webgl);
    this.buffers = [];

    for (let i = 0; i < aa - 1; i++) {
      this.buffers[i] = new GpuFrameBuffer(webgl, {
        channels,
        width: Math.max(1, width >> (i + 1)),
        height: Math.max(1, height >> (i + 1)),
      });
    }
  }

  exec({ uImage }, target) {
    let aa = this.aa;

    if (!aa) {
      this.copy.exec({ uInput: uImage }, target);
      return;
    }

    for (let i = 0; i < aa; i++) {
      let input = this.buffers[i - 1] || uImage;
      let output = this.buffers[i] || target;
      this.shader.exec({ uImage: input }, output);
    }
  }
}
