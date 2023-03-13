import { GpuContext } from '../webgl2.js'
import { GpuStatsProgram } from '../glsl/stats.js';
import * as shaders from './shaders.js';

let is_running = false;
let canvas, webgl;
let wave_buffers = [];
let wave_shader, draw_shader, mix_shader;
let wave_energy_shader, wave_volume_shader;
let wave_timestep = 0;

let $ = x => document.querySelector(x);
let sleep = t => new Promise(resolve => setTimeout(resolve, t));
let log = (...args) => console.log(...args);

log.i = log;
log.v = log;

async function main() {
  $('canvas').onclick = async (event) => {
    let x = event.clientX / event.target.clientWidth;
    let y = event.clientY / event.target.clientHeight;

    if (!is_running) {
      initGPU(x, y);
      is_running = true;
      runAnimation();
    } else {
      is_running = false;
      printWaveEnergy();
    }
    setMode(is_running ? 'running' : '');
  };

  initDatGUI();
}

function initGPU(mx, my) {
  if (webgl) return;
  canvas = $('canvas');
  canvas.width = IMG_SIZE;
  canvas.height = IMG_SIZE;
  log('canvas:', IMG_SIZE, 'x', IMG_SIZE);

  webgl = new GpuContext(canvas, { log });
  webgl.init();

  wave_shader = webgl.createTransformProgram({ fshader: shaders.WAVE_SHADER });
  draw_shader = webgl.createTransformProgram({
    // draw_points: true,
    // vshader: shaders.DRAW_VSHADER,
    fshader: shaders.DRAW_FSHADER
  });
  mix_shader = webgl.createTransformProgram({ fshader: shaders.MIX_SHADER });

  for (let i = 0; i < 3; i++)
    wave_buffers[i] = webgl.createFrameBuffer({ size: IMG_SIZE, channels: 4 });

  let init_shader = webgl.createTransformProgram({ fshader: shaders.INIT_SHADER });
  wave_buffers.map(fb => init_shader.exec({ uX: mx, uY: my }, fb));
  init_shader.destroy();
}

function computeWaveStep(fb_src, fb_res, time) {
  wave_shader.exec({
    uWave: fb_src, uTime: time,
    uFreq: FREQ,
    uG0: G0,
    uG1: G1,
    uK2: 10 ** K2,
    uSW_H: SW_H,
    uSW_F: 10 ** SW_F,
    uSW_B: 10 ** SW_B,
    uDT: DT,
  }, fb_res);
}

// https://en.wikipedia.org/wiki/Heun%27s_method
// It's 2x slower, but its accuracy is O(dt^2).
function drawNextWave() {
  for (let i = 0; i < STEPS/2; i++) {
    let [fb1, fb2, fb3] = wave_buffers;
    computeWaveStep(fb1, fb2, wave_timestep);
    computeWaveStep(fb2, fb3, wave_timestep + 1);
    mix_shader.exec({ uA: fb1, uB: fb3, uX: 0.5 }, fb2);
    wave_buffers = [fb2, fb3, fb1];
    wave_timestep++;
    wave_timestep++;
  }

  justDrawWave();
}

function justDrawWave() {
  draw_shader?.exec({
    uWave: wave_buffers[0],
    uSpec: 10 ** Math.abs(SPEC) * Math.sign(SPEC),
    uHGreen: H_GREEN,
    uRand: Math.random(),
  });
}

function printWaveEnergy() {
  if (!wave_energy_shader) {
    wave_volume_shader = new GpuStatsProgram(webgl, {
      size: IMG_SIZE,
    });
    wave_energy_shader = new GpuStatsProgram(webgl, {
      size: IMG_SIZE,
      prep: `float prep(vec4 w) {
        float h = w.x;
        float u2 = dot(w.yz, w.yz);
        return h * u2 + float(${G0}) * h * h;
      }`
    });
  }

  let e_buffer = wave_energy_shader.exec({ uData: wave_buffers[0] });
  let [e_min, e_max, e_avg] = e_buffer.download();

  let h_buffer = wave_volume_shader.exec({ uData: wave_buffers[0] });
  let [h_min, h_max, h_avg] = h_buffer.download();

  log('wave stats: E=' + e_avg.toExponential(2),
    'h=' + h_avg.toExponential(2), '@ ts=' + wave_timestep);
}

function runAnimation() {
  if (!is_running)
    return;

  drawNextWave();

  // if (Date.now() > prev_energy_ts + 1000) {
  //   printWaveEnergy();
  //   prev_energy_ts = Date.now();
  // }

  requestAnimationFrame(runAnimation);
}

function setMode(mode) {
  document.body.setAttribute('mode', mode);
}

function initDatGUI() {
  log('Initializing DAT GUI');
  let conf = window;
  let gui = new dat.GUI({ autoPlace: true });
  gui.add(conf, 'FREQ', 0, 100, 0.01).name('FREQ (Hz)');
  gui.add(conf, 'G0', 0, 1, 0.001).name('G0 (base grav.)');
  gui.add(conf, 'G1', 0, 1, 0.001).name('G1 (var. grav.)');
  gui.add(conf, 'SW_H', 0, 1, 0.01).name('H (depth)');
  gui.add(conf, 'K2', -9, 9, 0.01).name('log(K) (kin. visc.)');
  gui.add(conf, 'SW_F', -9, 9, 0.01).name('log(F) (coriolis)');
  gui.add(conf, 'SW_B', -9, 9, 0.01).name('log(B) (visc. drag)');
  gui.add(conf, 'DT', 0, 1, 0.01).name('DT (diff step)');
  gui.add(conf, 'STEPS', 0, 50).name('STEPS (per frame)');
  gui.add(conf, 'SPEC', -9, 9).name('SPEC (refl.)').onChange(justDrawWave);
}

window.onload = () => main();
