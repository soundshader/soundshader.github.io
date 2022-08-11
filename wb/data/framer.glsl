uniform sampler2D uInput;
uniform int uOffsetMin;
uniform int uOffsetMax;

const int INT_MAX = 0x7FFFFFFF;

vec4 eval() {
  int F = uOutputWidth;
  int N = uOutputHeight;

  ivec2 size = textureSize(uInput, 0);
  ivec2 pos = ivec2(vTex * vec2(ivec2(F, N)) - 0.5);
  int span = uOffsetMax - uOffsetMin; // up to size.x * size.y

  // Make sure this doesn't overflow int32.
  int diff = span < INT_MAX / pos.x ?
    span * pos.x / (F - 1) :
    span / (F - 1) * pos.x;
    
  int t = uOffsetMin + diff + pos.y;
  int i = t / (4 * size.x);
  int j = t % (4 * size.x);

  if (t < 0 || t >= size.x * size.y * 4) {
    return vec4(0.0);
  }

  vec4 tex = texelFetch(uInput, ivec2(j / 4, i), 0);
  return vec4(tex[j % 4], 0.0, 0.0, 0.0);
}
