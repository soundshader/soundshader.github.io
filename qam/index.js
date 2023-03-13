import * as utils from '/audio/utils.js';

let canvas, re_im_curve;

let $ = x => document.querySelector(x);
let sleep = t => new Promise(resolve => setTimeout(resolve, t));
let log = (...args) => console.log(...args);
let scheduled = new Set;
let conf = {};

conf.SR = 48000;
conf.FFT = 2 ** 16;
conf.W = 1024;
conf.H = 1024;
conf.ZOOM = 1;
conf.STEPS = 1;

async function main() {
  canvas = $('canvas');
  canvas.width = conf.W;
  canvas.height = conf.H;
  canvas.onclick = () => renderAudio();
  initDatGUI();
}

async function renderAudio() {
  let file = await utils.selectAudioFile();
  let signal = await utils.decodeAudioFile(file, { sample_rate: conf.SR });
  let fft = utils.transformRe(signal, { fft_size: conf.FFT });
  await sleep(0);

  let n = conf.FFT;
  let fft2 = new Float32Array(n * 2);
  let shift = n / 4;

  for (let i = 0; i < n / 2; i++) {
    let j = i - shift;
    let p = (i + n) % n * 2;
    let q = (j + n) % n * 2;
    fft2[q + 0] = fft[p + 0];
    fft2[q + 1] = fft[p + 1];
  }

  re_im_curve = utils.inverseReIm(fft2, { fft_size: conf.FFT });
  await drawCurve();
}

async function drawCurve() {
  let rgba = utils.initRGBA(canvas);
  rgba.clear();
  rgba.draw();
  await sleep(0);

  for (let i = 2; i < re_im_curve.length; i += 2) {
    let ns = conf.STEPS;
    for (let s = 0; s < ns; s++) {
      let x0 = re_im_curve[i - 2];
      let y0 = re_im_curve[i - 1];
      let x1 = re_im_curve[i];
      let y1 = re_im_curve[i + 1];
      let x = utils.mix(x0, x1, s / ns) * conf.ZOOM;
      let y = utils.mix(y0, y1, s / ns) * conf.ZOOM;
      let t = i / re_im_curve.length;
      let [r, g, b] = utils.hsv2rgb(t * 3, 1, 1 / ns);
      rgba.addRGBA(x, y, r, g, b, 1);
    }
  }

  rgba.draw();
}

function initDatGUI() {
  log('Initializing DAT GUI');
  let gui = new dat.GUI({ autoPlace: true });
  gui.add(conf, 'SR').name('SR');
  gui.add(conf, 'FFT').name('FFT');
  gui.add(conf, 'W').name('W');
  gui.add(conf, 'H').name('H');
  gui.add(conf, 'STEPS', 1, 16, 1).name('STEPS').onChange(() => schedule(drawCurve));
  gui.add(conf, 'ZOOM', 1, 1000, 0.1).name('ZOOM').onChange(() => schedule(drawCurve));
}

function schedule(fn) {
  scheduled.add(fn);
  setTimeout(() => {
    let fns = [...scheduled.values()];
    scheduled.clear();
    for (let fn of fns) fn();
  }, 0);
}

window.onload = () => main();
