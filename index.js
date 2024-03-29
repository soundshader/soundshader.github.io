import * as vargs from './url_args.js';
import { AudioController } from './audio/controller.js';
import { MediaFileRecorder } from './audio/recorder.js';
import * as log from './log.js';

let $ = x => document.querySelector(x);

let btnUpload = $('#upload');
let btnLogs = $('#log');
let btnMic = $('#mic');
let btnRec = $('#rec');
let divStats = $('#stats');
let vTimeBar = $('#vtimebar');
let canvas = $('canvas');
let audioController = null; // use getAudioController()
let keyboardHandlers = {};
let vTimeBarAnimationId = 0;
let selectedFiles = [];
let currentFileId = 0;
let vconf = vargs.vconf;

window.onload = () => main();
vconf.onchange = updateConf;

function main() {
  resizeCanvas();
  setKeyboardHandlers();
  setMouseHandlers();
  setRecordingHandler();
  setLogsHandler();
  setPlayButtonHandler();
  setHashChangeHandler();
  divStats.textContent = 'Select a file or use mic.';
}

function updateConf(arg) {
  if (arg == 'IMAGE_SIZE')
    resizeCanvas();
  let args = ['FREQ_MIN', 'DB_MAX', 'DB_LOG', 'ACF_RGB', 'ACF_DYN_LOUDNESS',
    'H_GRAD', 'GRAD_ZOOM', 'NUM_SAMPLES', 'USE_DCT', 'N_SYMM', 'HZ_HUE'];
  if (args.indexOf(arg) >= 0)
    audioController?.drawFrame();
}

function resizeCanvas() {
  let n = vconf.IMAGE_SIZE;
  confirm.IMAGE_SIZE = n;
  canvas.width = n;
  canvas.height = n;
  log.i('Image size:', n);
}

function setHashChangeHandler() {
  window.onhashchange = () => {
    audioController.drawFrame();
  };
}

function setPlayButtonHandler() {
  canvas.ondblclick = async (e) => {
    let offset = e.offsetX / canvas.clientWidth;
    let controller = getAudioController();
    if (controller.audioDuration > 0) {
      await controller.stopAudio();
    } else {
      await controller.playAudio(offset);
      startUpdatingTimeBar();
    }
  };
}

function setLogsHandler() {
  if (!vconf.SHOW_LOGS)
    btnLogs.style.display = 'none';
  else
    btnLogs.onclick = () => log.download();
}

function setRecordingHandler() {
  let videoStream, audioStream, recorder;

  if (!vconf.REC_FRAMERATE)
    btnRec.style.display = 'none';

  btnRec.onclick = async () => {
    if (recorder) {
      log.i('Saving recorded media');
      videoStream.getTracks().map(t => t.stop());
      videoStream = null;

      let blob = await recorder.saveRecording();
      let url = URL.createObjectURL(blob);
      let a = document.createElement('a');
      let filename = new Date().toJSON()
        .replace(/\..+$/, '')
        .replace(/[^\d]/g, '-');
      a.download = filename + '.webm';
      a.href = url;
      a.click();
      recorder = null;
    } else {
      videoStream = canvas.captureStream(vconf.REC_FRAMERATE);
      audioStream = getAudioController().audioStream;
      recorder = new MediaFileRecorder(audioStream, videoStream);
      recorder.startRecording();
    }
  };
}

function setMouseHandlers() {
  let recorder, micAudioStream;

  if (!vargs.SHOW_MIC)
    btnMic.style.display = 'none';

  btnMic.onclick = async () => {
    if (recorder) {
      btnMic.textContent = 'mic';
      let blob = await recorder.saveRecording();
      micAudioStream.getTracks().forEach(t => t.stop());
      recorder = null;
      let controller = getAudioController();
      await controller.start(blob);
    } else {
      micAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: vconf.SAMPLE_RATE | 0,
        }
      });
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
    selectedFiles = await selectAudioFiles();
    currentFileId = 0;
    renderCurrentFile();
  };

  $('#prev').onclick = () => {
    let n = selectedFiles.length;
    let i = currentFileId;
    currentFileId = (i - 1 + n) % n;
    if (i != currentFileId)
      renderCurrentFile();
  };

  $('#next').onclick = () => {
    let n = selectedFiles.length;
    let i = currentFileId;
    currentFileId = (i + 1 + n) % n;
    if (i != currentFileId)
      renderCurrentFile();
  };
}

function renderCurrentFile() {
  let file = selectedFiles[currentFileId];
  if (!file) return null;
  log.v('current file:', file.name, file.size / 1024 | 0, 'KB');
  let controller = getAudioController();
  return controller.start(file);
}

function setKeyboardHandlers() {
  document.onkeypress = e => {
    let key = e.key.toLowerCase();
    let handler = keyboardHandlers[key];
    if (handler) handler(e);
  };

  setKeyboardHandler('c', 'Switch coords', () => {
    let ctrl = getAudioController();
    ctrl.switchCoords();
    document.body.classList.toggle('polar', ctrl.polarCoords);
  });

  setKeyboardHandler('f', 'Switch FFT vs ACF',
    () => getAudioController().switchRenderer());

  setKeyboardHandler('u', 'Up freq mod', () => {
    let acf = audioController.renderers[0].gpuACF;
    log.v('freq_mod:', ++acf.freq_mod);
    acf.freq_rem = 0;
    audioController.drawFrame();
  });

  setKeyboardHandler('j', 'Down freq mod', () => {
    let acf = audioController.renderers[0].gpuACF;
    log.v('freq_mod:', --acf.freq_mod);
    acf.freq_rem = 0;
    audioController.drawFrame();
  });

  setKeyboardHandler('i', 'Up freq rem', () => {
    let acf = audioController.renderers[0].gpuACF;
    log.v('freq_rem:', ++acf.freq_rem);
    audioController.drawFrame();
  });

  setKeyboardHandler('k', 'Down freq rem', () => {
    let acf = audioController.renderers[0].gpuACF;
    log.v('freq_rem:', --acf.freq_rem);
    audioController.drawFrame();
  });
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

  let fft = vconf.FFT_SIZE;
  log.i('FFT size:', fft, '=', fft / vconf.SAMPLE_RATE * 1000 | 0, 'ms');

  audioController = new AudioController(canvas, {
    fftSize: fft,
    stats: divStats,
  });

  audioController.init();
  document.body.classList.toggle('polar',
    audioController.polarCoords);
  return audioController;
}

async function selectAudioFiles() {
  log.v('Creating an <input> to pick a file');
  let input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.multiple = true;
  input.click();

  let files = await new Promise((resolve) => {
    input.onchange = () => {
      resolve(input.files);
    };
  });

  log.v('Selected files:', files.length);
  return files;
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

  if (audioController.polarCoords) {
    let dt = 1 - timestamp / duration; // 0..1
    let px = (dt * canvas.clientWidth).toFixed(2) + 'px';
    vTimeBar.style.width = px;
    vTimeBar.style.height = px;
    vTimeBar.style.left = '';
  } else {
    let dt = timestamp / duration; // 0..1
    dt *= vconf.NUM_STRIPES; dt -= Math.floor(dt);
    let px = (dt * canvas.clientWidth).toFixed(2) + 'px';
    vTimeBar.style.width = '';
    vTimeBar.style.height = '';
    vTimeBar.style.left = px;
  }

  vTimeBar.style.visibility = 'visible';
  vTimeBarAnimationId = requestAnimationFrame(startUpdatingTimeBar);
}
