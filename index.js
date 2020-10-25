import * as vargs from './vargs.js';
import { AudioController } from './audio/controller.js';

let btnUpload = document.querySelector('#upload');
let btnMic = document.querySelector('#mic');
let divStats = document.querySelector('#stats');
let canvas = document.querySelector('canvas');
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
  divStats.textContent = 'Select a mp3 file or use mic.';
}

function setMouseHandlers() {
  btnMic.onclick = async () => {
    let controller = getAudioController();
    controller.stop();
    let stream = await navigator.mediaDevices.getUserMedia(
      { audio: config.audio });
    console.log('Captured microphone stream.');
    controller.start(stream);
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
    let { audio, stream, file } = await selectAudioFile();
    if (!stream) return;

    let controller = getAudioController();
    controller.stop();

    audio.loop = true;
    controller.start(stream, file, audio);
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

  console.log('Creating an <audio> element to render the file');
  let audio = document.createElement('audio');
  audio.src = URL.createObjectURL(file);

  await new Promise(resolve => {
    audio.onloadeddata =
      () => resolve();
  });

  console.log('Capturing audio stream');
  let stream = audio.captureStream();

  console.log('Got media stream from <audio>:', stream.id,
    'tracks:', stream.getTracks().map(t => t));
  return { audio, stream, file };
}
