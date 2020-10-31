import * as vargs from './vargs.js';
import { AudioController } from './audio/controller.js';
import { CwtController } from './audio/cwt-controller.js';
import * as log from './log.js';

let btnDemo = document.querySelector('#demo');
let btnUpload = document.querySelector('#upload');
let btnLogs = document.querySelector('#log');
let btnMic = document.querySelector('#mic');
let btnRec = document.querySelector('#rec');
let divStats = document.querySelector('#stats');
let canvas = document.querySelector('canvas');
let audio = document.querySelector('audio');
let audioStream = null;
let audioController = null; // use getAudioController()
let keyboardHandlers = {};

let config = {
  size: vargs.SIZE,
  audio: {
    channelCount: 1,
    sampleRate: vargs.SAMPLE_RATE * 1e3 | 0,
  },
};

window.onload = () => void main();

function main() {
  canvas.width = vargs.IMAGE_SIZE;
  canvas.height = vargs.IMAGE_SIZE;
  log.i('canvas size:', vargs.IMAGE_SIZE);
  setKeyboardHandlers();
  setMouseHandlers();
  setRecordingHandler();
  setLogsHandler();
  setDemoButtonHandler();
  divStats.textContent = 'Select a file or use mic.';
}

function setDemoButtonHandler() {
  let id = vargs.DEMO_ID;
  let url = '/mp3/' + id + '.mp3';
  btnDemo.style.display = id ? '' : 'none';
  btnDemo.onclick = async () => {
    let controller = getAudioController();
    await controller.stop();
    await initAudioSource(url);
    await controller.start(audioStream, null, audio);
  };
}

function setLogsHandler() {
  if (!vargs.SHOW_LOGS)
    btnLogs.style.display = 'none';
  else
    btnLogs.onclick = () => log.download();
}

function setRecordingHandler() {
  let videoStream, recorder, chunks;

  if (!vargs.REC_FRAMERATE)
    btnRec.style.display = 'none';

  btnRec.onclick = async () => {
    if (recorder) {
      log.i('Saving recorded media');
      videoStream.getTracks().map(t => t.stop());
      videoStream = null;

      recorder.onstop = () => {
        let mime = recorder.mimeType;
        let size = chunks.reduce((s, b) => s + b.size, 0);
        log.i('Prepairing a media blob', mime, 'with',
          chunks.length, 'chunks', size / 2 ** 10 | 0, 'KB total');
        let blob = new Blob(chunks, { type: mime })
        let url = URL.createObjectURL(blob);
        chunks = [];
        recorder = null;

        log.i('Downloading the media blob at', url);
        let a = document.createElement('a');
        let filename = new Date().toJSON()
          .replace(/\..+$/, '')
          .replace(/[^\d]/g, '-');
        a.download = filename;
        a.href = url;
        a.click();
      };

      recorder.stop();
    } else {
      log.i('Prepairing video and audio streams for recording');
      let stream = new MediaStream();
      videoStream = canvas.captureStream(vargs.REC_FRAMERATE);
      videoStream.getTracks().map(t => stream.addTrack(t));
      audioStream.getTracks().map(t => stream.addTrack(t));

      log.i('Starting recording a stream with',
        stream.getTracks().length, 'media tracks');
      recorder = new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable =
        (e) => void chunks.push(e.data);
      recorder.start();
    }
  };
}

function setMouseHandlers() {
  btnMic.onclick = async () => {
    let controller = getAudioController();
    await controller.stop();
    audioStream = await navigator.mediaDevices.getUserMedia(
      { audio: config.audio });
    log.i('Captured microphone stream.');
    await controller.start(audioStream);
  };

  canvas.onclick = async e => {
    if (e.which == 3) return; // right click

    let x = e.offsetX / canvas.clientWidth - 0.5;
    let y = 0.5 - e.offsetY / canvas.clientHeight;
    log.i('canvas click:', x.toFixed(3), y.toFixed(3));

    let controller = getAudioController();

    // pause / resume already running audio
    if (controller.started) {
      if (controller.running)
        controller.pause();
      else
        controller.resume();
      return;
    }
  };

  btnUpload.onclick = async () => {
    let controller = getAudioController();
    await controller.stop();
    let file = await selectAudioFile();
    file && await controller.start(audioStream, file, audio);
  };
}

function setKeyboardHandlers() {
  document.onkeypress = e => {
    let key = e.key.toLowerCase();
    let handler = keyboardHandlers[key];
    if (handler) handler(e);
  };

  setKeyboardHandler('r', 'Switch sound shader.',
    () => getAudioController().switchAudioRenderer());
  setKeyboardHandler('c', 'Switch coords.',
    () => getAudioController().switchCoords());
}

function setKeyboardHandler(key, description, handler) {
  key = key.toLowerCase();

  if (keyboardHandlers[key])
    throw new Error('Key already in use: ' + key);

  keyboardHandlers[key] = handler;
  log.i(key, '-', description);
}

function getAudioController() {
  if (audioController)
    return audioController;

  let ctor = vargs.SHADER == 'cwt' ?
    CwtController :
    AudioController;

  audioController = new ctor(canvas, {
    fftSize: config.size * 2,
    stats: divStats,
  });

  audioController.init();
  return audioController;
}

async function selectAudioFile() {
  log.i('Creating an <input> to pick a file');
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

  if (!file) return;

  log.i('Selected file:', file.type,
    file.size / 2 ** 10 | 0, 'KB', file.name);
  document.title = file.name;
  let url = URL.createObjectURL(file);
  await initAudioSource(url);
  return file;
}

async function initAudioSource(url) {
  log.i('Decoding audio file:', url);

  audio.src = url;
  audio.playbackRate = vargs.PLAYBACK_RATE;

  await new Promise((resolve, reject) => {
    audio.onloadeddata =
      () => resolve();
    audio.onerror =
      () => reject(audio.error);
  });

  log.i('Capturing audio stream');
  audioStream = audio.captureStream ?
    audio.captureStream() :
    audio.mozCaptureStream();

  log.i('Audio stream id:', audioStream.id);
}
