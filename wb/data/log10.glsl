uniform sampler2D uInput;
uniform sampler2D uStats;
uniform float uLog10;

vec4 eval() {
  vec4 s = texture(uStats, vec2(0.0));
  vec4 t = texture(uInput, vTex) * vec4(1.0, 1.0, 0.0, 0.0);
  float db10 = log2(length(t) / length(s.xy)) / log2(10.0);
  return vec4(db10 / uLog10 + 1.0);
}
