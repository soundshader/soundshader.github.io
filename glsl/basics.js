export const colorUtils = `
  vec3 hsl2rgb(vec3 hsl) {
    // const float PI_2 = ${2 * Math.PI};
    // const vec2 R = vec2(1.0, 0.0);
    // const vec2 G = vec2(cos(PI_2/3.0), sin(PI_2/3.0));
    // const vec2 B = vec2(G.x, -G.y);
    // vec2 a = vec2(cos(hsl.x * PI_2), sin(hsl.x * PI_2));
    // vec3 rgb = vec3(dot(R, a), dot(G, a), dot(B, a));

    vec3 rgb = vec3(
      abs(hsl.x * 6.0 - 3.0) - 1.0,
      2.0 - abs(hsl.x * 6.0 - 2.0),
      2.0 - abs(hsl.x * 6.0 - 4.0));

    rgb = clamp(rgb, 0.0, 1.0);

    float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
    rgb = (rgb - 0.5) * c + hsl.z;

    return clamp(rgb, 0.0, 1.0);
  }

  vec3 hsv2rgb(vec3 c) {
    const vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  vec3 hue2rgb(float hue) {
    return hsv2rgb(vec3(hue, 1.0, 1.0));
  }
`;

export const shaderUtils = `
  const float PI = ${Math.PI};
  const float PHI = 1.61803398874989484820459;
  const float SEED = ${1e3 * Math.random()};

  // output: 0..1
  float gold_noise(in vec2 xy){
    return fract(tan(distance(xy * PHI, xy + 0.32) * SEED) * xy.x * (1.2 + xy.y));
  }

  // output: 0..1
  float rand(float seed) {
    return fract(sin((seed + 0.4627) * 12.9898) * 43758.5453);
  }

  float atan2(float y, float x) {
    return abs(x) > abs(y) ?
      atan(y, x) : ${Math.PI / 2} - atan(x, y);
  }

  // |x| < 1 -> |y| < 1
  float gain(float x, float w) {
    float h = max(0.0, 1.0 - abs(x));
    float a = pow(h, w);
    return -sign(x) * (a - 1.0);
  }

  // 0..1 -> 0..1
  float gain2(float x, float w) {
    return gain(x * 2.0 - 1.0, w) * 0.5 + 0.5;
  }

  float min3(float x, float y, float z) {
    return min(min(x, y), z);
  }

  float sqr(float x) {
    return x * x;
  }

  float log10(float x) {
    const float log2_10 = log2(10.0);
    return log2(x) / log2_10;
  }

  float hann(float x) {
    float s = sin(${Math.PI} * x);
    return x > 0.0 && x < 1.0 ? s * s : 0.0;
  }

  float hann_step(float x, float a, float b) {
    return x < a ? 0.0 : x > b ? 1.0 : hann((x - a) / (b - a) * 0.5);
  }

  float gauss(float x, float sigma) {
    const float SQRT_2PI = ${Math.sqrt(2 * Math.PI)};
    return exp(-0.5 * sqr(x / sigma)) / (SQRT_2PI * sigma);
  }

  // i=0..n, length(x, y) < 1.0
  vec2 fibb_spiral(int i, int n) {
    float x = fract(float(i) / PHI);
    float y = float(i) / float(n);
    float r = sqrt(y);
    float a = 2.0 * PI * x;
    return r * vec2(cos(a), sin(a));
  }
`;

export const textureUtils = `
  vec4 textureSmooth(sampler2D tex, vec2 ptr) {
    vec2 nxy = vec2(textureSize(tex, 0));
    vec2 p = ptr * nxy - 0.5;
    vec2 s = fract(p);

    vec2 p00 = floor(p);
    vec2 p11 = ceil(p);
    vec2 p01 = vec2(p00.x, p11.y);
    vec2 p10 = vec2(p11.x, p00.y);

    vec4 t00 = texture(tex, (p00 + 0.5)/nxy);
    vec4 t01 = texture(tex, (p01 + 0.5)/nxy);
    vec4 t11 = texture(tex, (p11 + 0.5)/nxy);
    vec4 t10 = texture(tex, (p10 + 0.5)/nxy);

    vec4 t0 = mix(t00, t01, s.y);
    vec4 t1 = mix(t10, t11, s.y);
    return mix(t0, t1, s.x);
  }

  float sqr_cos(float x) {
    float c = cos(x * PI * 0.5);
    return c * c;
  }

  vec4 textureGauss(sampler2D tex, vec2 vTex) {
    vec2 ts = vec2(textureSize(tex, 0));
    vec2 v1 = vTex * ts - 0.5;    // 0..N-1
    ivec2 v0 = ivec2(floor(v1));  // 0..N-1
    vec2 dv = v1 - vec2(v0);      // 0..1
    const ivec2 dx = ivec2(1, 0);
    const ivec2 dy = ivec2(0, 1);
    vec4 lt = texelFetch(tex, v0, 0);
    vec4 rt = texelFetch(tex, v0 + dx, 0);
    vec4 lb = texelFetch(tex, v0 + dy, 0);
    vec4 rb = texelFetch(tex, v0 + dx + dy, 0);
    float wl = sqr_cos(dv.x);
    float wr = sqr_cos(1.0 - dv.x);
    float wt = sqr_cos(dv.y);
    float wb = sqr_cos(1.0 - dv.y);
    float wlb = wl * wb;
    float wrb = wr * wb;
    float wlt = wl * wt;
    float wrt = wr * wt;
    return (wlt * lt + wrt * rt + wlb * lb + wrb * rb) / (wlt + wrt + wlb + wrb);
  }
`;

export const complexMath = `
  vec2 imul(vec2 a, vec2 b) {
    float re = a.x * b.x - a.y * b.y;
    float im = a.x * b.y + a.y * b.x;
    return vec2(re, im);
  }

  vec2 iconj(vec2 a) {
    return vec2(a.x, -a.y);
  }

  vec2 idiv(vec2 a, vec2 b) {
    return imul(a, iconj(b)) / dot(b, b);
  }
`;
