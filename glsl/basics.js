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

export const shaderUtils = `
  // All components are in the range 0..1, including hue.
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
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
