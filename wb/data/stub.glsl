uniform sampler2D uInput;

vec4 eval() {
  return texture(uInput, vTex);
}
