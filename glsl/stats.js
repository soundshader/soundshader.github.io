import { GpuTransformProgram, GpuFrameBuffer } from "../webgl2.js";

// en.wikipedia.org/wiki/Algorithms_for_calculating_variance
//
//  vec4 s = texture(uStats, vec2(0.0));
//  s.x = min, s.y = max, s.z = avg, s.w = stddev
//
// Input: NxNx1 texture. Must be a square.
export class GpuStatsProgram extends GpuTransformProgram {
  constructor(webgl, { size, prep }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;

        const int N = ${size}; // the top level texture size

        uniform sampler2D uData;
        uniform vec4 uMask;

        int size() {
          return textureSize(uData, 0).x;
        }

        ${prep || `float prep(vec4 t) { return dot(t, uMask); }`}

        vec4 fetch(vec2 v) {
          vec4 s = texture(uData, v);
          if (size() < N/2) return s;
          float d = prep(s);
          return vec4(d, d, d, 0.0);
        }

        vec4 merge(vec4 p, vec4 q, float n) {
          float d = p.z - q.z;
          return vec4(
            min(p.x, q.x),
            max(p.y, q.y),
            mix(p.z, q.z, 0.5),
            p.w + q.w + d*d*n*0.5);
        }

        vec4 stats(vec2 v) {
          int n = size();
          float m = pow(float(N/n), 2.0);

          // uData is 2x bigger than the output texture, so
          // vTex is precisely between the 4 uData pixels.

          vec2 dx = vec2(1.0, 0.0) / float(n);
          vec2 dy = vec2(0.0, 1.0) / float(n);

          vec4 s1 = fetch(v + dx + dy);
          vec4 s2 = fetch(v - dx - dy);
          vec4 s3 = fetch(v + dx - dy);
          vec4 s4 = fetch(v - dx + dy);

          vec4 s12 = merge(s1, s2, m);
          vec4 s34 = merge(s3, s4, m);

          return merge(s12, s34, m*2.0);
        }

        void main () {
          vec4 s = stats(vTex);
          if (size() == 4) {
            // m2 -> stddev
            s.w = sqrt(s.w) / float(N);
          }
          v_FragColor = s;
        }
      `,
    });

    this.size = size;
    this.mipmaps = [];

    for (let i = 0; 2 ** i < size; i++)
      this.mipmaps[i] = new GpuFrameBuffer(webgl,
        { size: 2 ** i, channels: 4 });

    this.output = this.mipmaps[0]; // 1x1x4
  }

  exec({ uData, uMask = [1, 0, 0, 0] }, output = this.output) {
    let a = this.mipmaps;
    let n = a.length + 1;

    for (let i = 0; i < n - 1; i++) {
      let src = i == 0 ? uData : a[n - i - 1];
      let res = i == n - 2 ? output : a[n - i - 2];
      super.exec({ uData: src, uMask }, res);
    }

    return output;
  }
}

// Same as the GpuStatsProgram, but for Nx1x1 inputs (i.e. height=1).
export class GpuStatsFlat extends GpuTransformProgram {
  constructor(webgl, { width }) {
    super(webgl, {
      fshader: `
        in vec2 vTex;
        const int N = ${width}; // the top level texture size
        uniform sampler2D uData;

        int size() {
          return textureSize(uData, 0).x;
        }

        vec4 fetch(vec2 v) {
          vec4 s = texture(uData, v);
          return size() < N/2 ? s : vec4(s.xxx, 0.0);
        }

        vec4 merge(vec4 p, vec4 q, float n) {
          float d = p.z - q.z;
          return vec4(
            min(p.x, q.x),
            max(p.y, q.y),
            mix(p.z, q.z, 0.5),
            p.w + q.w + d*d*n*0.5);
        }

        vec4 stats(vec2 v) {
          int n = size();
          float m = float(N/n);

          // uData is 2x bigger than the output texture, so
          // vTex is precisely between the 4 uData pixels.

          vec2 dx = vec2(1.0, 0.0) / float(n);
          vec4 s1 = fetch(v + dx);
          vec4 s2 = fetch(v - dx);
          return merge(s1, s2, m);
        }

        void main () {
          vec4 s = stats(vTex);
          if (size() == 4)
            // m2 -> stddev
            s.w = sqrt(s.w) / float(N);
          v_FragColor = s;
        }
      `,
    });

    this.mipmaps = [];

    for (let i = 0; 2 ** i < width; i++)
      this.mipmaps[i] = new GpuFrameBuffer(webgl,
        { width: 2 ** i, height: 1, channels: 4 });

    this.output = this.mipmaps[0]; // 1x1x4
  }

  exec({ uData }, output = this.output) {
    let a = this.mipmaps;
    let n = a.length + 1;

    for (let i = 0; i < n - 1; i++) {
      let src = i == 0 ? uData : a[n - i - 1];
      let res = i == n - 2 ? output : a[n - i - 2];
      super.exec({ uData: src }, res);
    }
  }
}