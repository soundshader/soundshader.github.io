let args = new URLSearchParams(location.search.slice(1));
let arg_ss = +args.get('ss') || 0; // similar to ffmpeg
let arg_to = +args.get('to') || 0; // similar to ffmpeg
let arg_fft = +args.get('fft') || 0;
let arg_sr = +args.get('sr') || 12;

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

function plot_w_dirs(canvas, { w_dirs }) {
  let ctx = canvas.getContext('2d');
  let w = canvas.width;
  let h = canvas.height;
  let n = w_dirs.length / 2;

  let enum_reim = (callback, ds_min = 1e-4) => {
    for (let t = 0; t < n; t++) {
      let re = w_dirs[2 * t];
      let im = w_dirs[2 * t + 1];
      let ds = Math.sqrt(re * re + im * im);
      if (ds > ds_min)
        callback(re, im, ds, t);
    }
  };

  let x = 0, y = 0;
  let r_max = 0, ds_max = 0;
  let x_avg = 0, y_avg = 0;

  enum_reim((dx, dy, ds) => {
    x += dx / ds;
    y += dy / ds;
    x_avg += x / n;
    y_avg += y / n;
    ds_max = Math.max(ds_max, ds);
  });

  x = 0, y = 0;

  enum_reim((dx, dy, ds) => {
    x += dx / ds;
    y += dy / ds;
    r_max = Math.max(r_max,
      Math.sqrt((x - x_avg) ** 2 + (y - y_avg) ** 2));
  });

  console.log('r_max:', r_max);
  ctx.clearRect(0, 0, w, h);
  x = y = 0;

  enum_reim((re, im, ds) => {
    x += re / ds;
    y += im / ds;

    let ix = ((x - x_avg) / r_max * 0.5 + 0.5) * w;
    let iy = ((y - y_avg) / r_max * 0.5 + 0.5) * h;

    let rs = mix(1, 15, ds / ds_max);
    let alpha = ds / ds_max;
    ctx.fillStyle = 'rgba(0,0,0,' + alpha.toFixed(2) + ')';
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

    if (arg_fft) {
      drawFFT(canvas, fft_data, 3);
    } else {
      let w_dirs = computeWeightedDirs(fft_data, fft_size, num_frames);
      plot_w_dirs(canvas, { w_dirs });
    }

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
