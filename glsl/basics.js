export const vShaderCopy = `
  in vec2 aPosition;

  out vec2 vTex; // 0..1
  out vec2 v; // -1 .. +1

  void main () {
      v = aPosition;
      vTex = v * 0.5 + 0.5;
      gl_Position = vec4(v, 0.0, 1.0);
  }
`;

export const fShaderCopy = `
  in vec2 vTex;
  uniform sampler2D uInput;

  void main () {
    v_FragColor = texture(uInput, vTex);
  }
`;

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
`;

export const shaderUtils = `
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
`;
