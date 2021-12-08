import * as vargs from './vargs.js';
import { AudioController } from './audio/controller.js';
import { CwtController } from './audio/cwt-controller.js';
import * as log from './log.js';

let btnPlay = document.querySelector('#play');
let btnUpload = document.querySelector('#upload');
let btnLogs = document.querySelector('#log');
let btnMic = document.querySelector('#mic');
let btnRec = document.querySelector('#rec');
let divStats = document.querySelector('#stats');
let canvas = document.querySelector('canvas');
let audio = document.querySelector('audio');
let micAudioStream = null;
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
  setPlayButtonHandler();
  divStats.textContent = 'Select a file or use mic.';
}

function setPlayButtonHandler() {
  btnPlay.onclick = async () => {
    let controller = getAudioController();
    controller.playAudio();
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

      let blob = await recorder.stop();
      recorder = null;

      let url = URL.createObjectURL(blob);
      let a = document.createElement('a');
      let filename = new Date().toJSON()
        .replace(/\..+$/, '')
        .replace(/[^\d]/g, '-');
      a.download = filename;
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

    this.recorder = new MediaRecorder(stream);
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
    fftSize: config.size,
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
  micAudioStream = audio.captureStream ?
    audio.captureStream() :
    audio.mozCaptureStream();

  log.i('Audio stream id:', micAudioStream.id);
}
