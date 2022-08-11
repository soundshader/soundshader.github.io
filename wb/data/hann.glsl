uniform sampler2D uInput;

const float PI = 3.141592653589;

float hann(float x) {
  float s = sin(PI * x);
  return x > 0.0 && x < 1.0 ? s * s : 0.0;
}

vec4 eval() {
  float N = float(textureSize(uInput, 0).y);
  float hw = hann(vTex.y - 0.5 / N);
  return hw * texture(uInput, vTex);
}
