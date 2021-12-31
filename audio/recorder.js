import * as log from '../log.js';

export class MediaFileRecorder {
  constructor(audioStream = null, videoStream = null) {
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
      chunks.length, 'chunks', size, 'bytes total');
    let blob = new Blob(chunks, { type: mime })
    this.chunks = [];
    this.recorder = null;
    return blob;
  }

  startRecording() {
    let audioStream = this.audioStream;
    let videoStream = this.videoStream;
    let vtracks = videoStream ? videoStream.getTracks() : [];
    let atracks = audioStream ? audioStream.getTracks() : [];
    let stream = new MediaStream();

    vtracks.map(t => stream.addTrack(t));
    atracks.map(t => stream.addTrack(t));

    this.recorder = new MediaRecorder(stream,
      { mimeType: 'video/webm;codecs=vp8,opus' });
    this.chunks = [];
    this.recorder.ondataavailable = e => {
      log.v('chunk:', e.data);
      this.chunks.push(e.data);
    };
    this.recorder.start();
    log.i('Recorder:', this.recorder.state);
    log.i('Started recording with',
      vtracks.length, 'video tracks and',
      atracks.length, 'audio tracks');
  }
}
