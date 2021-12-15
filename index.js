import * as vargs from './vargs.js';
import { AudioController } from './audio/controller.js';
import { CwtController } from './audio/cwt-controller.js';
import * as log from './log.js';

let $ = x => document.querySelector(x);

let btnPlay = $('#play');
let btnUpload = $('#upload');
let btnLogs = $('#log');
let btnMic = $('#mic');
let btnRec = $('#rec');
let divStats = $('#stats');
let vTimeBar = $('#vtimebar');
let canvas = $('canvas');
let audio = $('audio');
let micAudioStream = null;
let audioController = null; // use getAudioController()
let keyboardHandlers = {};
let vTimeBarAnimationId = 0;

let config = {
  size: vargs.FFT_SIZE,
  audio: {
    channelCount: 1,
    sampleRate: vargs.SAMPLE_RATE | 0,
  },
};

window.onload = () => void main();

function main() {
  canvas.width = vargs.IMAGE_SIZE;
  canvas.height = vargs.IMAGE_SIZE;
  log.i('Image size:', vargs.IMAGE_SIZE);
  log.i('Sample rate:', vargs.SAMPLE_RATE, 'Hz');
  log.i('A4 note:', vargs.A4_FREQ, 'Hz');
  log.i('FFT size:', vargs.FFT_SIZE);
  setKeyboardHandlers();
  setMouseHandlers();
  setRecordingHandler();
  setLogsHandler();
  setPlayButtonHandler();
  divStats.textContent = 'Select a file or use mic.';
}

function setPlayButtonHandler() {
  btnPlay.onclick = async () => {
    let controller = getAudioController();
    controller.playAudio();
    startUpdatingTimeBar();
  };
}

function setLogsHandler() {
  if (!vargs.SHOW_LOGS)
    btnLogs.style.display = 'none';
  else
    btnLogs.onclick = () => log.download();
}

function setRecordingHandler() {
  let imgVideoStream, recorder;

  if (!vargs.REC_FRAMERATE)
    btnRec.style.display = 'none';

  btnRec.onclick = async () => {
    if (recorder) {
      log.i('Saving recorded media');
      imgVideoStream.getTracks().map(t => t.stop());
      imgVideoStream = null;

      let blob = await recorder.saveRecording();
      recorder = null;

      let url = URL.createObjectURL(blob);
      let a = document.createElement('a');
      let filename = new Date().toJSON()
        .replace(/\..+$/, '')
        .replace(/[^\d]/g, '-');
      a.download = filename + '.webm';
      a.href = url;
      a.click();
    } else {
      log.i('Starting image recording');
      imgVideoStream = canvas.captureStream(vargs.REC_FRAMERATE);
      recorder = new MediaFileRecorder(micAudioStream, imgVideoStream);
      recorder.startRecording();
    }
  };
}

class MediaFileRecorder {
  constructor(audioStream, videoStream = null) {
    this.recorder = null;
    this.chunks = null;
    this.audioStream = audioStream;
    this.videoStream = videoStream;
  }

  async saveRecording() {
    let recorder = this.recorder;
    let chunks = this.chunks;

    await new Promise(resolve => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    let mime = recorder.mimeType;
    let size = chunks.reduce((s, b) => s + b.size, 0);
    log.i('Prepairing a media blob', mime, 'with',
      chunks.length, 'chunks', size / 2 ** 10 | 0, 'KB total');
    let blob = new Blob(chunks, { type: mime })
    this.chunks = [];
    this.recorder = null;
    return blob;
  }

  startRecording() {
    let audioStream = this.audioStream;
    let videoStream = this.videoStream;
    let stream = new MediaStream();

    videoStream && videoStream.getTracks()
      .map(t => stream.addTrack(t));
    audioStream && audioStream.getTracks()
      .map(t => stream.addTrack(t));

    this.recorder = new MediaRecorder(stream,
      { mimeType: 'video/webm' });
    this.chunks = [];
    this.recorder.ondataavailable =
      (e) => void this.chunks.push(e.data);
    this.recorder.start();
  }
}

function setMouseHandlers() {
  let recorder;

  btnMic.onclick = async () => {
    if (recorder) {
      btnMic.textContent = 'mic';
      let blob = await recorder.saveRecording();
      micAudioStream.getTracks().forEach(t => t.stop());
      recorder = null;
      let controller = getAudioController();
      await controller.start(blob);
    } else {
      micAudioStream = await navigator.mediaDevices.getUserMedia(
        { audio: config.audio });
      if (micAudioStream) {
        recorder = new MediaFileRecorder(micAudioStream);
        recorder.startRecording();
        btnMic.textContent = 'rec';
        divStats.textContent = 'Recording mic...';
      } else {
        log.e('getUserMedia failed. No mic?');
      }
    }
  };

  btnUpload.onclick = async () => {
    let controller = getAudioController();
    let file = await selectAudioFile();
    file && await controller.start(file);
  };
}

function setKeyboardHandlers() {
  document.onkeypress = e => {
    let key = e.key.toLowerCase();
    let handler = keyboardHandlers[key];
    if (handler) handler(e);
  };

  setKeyboardHandler('c', 'Switch coords',
    () => getAudioController().switchCoords());
  setKeyboardHandler('f', 'Switch FFT vs ACF',
    () => getAudioController().switchRenderer());
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
    fftSize: config.size,
    stats: divStats,
  });

  audioController.init();
  return audioController;
}

async function selectAudioFile() {
  log.v('Creating an <input> to pick a file');
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
  log.v('Decoding audio file:', url);

  audio.src = url;
  audio.playbackRate = vargs.PLAYBACK_RATE;

  await new Promise((resolve, reject) => {
    audio.onloadeddata =
      () => resolve();
    audio.onerror =
      () => reject(audio.error);
  });

  log.v('Capturing audio stream');
  micAudioStream = audio.captureStream ?
    audio.captureStream() :
    audio.mozCaptureStream();

  log.v('Audio stream id:', micAudioStream.id);
}

function startUpdatingTimeBar() {
  cancelAnimationFrame(vTimeBarAnimationId);
  vTimeBarAnimationId = 0;
  let timestamp = audioController.currentTime;
  let duration = audioController.audioDuration;

  if (!duration) {
    vTimeBar.style.visibility = 'hidden';
    return;
  }

  let dt = timestamp / duration; // 0..1
  let px = (dt * canvas.clientWidth).toFixed(2) + 'px';

  if (audioController.polarCoords) {
    vTimeBar.style.width = px;
    vTimeBar.style.height = px;
    vTimeBar.style.left = '';
    vTimeBar.classList.toggle('polar', true);
  } else {
    vTimeBar.style.width = '';
    vTimeBar.style.height = '';
    vTimeBar.style.left = px;
    vTimeBar.classList.toggle('polar', false);
  }

  vTimeBar.style.visibility = 'visible';
  vTimeBarAnimationId = requestAnimationFrame(startUpdatingTimeBar);
}
