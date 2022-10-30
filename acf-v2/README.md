# Visual Morphology of Vowels

Demo: [soundshader.github.io/acf-v2](https://soundshader.github.io/acf-v2)

[![](img/xs.jpg)](img/xl.jpg)

Image is clickable.

These images are auto-correlation spectrograms of vowels.

- Definition of auto-correlation: `ACF(X)=FFT[abs(FFT(X))^2]`. It splits input `X` into `amp*cos(freq*t+phi)` waves, drops phases `phi` and squares amplitudes `amp`. For this reason, `ACF(X)` is a symmetric function.
- The ACF images below render `abs(ACF(X))/max(abs(ACF(X)))` to avoid oversaturation. The ACF values aren't squared and aren't log10-scaled.
- Low frequencies and high frequencies are rendered with different colors by applying bandpass filters: `FFT[BPF*abs(FFT(X))^2]`. The low frequency ACF is rendered with color `(12,3,1)` and the high frequency ACF - with color `(1,3,12)`. Oversaturation allows to reveal more details without resorting to log10-scaling (which doesn't look good).
- Sample rate: 16 kHz. Frame size: 4096. The rule of thumb: frame size = 1/4 of sample rate. This means that one ACF frame captures 1/4 sec of sound, and the frames overlap heavily.
- The waveform is padded with zeros at both ends, to avoid abrupt edges on ACF images. In complex sounds, different frequencies fade out at different pace, which gives the distinctive shape to their ACF images.

Vowel sounds below taken from the [IPA table](https://en.wikipedia.org/wiki/Vowel) on Wikipedia. Tag "ncnfr" means [near-close near-front rounded](https://en.wikipedia.org/wiki/Near-close_near-front_rounded_vowel). Images are clickable.

[![](img/xs/cbr.jpg)](img/xl/cbr.jpg) [![](img/xs/cbu.jpg)](img/xl/cbu.jpg) [![](img/xs/ccr.jpg)](img/xl/ccr.jpg) [![](img/xs/ccu.jpg)](img/xl/ccu.jpg) [![](img/xs/cfr.jpg)](img/xl/cfr.jpg) [![](img/xs/cfu.jpg)](img/xl/cfu.jpg) [![](img/xs/cmbr.jpg)](img/xl/cmbr.jpg) [![](img/xs/cmbu.jpg)](img/xl/cmbu.jpg) [![](img/xs/cmcr.jpg)](img/xl/cmcr.jpg) [![](img/xs/cmcu.jpg)](img/xl/cmcu.jpg) [![](img/xs/cmfr.jpg)](img/xl/cmfr.jpg) [![](img/xs/cmfu.jpg)](img/xl/cmfu.jpg) [![](img/xs/mcv.jpg)](img/xl/mcv.jpg) [![](img/xs/ncnbr.jpg)](img/xl/ncnbr.jpg) [![](img/xs/ncnfr.jpg)](img/xl/ncnfr.jpg) [![](img/xs/ncnfu.jpg)](img/xl/ncnfu.jpg) [![](img/xs/nocu.jpg)](img/xl/nocu.jpg) [![](img/xs/nofu.jpg)](img/xl/nofu.jpg) [![](img/xs/obu.jpg)](img/xl/obu.jpg) [![](img/xs/ocu.jpg)](img/xl/ocu.jpg) [![](img/xs/ofr.jpg)](img/xl/ofr.jpg) [![](img/xs/omcr.jpg)](img/xl/omcr.jpg) [![](img/xs/omcu.jpg)](img/xl/omcu.jpg) [![](img/xs/omfr.jpg)](img/xl/omfr.jpg) [![](img/xs/omfu.jpg)](img/xl/omfu.jpg) [![](img/xs/probr.jpg)](img/xl/probr.jpg) [![](img/xs/profu.jpg)](img/xl/profu.jpg) [![](img/xs/prombr.jpg)](img/xl/prombr.jpg) [![](img/xs/prombu.jpg)](img/xl/prombu.jpg) 



10/2022
