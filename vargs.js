let args = new URLSearchParams(location.search);

export const SIZE = +args.get('n') || 1024;
export const USE_MOUSE = args.get('mouse') == '1';
export const USE_CWT = args.get('s') == 'cwt';
export const USE_FFT = args.get('s') == 'fft';
export const USE_ACF = args.get('s') == 'acf';

export const CWT_BRIGHTNESS = +args.get('cwt.b') || 1;
export const CWT_LEN = +args.get('cwt.len') || 17;
export const CWT_N = +args.get('cwt.3s') || 30;
export const CWT_GL = args.get('cwt.gl') != '0';
export const FFT_GL = args.get('fft.gl') == '1';
export const FFT_LOG_SCALE = args.get('fft.log') != '0';
