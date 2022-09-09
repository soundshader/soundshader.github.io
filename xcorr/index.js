let args = new URLSearchParams(location.search.slice(1));
let arg_ss = +args.get('ss') || 0; // similar to ffmpeg
let arg_to = +args.get('to') || 0; // similar to ffmpeg
let arg_sr = +args.get('sr') || 12;

let sampleRate = arg_sr * 1024;
let iframe, iframe_reqs = {}, iframe_tx_id = 0;

function dcheck(x) {
  if (x) return;
  debugger;
  throw new Error('DCHECK failed: ' + x);
}

let mix = (a, b, x) => a * (1 - x) + b * x;
let sleep = dt => new Promise(resolve => setTimeout(resolve, dt));

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

    console.log('Computing FFT image...');
    let fft_data = await computeFFT(audio, fft_size, num_frames);
    drawFFT(canvas, fft_data, { log_scale: 3 });
    await sleep(0);

    console.log('Computing xcorr FFT image...');
    let xcorr_data = await computeXCorr(fft_data, fft_size, num_frames);
    drawFFT(canvas, xcorr_data, { log_scale: 3 });

    console.log('Done');
  };

  // canvas.onmousemove = e =>
  //   document.title = (e.clientX / canvas.clientWidth * canvas.width | 0) +
  //   ':' + ((1 - e.clientY / canvas.clientHeight) * canvas.height | 0);
}

async function computeXCorr(fft_data, fft_size, num_frames,
  { progress_dt = 1000 } = {}) {

  dcheck(fft_data.length == fft_size * num_frames);
  let xcorr_data = new Float32Array(num_frames ** 2);
  let ts = Date.now();

  for (let t1 = 0; t1 < num_frames; t1++) {
    for (let t2 = 0; t2 < num_frames; t2++) {
      let f1 = fft_data.subarray(t1 * fft_size, (t1 + 1) * fft_size);
      let f2 = fft_data.subarray(t2 * fft_size, (t2 + 1) * fft_size);
      dcheck(f1.length == fft_size && f2.length == fft_size);
      let sum = f1.reduce((s, _, i) => s + (f1[i] * f2[i]) ** 0.5, 0);
      xcorr_data[t1 * num_frames + t2] = sum;
    }

    if (progress_dt > 0 && Date.now() > ts + progress_dt) {
      console.log('Progress:', t1 / num_frames * 100 | 0, '%');
      ts = Date.now();
      await sleep(0);
    }
  }

  return xcorr_data;
}

function drawFFT(canvas, fft, { log_scale = 0 } = {}) {
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
