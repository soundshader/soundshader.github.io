import * as vargs from './vargs.js';
import { AudioController } from './audio/controller.js';

let btnUpload = document.querySelector('#upload');
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
  audio: true, // getUserMedia
};

window.onload = () => void main();

function main() {
  canvas.width = vargs.IMAGE_SIZE;
  canvas.height = vargs.IMAGE_SIZE;
  setKeyboardHandlers();
  setMouseHandlers();
  setRecordingHandler();
  divStats.textContent = 'Select a mp3 file or use mic.';
}

function setRecordingHandler() {
  let videoStream, recorder, chunks;

  btnRec.onclick = async () => {
    if (recorder) {
      console.log('Saving recorded media');
      videoStream.getTracks().map(t => t.stop());
      videoStream = null;

      recorder.onstop = () => {
        let mime = recorder.mimeType;
        let size = chunks.reduce((s, b) => s + b.size, 0);
        console.log('Prepairing a media blob', mime, 'with',
          chunks.length, 'chunks', size / 2 ** 10 | 0, 'KB total');
        let blob = new Blob(chunks, { type: mime })
        let url = URL.createObjectURL(blob);
        chunks = [];
        recorder = null;

        console.log('Downloading the media blob at', url);
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
      console.log('Prepairing video and audio streams for recording');
      let stream = new MediaStream();
      videoStream = canvas.captureStream(30);
      videoStream.getTracks().map(t => stream.addTrack(t));
      audioStream.getTracks().map(t => stream.addTrack(t));

      console.log('Starting recording a stream with',
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
    controller.stop();
    audioStream = await navigator.mediaDevices.getUserMedia(
      { audio: config.audio });
    console.log('Captured microphone stream.');
    controller.start(audioStream);
  };

  canvas.onclick = async e => {
    let x = e.offsetX / canvas.clientWidth - 0.5;
    let y = 0.5 - e.offsetY / canvas.clientHeight;
    console.log('canvas click:', x.toFixed(3), y.toFixed(3));

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
    let file = await selectAudioFile();
    if (!file) return;
    let controller = getAudioController();
    controller.stop();
    controller.start(audioStream, file, audio);
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
}

function setKeyboardHandler(key, description, handler) {
  key = key.toLowerCase();

  if (keyboardHandlers[key])
    throw new Error('Key already in use: ' + key);

  keyboardHandlers[key] = handler;
  console.log(key, '-', description);
}

function getAudioController() {
  if (audioController)
    return audioController;

  audioController = new AudioController(canvas, {
    fftSize: config.size * 2,
    stats: divStats,
  });

  audioController.init();
  return audioController;
}

async function selectAudioFile() {
  console.log('Creating an <input> to pick a file');
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

  if (!file) return {};
  console.log('Selected file:', file.type,
    file.size / 2 ** 10 | 0, 'KB', file.name);
  document.title = file.name;

  let url = URL.createObjectURL(file);
  audio.src = url;
  console.log('audio.src =', url);

  await new Promise(resolve => {
    audio.onloadeddata =
      () => resolve();
  });

  console.log('Capturing audio stream');
  audioStream = audio.captureStream();

  console.log('Got media stream from <audio>:', audioStream.id,
    'tracks:', audioStream.getTracks().map(t => t));
  return file;
}
