#include <emscripten.h>
#include <stdlib.h>
#define _USE_MATH_DEFINES
#include <math.h>

typedef struct _fft_data {
  int size;
  int* revidx;
  float* uroots;
} fft_data;

static fft_data this = { 0 };

EMSCRIPTEN_KEEPALIVE
void fft_close() {
  if (!this.size)
    return;
  this.size = 0;
  free(this.revidx);
  free(this.uroots);
}

EMSCRIPTEN_KEEPALIVE
void fft_init(int size) {
  fft_close();

  this.size = size;
  this.revidx = malloc(size * sizeof(this.revidx[0]));
  this.uroots = malloc(2 * size * sizeof(this.uroots[0]));

  // uroots[k] = exp(2*pi*k/n)
  for (int k = 0; k < size; k++) {
    float a = 2 * M_PI * k / size;
    this.uroots[2 * k] = cos(a);
    this.uroots[2 * k + 1] = sin(a);
  }

  for (int k = 0; k < size; k++) {
    int r = 0;
    for (int i = 0; (1 << i) < size; i++)
      r = (r << 1) | (k >> i) & 1;
    this.revidx[k] = r;
  }
}

// Computes the unitary complex-valued DFT.
EMSCRIPTEN_KEEPALIVE
void fft_transform(float* src, float* res) {
  int n = this.size;
  int* revidx = this.revidx;
  float* uroots = this.uroots;

  for (int i = 0; i < n; i++) {
    int r = revidx[i];
    res[r * 2 + 0] = src[i * 2 + 0];
    res[r * 2 + 1] = src[i * 2 + 1];
  }

  for (int s = 2; s <= n; s *= 2) {
    for (int k = 0; k * 2 < s; k++) {
      int kth = (n / s * k) % n;
      float cos = uroots[kth * 2];
      float sin = -uroots[kth * 2 + 1];

      for (int j = 0; j < n / s; j++) {
        int v = j * s + k;
        int u = v + s / 2;

        float v_re = res[v * 2];
        float v_im = res[v * 2 + 1];

        float u_re = res[u * 2];
        float u_im = res[u * 2 + 1];

        float t_re = u_re * cos - u_im * sin;
        float t_im = u_re * sin + u_im * cos;

        res[u * 2 + 0] = v_re - t_re;
        res[u * 2 + 1] = v_im - t_im;

        res[v * 2 + 0] = v_re + t_re;
        res[v * 2 + 1] = v_im + t_im;
      }
    }
  }

  // this makes the DFT unitary
  float n_rsqrt = 1 / sqrtf(n);
  for (int i = 0; i < 2 * n; i++)
    res[i] *= n_rsqrt;
}

EMSCRIPTEN_KEEPALIVE
void fft_forward(float* src, float* res) {
  fft_transform(src, res);
}

EMSCRIPTEN_KEEPALIVE
void fft_conjugate(float* src) {
  int n = this.size;
  for (int i = 0; i < n; i++)
    src[2 * i + 1] *= -1;
}

EMSCRIPTEN_KEEPALIVE
void fft_inverse(float* src, float* res) {
  fft_conjugate(src);
  fft_forward(src, res);
  fft_conjugate(src);
  fft_conjugate(res);
}
