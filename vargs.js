let args = new URLSearchParams(location.search);

export const SIZE = +args.get('n') || 512;
export const USE_CWT = args.get('s') == 'cwt';
export const USE_FFT = args.get('s') == 'fft';

export const CWT_N = +args.get('cwt.3sigma') || 30;
