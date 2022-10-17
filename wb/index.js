import * as log from '../log.js';
import { GpuContext } from "../webgl2.js";
import { GridUI } from './grid-ui.js';

let $ = x => document.querySelector(x);

log.addEventListener('log', (level, ...args) => {
  if (level == 'I')
    $('#status').textContent = args.join(' ');
  if (level == 'E')
    $('#error').textContent = args.join(' ');
});

window.onload = () => void main();

async function main() {
  let canvas = $('canvas');
  canvas.width = 2048;
  canvas.height = 2048;
  let webgl = new GpuContext(canvas);
  webgl.init({ preserveDrawingBuffer: true });
  let sp = new URLSearchParams(location.search.slice(1));
  let layout_uri = sp.get('wb') || 'default.wb';
  history.replaceState('', '', '?wb=' + layout_uri);
  let grid = new GridUI(webgl, {
    layout_uri,
    container: $('#grid'),
    controls: $('#controls'),
    buttons: $('#buttons'),
    editor: $('#editor'),
  });
  log.v('UI initialized');
}
