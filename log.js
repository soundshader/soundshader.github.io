let lines = [];

export const v = (...args) => record('V', args);
export const i = (...args) => record('I', args);
export const w = (...args) => record('W', args);
export const e = (...args) => record('E', args);

export function assert(x) {
  if (!x) {
    debugger;
    throw new Error('assert: ' + x);
  }
}

export function setUnhandledErrorHandler(handler) {
  window.addEventListener('error', (event, src, row, col, error) => {
    let err = event && event.error || error;
    e(err.stack);
    v(err);
    handler && handler(err);
  });

  window.addEventListener('unhandledrejection', event => {
    event.preventDefault();
    let error = event.reason;
    e(error.stack);
    v(error);
    handler && handler(error);
  });
}

export function download() {
  let blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  let a = document.createElement('a');
  a.download = 'console.log';
  a.href = URL.createObjectURL(blob);
  a.click();
}

function record(level, args) {
  let time = new Date().toJSON().replace(/^.+T|Z$/g, '');
  let line = [time, ...args].join(' ');
  lines.push(line);
  level == 'V' && console.debug(...args);
  level == 'I' && console.info(...args);
  level == 'W' && console.warn(...args);
  level == 'E' && console.error(...args);
}
