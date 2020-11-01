let lines = [];

export const i = (...args) => record('I', args);
export const w = (...args) => record('W', args);
export const e = (...args) => record('E', args);

export function download() {
  let blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  let a = document.createElement('a');
  a.download = 'console.log';
  a.href = URL.createObjectURL(blob);
  a.click();
}

function record(level, args) {
  let time = new Date().toJSON();
  let line = [time, ...args].join(' ');
  lines.push(line);
  level == 'I' && console.info(...args);
  level == 'W' && console.warn(...args);
  level == 'E' && console.error(...args);
}
