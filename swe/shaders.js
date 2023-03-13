import * as glsl_basics from '/glsl/basics.js';

window.IMG_SIZE = 1024;
window.FREQ = 1.5;
window.K2 = Math.log10(0.00007); // kinematic viscosity: low values = water, high values = glue
window.SPEC = -3; // positive = reflective specularity, negative = wave height
window.STEPS = 10;
window.DT = 1.0;
window.G0 = 0.5;
window.G1 = 0.1; // low values are better for complex patterns
window.G1_R = 15;
window.H_GREEN = 1e6;
window.SW_H = 0.15; // mean height
window.SW_F = Math.log10(1.5e-6); // Coriolis coefficient, makes fluid spin
window.SW_B = Math.log10(3.2e-4); // viscous drag, high values = glue

export const WAVE_UTILS_SHADER = `
  const float PI = ${Math.PI};
  const float N = ${IMG_SIZE}.0;

  struct NBH {
    vec4 c, l, r, t, b;
    float dx, dy;
  };

  vec4 tex(sampler2D uWave, vec2 vTex, int dx, int dy) {
    vec2 p = vTex + vec2(ivec2(dx, dy)) / N;
    // klein bottle 2d manifold
    if (p.y < 0.0) { p.y += 1.0; p.x *= -1.0; }
    if (p.y > 1.0) { p.y -= 1.0; p.x *= -1.0; }
    return texture(uWave, p);
  }

  NBH get_nbh(sampler2D uWave, vec2 vTex) {
    float dx = 1.0; // / (1.0 + 0.1 * cos((vTex.x * 2.0 - 1.0) * PI));
    float dy = 1.0; // / (1.0 - 0.1 * cos((vTex.y * 2.0 - 1.0) * PI));

    return NBH(
      tex(uWave, vTex, 0, 0),
      tex(uWave, vTex, -1, 0),
      tex(uWave, vTex, 1, 0),
      tex(uWave, vTex, 0, -1),
      tex(uWave, vTex, 0, 1),
      dx, dy);
  }

  vec4 diff_x(NBH nbh, float dx) {
    return 0.5/dx * (nbh.r - nbh.l);
  }

  vec4 diff_y(NBH nbh, float dy) {
    return 0.5/dy * (nbh.t - nbh.b);
  }
`;

export const WAVE_SHADER = `
  in vec2 v;
  in vec2 vPos;
  in vec2 vTex;

  uniform sampler2D uWave;
  uniform int uTime;
  uniform float uFreq;
  uniform float uG0;
  uniform float uG1;
  uniform float uK2;
  uniform float uSW_F;
  uniform float uSW_B;
  uniform float uSW_H;
  uniform float uDT;

  ${WAVE_UTILS_SHADER}

  const float DX = 1.0 / N;
  const float DY = 1.0 / N;
  const float DT = 1.0 / N;
 
  vec4 laplacian5(NBH nb, float dx, float dy) {
    return 1.0/dx/dx * (nb.r + nb.l - 2.0 * nb.c)
      + 1.0/dy/dy * (nb.t + nb.b - 2.0 * nb.c);
  }

  float H() {
    return uSW_H; // * (1.1 - 0.1 * smoothstep(0.5, 0.6, length(vPos)));
  }

  // (h + H) * uv
  vec2 hH_uv(vec4 q) {
    return (H() + q.x) * q.yz;
  }

  mat2 grad_hH_uv(NBH nb) {
    return 0.5 * mat2(
      hH_uv(nb.r) - hH_uv(nb.l),
      hH_uv(nb.t) - hH_uv(nb.b));
  }

  mat2 grad_uv(NBH nb, float dx, float dy) {
    return mat2(diff_x(nb, dx).yz, diff_y(nb, dy).yz);
  }

  // https://en.wikipedia.org/wiki/Shallow_water_equations
  // tex() = (h, u, v, 0)
  vec4 shallow_water5(float g) {
    NBH nb = get_nbh(uWave, vTex);
    float dx = nb.dx / N;
    float dy = nb.dy / N;
    vec4 w0 = nb.c;
    vec2 uv = w0.yz;
    float h_x = diff_x(nb, dx).x;
    float h_y = diff_y(nb, dy).x;
    // float32 precision: 24 bits (1/16,000,000)
    // with N=1024, 1/(N*N)=1e-6 leaves only 4 bits
    vec2 uv_xxyy = laplacian5(nb, dx * N, dy * N).yz;
    mat2 bf_fb = mat2(uSW_B, uSW_F, -uSW_F, uSW_B);

    // Continuity equation:
    // -h_t = div((H+h)*uv)
    //
    mat2 g_hHuv = grad_hH_uv(nb);
    float dh = 0.0
      - 1.0/dx * g_hHuv[0].x
      - 1.0/dy * g_hHuv[1].y;

    vec2 duv = uK2*N*N * uv_xxyy
      - (bf_fb + grad_uv(nb, dx, dy)) * uv
      - g * vec2(h_x, h_y);

    return w0 + uDT*DT*vec4(dh, duv, 0.0);
  }

  // h'' = k2 (h_xx + h_yy) - b h' - f h + g
  // tex = (h(t), h(t-1), 0, 0)
  //
  vec4 damped_wave(float g) {
    NBH nb = get_nbh(uWave, vTex);
    float h_xxyy = uK2 * laplacian5(nb, 1.0, 1.0).x;
    
    float r1 = 1.0 + uSW_B * DT * 0.5;
    float r2 = 1.0 - uSW_B * DT * 0.5;
    float r3 = 2.0 - uSW_F * DT * DT;
    float r4 = g * DT * DT;

    float h0 = nb.c.y;
    float h1 = nb.c.x;
    float h2 = (r3 * h1 + h_xxyy - r2 * h0 + r4) / r1;

    return vec4(h2, h1, 0.0, 0.0);
  }

  float g_force() {
    float t = float(uTime) * uDT*DT * uFreq * 2.0 * ${Math.PI};
    float d = 1.0 - smoothstep(0.0, float(${G1_R}), length(v));
    return uG0 + d * uG1 * sin(t);
  }

  void main() {
    float d = 1.0; // - step(1.0, length(v));
    v_FragColor = d * damped_wave(g_force());
  }
`;

const DRAW_SHADER_INC = `
  ${WAVE_UTILS_SHADER}

  // The normal vector to the h(x,y)-z=0
  // surface is (dh/dx, dh/dy, -1). The
  // complexities account for the hex grid.
  //
  vec3 h_grad(float spec, vec2 vTex) {
    NBH nb = get_nbh(uWave, vTex);
    float dx = diff_x(nb, nb.dx).x;
    float dy = diff_y(nb, nb.dy).x;
    vec2 dh = spec * 0.5 * N * vec2(dx, dy);
    return vec3(dh.x, dh.y, -1.0);
  }

  vec3 surf_norm(float spec, vec2 vTex) {
    float lt = texture(uWave, vTex).x;
    float lb = texture(uWave, vTex + vec2(0.0, 1.0) / N).x;
    float rb = texture(uWave, vTex + vec2(1.0, 1.0) / N).x;
    float rt = texture(uWave, vTex + vec2(1.0, 0.0) / N).x;
    float hz = 0.5 * N * spec;
    float hx = hz * (rt + rb - lt - lb);
    float hy = hz * (rt - rb + lt - lb);
    vec3 uv = vec3(hx, hy, -1.0);
    return uv / length(uv);
  }
`;

export const DRAW_VSHADER = `
  in vec2 aPosition;

  out vec2 vTex; // 0..1
  out vec2 vPos; // 0..1
  out vec2 v; // -1 .. +1
  out vec4 vColor;

  uniform float uRand;
  uniform sampler2D uWave;

  ${DRAW_SHADER_INC}

  ${glsl_basics.colorUtils}

  vec2 project_reflection(vec3 uv) {
    vec3 norm = uv / length(uv);
    float h = texture(uWave, vTex).x;
    vec3 src = vec3(v, h);
    float t = (75.0 - src.z) / norm.z;
    return (src + t * norm).xy;
  }

  void main () {
    v = aPosition;
    vPos = v;
    vTex = v * 0.5 + 0.5;
    vec3 uv = h_grad(1.0, vTex);
    float area_du_dv = length(uv);
    vec2 res = project_reflection(uv);
    float alpha = 1.0 - step(1.0, max(abs(res.x), abs(res.y)));
    vec3 rgb = hue2rgb(length(v)/1.5);
    vColor = vec4(rgb, alpha / area_du_dv);
    gl_Position = vec4(res, 0.0, 1.0);
  }
`;

export const DRAW_FSHADER = `
  in vec2 v;
  in vec2 vTex;
  in vec2 vPos;
  in vec4 vColor;

  uniform sampler2D uWave;

  ${DRAW_SHADER_INC}

  uniform float uRand;
  uniform float uSpec;
  uniform float uHGreen;

  const vec3 SUN = vec3(4.0, 2.0, 1.0);
  const vec3 SKY = vec3(1.0, 2.0, 4.0);

  vec2 torus_vTex() {
    float r2 = 0.5;
    float r1 = (length(vPos) - 1.0) / (2.0 * r2) + 1.0;

    if (r1 < 0.0 || r1 > 1.0) discard;

    float a1 = atan(vPos.y, vPos.x) / PI + 1.0; // -1..1
    float a2 = acos(1.0 - r1 / r2) / PI; // 0..1

    return vec2(a1*0.5, a2 - a1*0.25);
  }

  vec3 reflection() {
    vec3 norm = surf_norm(uSpec, vTex);
    float s = abs(norm.z);
    vec3 sun = SUN * smoothstep(0.9, 1.0, s);
    vec3 sky = SKY * min(smoothstep(0.0, 0.5, s), 1.0 - smoothstep(0.5, 1.0, s));
    return sun * 1.0 + sky * 1.0;
  }

  float flat_wave() {
    return tex(uWave, vTex, 0, 0).x;
  }

  void main() {
    float h = flat_wave();

    if (abs(h) > uHGreen) {
      v_FragColor = vec4(0.0, 1.0, 0.0, 1.0);
      return;
    }

    v_FragColor = uSpec > 0.0 ?
      vec4(reflection(), 1.0) :
      abs(h * uSpec) * vec4(mix(SUN, SKY, sign(h) * 0.5 + 0.5), 1.0);
  }
`;

export const INIT_SHADER = `
  in vec2 v;

  uniform float uX;
  uniform float uY;

  ${glsl_basics.shaderUtils}

  void main() {
    vec2 vd = vec2(1.0, 1.5);
    vec2 v0 = vec2(uX, 1.0 - uY) * 2.0 - 1.0;
    float d = 15.0 * length((v - v0) * vd);
    float h = 1.0 - smoothstep(0.0, 1.0, d);
    vec2 uv = 1e2 * cross(vec3(0.0, 0.0, 1.0), vec3(v, 0.0)).xy;

    // float32 accuracy is up to 1/16,000,000
    // h += 0.25e-6 * (gold_noise(v) - 0.5);
    uv *= 0.0;

    v_FragColor = 1e-3 * vec4(h, h * uv, 0.0);
  }
`;

export const MIX_SHADER = `
  in vec2 vTex;

  uniform sampler2D uA;
  uniform sampler2D uB;
  uniform float uX;

  void main() {
    v_FragColor = mix(texture(uA, vTex), texture(uB, vTex), uX);
  }
`;
