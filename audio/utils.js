import { FFT } from '/webfft.js'

export const clamp = (x, min = 0, max = 1) => x < min ? min : x > max ? max : x;
export const fract = (x) => x - Math.floor(x);
export const mix = (min, max, x) => min * (1 - x) + max * x;
export const min = Math.min;
export const max = Math.max;
export const hann = x => x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 2 : 0;

function dcheck(x) {
  if (!x) throw new Error('dcheck failed');
}

export async function selectAudioFiles() {
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.multiple = true;
  input.click();
  return new Promise(resolve =>
    input.onchange = () => resolve(input.files));
}

export async function selectAudioFile() {
  let files = await selectAudioFiles();
  return files[0];
}

export async function decodeAudioFile(file, { sample_rate = 48000, channel = 0 } = {}) {
  let encoded = await file.arrayBuffer();
  let audio_ctx = new AudioContext({ sampleRate: sample_rate | 0 });
  let buffer = await audio_ctx.decodeAudioData(encoded);
  audio_ctx.close();
  return buffer.getChannelData(channel);
}

export function transformRe(signal, { fft_size }) {
  signal = signal.slice(0, fft_size);

  if (signal.length < fft_size) {
    let temp = new Float32Array(fft_size);
    temp.set(signal);
    signal = temp;
  }

  signal = FFT.expand(signal);
  return FFT.forward(signal);
}

export function inverseReIm(signal, { fft_size }) {
  dcheck(signal.length == fft_size * 2);
  return FFT.inverse(signal);
}

export function initRGBA(canvas) {
  let w = canvas.width;
  let h = canvas.height;
  let ctx = canvas.getContext('2d');
  let img = ctx.getImageData(0, 0, w, h);

  return {
    draw() {
      ctx.putImageData(img, 0, 0);
    },
    clear() {
      ctx.clearRect(0, 0, w, h);
      img.data.fill(0);
    },
    offset(x, y) {
      if (Math.max(Math.abs(x), Math.abs(y)) > 1)
        return 0;
      let i = (x + 1) / 2 * w | 0;
      let j = (y + 1) / 2 * h | 0;
      return (j * w + i) * 4;
    },
    setRGBA(x, y, r, g, b, a = 1) {
      let i = this.offset(x, y);
      img.data[i + 0] = r * 255;
      img.data[i + 1] = g * 255;
      img.data[i + 2] = b * 255;
      img.data[i + 3] = a * 255;
    },
    addRGBA(x, y, r, g, b, a = 0) {
      let i = this.offset(x, y);
      img.data[i + 0] += r * 255;
      img.data[i + 1] += g * 255;
      img.data[i + 2] += b * 255;
      img.data[i + 3] += a * 255;
    }
  };
}

export function hsv2rgb(hue, sat = 1, val = 1) {
  let Kx = 1, Ky = 2 / 3, Kz = 1 / 3, Kw = 3;
  let px = Math.abs(fract(hue + Kx) * 6 - Kw);
  let py = Math.abs(fract(hue + Ky) * 6 - Kw);
  let pz = Math.abs(fract(hue + Kz) * 6 - Kw);
  let r = val * mix(Kx, clamp(px - Kx, 0, 1), sat);
  let g = val * mix(Kx, clamp(py - Kx, 0, 1), sat);
  let b = val * mix(Kx, clamp(pz - Kx, 0, 1), sat);
  return [r, g, b];
}

export function smooth_hsv2rgb(hue, sat = 1, val = 1) {
  let r = 3 * Math.min(hue, 1 - hue);
  let g = 3 * Math.abs(hue - 1 / 3);
  let b = 3 * Math.abs(hue - 2 / 3);
  r = r > 1 ? 0 : 1 - hann(r / 2);
  g = g > 1 ? 0 : 1 - hann(g / 2);
  b = b > 1 ? 0 : 1 - hann(b / 2);
  r = val * mix(1, r, sat) * val;
  g = val * mix(1, g, sat) * val;
  b = val * mix(1, b, sat) * val;
  return [r, g, b];
}
