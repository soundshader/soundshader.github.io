window.onunhandledrejection =
  window.onerror = (message, source, lineno, colno, error) => {
    if (!error && message.reason) {
      error = message.reason;
      message = error.message;
    }
    let div = document.querySelector('#error');
    div.textContent = message || error.message;
    div.stackTrace = error.stack + '';
    div.onclick = () => div.textContent = div.stackTrace;
  };
