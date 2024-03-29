let args = new URLSearchParams(location.search.slice(1));
let arg_ss = +args.get('ss') || 0; // similar to ffmpeg
let arg_to = +args.get('to') || 5; // similar to ffmpeg
let arg_fft = +args.get('fft') || 0;
let arg_sr = +args.get('sr') || 6;

let sampleRate = arg_sr * 1024;
let iframe, iframe_reqs = {}, iframe_tx_id = 0;

function dcheck(x) {
  if (x) return;
  debugger;
  throw new Error('DCHECK failed: ' + x);
}

function mix(a, b, x) {
  return a * (1 - x) + b * x;
}

function clamp(x, a = 0, b = 1) {
  return Math.min(Math.max(x, a), b);
}

function hann(x, a = 0, b = 1) {
  return Math.sin(clamp((x - a) / (b - a), 0, 1) * Math.PI) ** 2;
}

function plot_w_dirs(canvas, { w_dirs, w_rgbs }) {
  let ctx = canvas.getContext('2d');
  let w = canvas.width;
  let h = canvas.height;
  let n = w_dirs.length / 2;

  let enum_reim = (callback) => {
    for (let t = 0; t < n; t++) {
      let re = w_dirs[2 * t];
      let im = w_dirs[2 * t + 1];
      let ds = Math.sqrt(re * re + im * im);
      callback(re, im, ds, t);
    }
  };

  let r_max = 0, x_avg = 0, y_avg = 0;

  enum_reim((x, y, r) => {
    x_avg += x / n;
    y_avg += y / n;
    r_max = Math.max(r_max, r);
  });


  console.log('r_max:', r_max);
  // ctx.clearRect(0, 0, w, h);

  enum_reim((x, y, r, t) => {
    let ix = ((x - x_avg) / r_max * 0.5 + 0.5) * w;
    let iy = ((y - y_avg) / r_max * 0.5 + 0.5) * h;

    let rs = mix(0, 15, r / r_max);
    let alpha = r / r_max;

    let cr = w_rgbs[t * 3 + 0];
    let cg = w_rgbs[t * 3 + 1];
    let cb = w_rgbs[t * 3 + 2];
    let rgb = cr + cg + cb;
    cr *= 256 / rgb;
    cg *= 256 / rgb;
    cb *= 256 / rgb;

    ctx.fillStyle = 'rgba(' + cr.toFixed(2) + ',' + cg.toFixed(2) + ',' + cb.toFixed(2) + ',' + alpha.toFixed(2) + ')';
    ctx.fillRect(ix - rs / 2, iy - rs / 2, rs, rs);
  });
}

function init() {
  iframe = document.querySelector('iframe');
  let canvas = document.querySelector('canvas');

  canvas.onclick = async () => {
    let file = await selectAudioFile();
    document.title = file.name;
    console.log('decoding audio at', sampleRate, 'Hz');
    let audio = await decodeAudioFile(file);
    console.log('audio:', audio.length, 'samples');

    let fft_size = canvas.height;
    let num_frames = canvas.width;

    console.log('computing fft image...');
    let fft_data = await computeFFT(audio, fft_size, num_frames);

    // if (arg_fft) {
    drawFFT(canvas, fft_data, 3);

    // } else {
    let [w_dirs, w_rgbs] = computeWeightedSums(fft_data, fft_size, num_frames);
    plot_w_dirs(canvas, { w_dirs, w_rgbs });
    // }

    console.log('done');
  };

  // canvas.onmousemove = e =>
  //   document.title = (e.clientX / canvas.clientWidth * canvas.width | 0) +
  //   ':' + ((1 - e.clientY / canvas.clientHeight) * canvas.height | 0);
}

function computeWeightedDirs(fft_data, fft_size, num_frames) {
  dcheck(fft_data.length == fft_size * num_frames);
  let w_dirs = new Float32Array(num_frames * 2); // re, im

  for (let t = 0; t < num_frames; t++) {
    let re = 0, im = 0;

    for (let f = 1; f < fft_size / 2 - 1; f++) {
      let f_hz = f / fft_size * sampleRate;
      let octave = Math.log2(f_hz / 432);
      let pitch = octave - Math.floor(octave);
      let amp = fft_data[t * fft_size + f];
      re += amp * Math.cos(pitch * 2 * Math.PI);
      im += amp * Math.sin(pitch * 2 * Math.PI);
    }

    w_dirs[t * 2] = re;
    w_dirs[t * 2 + 1] = im;
  }

  return w_dirs;
}

function computeWeightedSums(fft_data, fft_size, num_frames) {
  dcheck(fft_data.length == fft_size * num_frames);
  let w_sums = new Float32Array(num_frames * 2); // re, im
  let w_rgbs = new Float32Array(num_frames * 3);

  for (let t = 0; t < num_frames; t++) {
    let re = 0, im = 0;
    let frame = fft_data.subarray(t * fft_size, (t + 1) * fft_size);
    let r = 0, g = 0, b = 0;

    for (let f = 1; f < fft_size / 2 - 1; f++) {
      let f_hz = f / fft_size * sampleRate;
      let octave = Math.log2(f_hz / 432);
      let pitch = octave - Math.floor(octave);

      let w = hann(pitch);

      re += frame[f] * w;
      im += frame[f] * (1 - w);

      r += frame[f] * hann(Math.min(pitch, 1 - pitch), 0, 1 / 3);
      g += frame[f] * hann(pitch, 0, 2 / 3);
      b += frame[f] * hann(pitch, 1 / 3, 1);
    }

    w_sums[t * 2 + 0] = re;
    w_sums[t * 2 + 1] = im;

    w_rgbs[t * 3 + 0] = r;
    w_rgbs[t * 3 + 1] = g;
    w_rgbs[t * 3 + 2] = b;
  }

  return [w_sums, w_rgbs];
}

function drawFFT(canvas, fft, log_scale = 0) {
  let h = canvas.height;
  let w = canvas.width;
  let ctx = canvas.getContext('2d');
  let img = ctx.getImageData(0, 0, w, h);
  let max = fft.reduce((s, x) => Math.max(s, Math.abs(x)), 0);

  if (fft.length != w * h)
    throw new Error('Invalid image size');

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d = img.data;
      let i = (y * w + x) * 4;
      let a = fft[x * h + h - 1 - y] / max;
      let s = log_scale > 0 ?
        1 + Math.log10(Math.abs(a)) / log_scale : Math.abs(a);
      d[i + 0] = (1 - s) * 256;
      d[i + 1] = (1 - s) * 256;
      d[i + 2] = (1 - s) * 256;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

async function computeFFT(audio, fft_size, num_frames) {
  let fft_data = new Float32Array(num_frames * fft_size);

  await aggregateFFT(audio, fft_size, num_frames, (fft_resp, t) => {
    for (let k = 0; k < fft_size; k++)
      fft_data[t * fft_size + k] = fft_resp.abs[k] ** 2;
  });

  return fft_data;
}

async function aggregateFFT(audio, fft_size, num_frames, fn) {
  console.log('fft frame:', fft_size, 'bins;',
    sampleRate / fft_size, 'Hz/bin',
    num_frames, 'frames');

  let frame = new Float32Array(fft_size);
  let frame_step = audio.length / num_frames | 0;

  for (let i = 0; i < num_frames; i++) {
    frame.fill(0);
    frame.set(
      audio.subarray(
        i * frame_step,
        Math.min(audio.length, i * frame_step + frame.length)));
    for (let x = 0; x < frame.length; x++)
      frame[x] *= Math.sin(x / frame.length * Math.PI) ** 2;
    let fft_resp = await requestFFT(frame);
    fn(fft_resp, i);
  }
}

function requestFFT(data) {
  let tx = iframe_tx_id++;
  iframe.contentWindow.postMessage(
    { tx, fn: 'fft', arg: { re: data } }, '*');
  return new Promise((resolve, reject) => {
    iframe_reqs[tx] = { resolve, reject };
  });
}

async function selectAudioFile() {
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/mpeg; audio/wav; audio/webm';
  input.click();

  let file = await new Promise((resolve, reject) => {
    input.onchange = () => {
      let files = input.files || [];
      resolve(files[0] || null);
    };
  });

  return file;
}

async function decodeAudioFile(file) {
  let encodedAudio = await file.arrayBuffer();
  let audioCtx = new AudioContext({ sampleRate });
  let audioBuffer = await audioCtx.decodeAudioData(encodedAudio);
  let channel_data = audioBuffer.getChannelData(0);

  console.log(`Copying audio from ${arg_ss}s to ${arg_to}s`);
  let frame_ss = arg_ss * sampleRate | 0;
  let frame_to = arg_to * sampleRate | 0;

  frame_to = frame_to || channel_data.length;

  return new Float32Array(channel_data.slice(frame_ss, frame_to));
}

window.onload = () => init();

window.onmessage = (event) => {
  let resp = event.data;
  let tx = resp.tx;
  let p = iframe_reqs[tx];
  if (resp.err) {
    p.reject(resp.err);
  } else {
    p.resolve(resp.res);
  }
  delete iframe_reqs[tx];
};
