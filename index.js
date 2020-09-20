import { AudioController } from './audio/controller.js';

let urlParams = new URLSearchParams(location.search);
let divMic = document.querySelector('#mic');
let divStats = document.querySelector('#stats');
let canvas = document.querySelector('canvas');
let audioController = null; // use getAudioController()
let keyboardHandlers = {};

let config = {
  size: urlParams.get('n') || 512,
  audio: true, // getUserMedia
};

window.onload = () => void main();

function main() {
  canvas.width = config.size;
  canvas.height = config.size;
  setKeyboardHandlers();
  setMouseHandlers();
  divStats.textContent = 'Click the canvas to start.';
}

function setMouseHandlers() {
  divMic.onclick = async () => {
    let controller = getAudioController();
    controller.stop();
    let stream = await navigator.mediaDevices.getUserMedia(
      { audio: config.audio });
    console.log('Captured microphone stream.');
    controller.start(stream);
  };

  canvas.onclick = async e => {
    let x = e.clientX / canvas.clientWidth - 0.5;
    let y = 0.5 - e.clientY / canvas.clientHeight;
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

    let { audio, stream } = await selectAudioFile();
    if (!stream) return;
    audio.loop = true;
    audio.play();
    controller.start(stream);
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
  input.accept = 'audio/mpeg';
  input.click();

  let file = await new Promise((resolve, reject) => {
    input.onchange = () => {
      let files = input.files || [];
      resolve(files[0] || null);
    };
  });

  if (!file) return {};
  console.log('Selected file:', file.type, file.size, 'bytes');

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
