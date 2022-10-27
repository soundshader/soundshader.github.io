# Visual Morphology of Vowels

Demo: [soundshader.github.io/acf-v2](https://soundshader.github.io/acf-v2)

Images below are auto-correlation spectrograms of vowels.

- Definition of auto-correlation: `ACF(X)=FFT[abs(FFT(X))^2]`. It splits input `X` into `amp*cos(freq*t+phi)` waves, drops phases `phi` and squares amplitudes `amp`. For this reason, `ACF(X)` is a symmetric function.
- The ACF images below render `abs(ACF(X))/max(abs(ACF(X)))`. The ACF values aren't squared and aren't log10-scaled.
- Low frequencies and high frequencies are rendered with different colors by applying bandpass filters: `FFT[BPF*abs(FFT(X))^2]`. The low frequency ACF is rendered with color `(12,3,1)` and the high frequency ACF - with color `(1,3,12)`. Oversaturation allows to reveal more details without resorting to log10-scaling (which doesn't look good).
- Sample rate: 16 kHz. Frame size: 4096. The rule of thumb: frame size = 1/4 of sample rate. This means that one ACF frame captures 1/4 sec of sound, and the frames overlap heavily.
- The waveform is padded with zeros at both ends, to avoid abrupt edges on ACF images. In complex sounds, different frequencies fade out at different pace, which gives the distinctive shape to their ACF images.

Click on the image below to see its high-res version.

[![](img/xs.jpg)](img/xl.jpg)

Below are all the vowel sounds I could find on wikipedia.

![](img/10.jpg) ![](img/11.jpg) ![](img/12.jpg) ![](img/13.jpg) ![](img/14.jpg) ![](img/15.jpg) ![](img/16.jpg) ![](img/17.jpg) ![](img/18.jpg) ![](img/19.jpg) ![](img/1.jpg) ![](img/20.jpg) ![](img/21.jpg) ![](img/22.jpg) ![](img/23.jpg) ![](img/24.jpg) ![](img/25.jpg) ![](img/26.jpg) ![](img/27.jpg) ![](img/28.jpg) ![](img/29.jpg) ![](img/2.jpg) ![](img/30.jpg) ![](img/3.jpg) ![](img/4.jpg) ![](img/5.jpg) ![](img/6.jpg) ![](img/7.jpg) ![](img/8.jpg) ![](img/9.jpg)

10/2022
