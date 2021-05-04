# Highres spectrograms with the DFT Shift Theorem

Demo: [soundshader.github.io/hss](https://soundshader.github.io/hss).

A typical FFT-based spectrogram uses 1024 bins on a 48 kHz audio, with about 50 Hz step per pixel. Most of the interesting audio activity happens below 3 kHz, so 50 Hz per pixel gives only 60 pixels for that area. As a result, the spectrogram is pixelated. One way to get highres spectrograms is to use CWT (continuous wavelet transform), but it's messy to implement. Another trick is to use regular FFT shifted by 1/2 pixel (by 25 Hz): the [DFT Shift Theorem](https://en.wikipedia.org/wiki/Discrete_Fourier_transform#Shift_theorem) enables such frequency shifting by multiplying the input signal by `exp(-i*pi*k/N)`. Smoothness in the time direction is easier to achieve: the 1024 bins window can be advanced by arbitrarily small time steps.

Images below use an HSV-based color scheme:

- H is the weighted sum of the rainbow palette where log-scaled FFT amplitudes are weights.
- S is `1.0 - FFT[i]^2 / max FFT^2`, i.e. the max FFT amplitude has 0 saturation or just white.
- V is the log-scaled FFT amplitude.

Click the images to see fullres versions.

## Bird songs

Bird songs recordings were taken from www.fssbirding.org.uk/sonagrams.htm. Unlike musical instruments, birds don't seem to bother to create a complex multi-layered harmonics pattern. Instead, they create a complex pattern with the base (fundamental) frequency alone. The "cloud" above the main drawing is what would be the 2nd harmonic. These sonograms are remarkably different from other sounds, as if birds "draw" with sound something that's flying backwards in time.

[![](bird/1.jpg)](bird/1.png)
[![](bird/2.jpg)](bird/2.png)
[![](bird/3.jpg)](bird/3.png)
[![](bird/4.jpg)](bird/4.png)
[![](bird/5.jpg)](bird/5.png)
[![](bird/6.jpg)](bird/6.png)
[![](bird/7.jpg)](bird/7.png)
[![](bird/8.jpg)](bird/8.png)
[![](bird/9.jpg)](bird/9.png)
[![](bird/10.jpg)](bird/10.png)
[![](bird/11.jpg)](bird/11.png)
[![](bird/12.jpg)](bird/12.png)
[![](bird/13.jpg)](bird/13.png)
[![](bird/14.jpg)](bird/14.png)

Compare this with CWT and standard FFT (no overlapping frames, a fixed set of frequencies):

[![](comp/cwt.jpg)](comp/cwt.png)
[![](comp/fft-1.jpg)](comp/fft-1.png)
[![](comp/fft-2.jpg)](comp/fft-2.png)

The CWT spectrogram was obtained with [soundshader.github.io/?s=cwt](https://soundshader.github.io/?s=cwt). Despite this CWT implementation runs on GPU and this "advanced" FFT runs on JS, CWT is about 50-100x slower.

## Bongo

[![](bongo/1.jpg)](bongo/1.png)
[![](bongo/2.jpg)](bongo/2.png)
[![](bongo/3.jpg)](bongo/3.png)

## Flute

Musical instruments usually have this multi-level harmonics structure. Flute is one of the simplest instruments, with first 2 harmonics dominating the spectrum. However it would be a mistake to to call flute sound simple: as you see, every level has its own regular pattern that can't be recreated with a simple mix of sinusoidal tones.

[![](flute/1.jpg)](flute/1.png)

## Guitar

[![](guitar/1.jpg)](guitar/1.png)
[![](guitar/2.jpg)](guitar/2.png)

## Piano

[![](piano/1.jpg)](piano/1.png)
[![](piano/2.jpg)](piano/2.png)
[![](piano/3.jpg)](piano/3.png)

## Violin

Viloin is the most instresting: on levels 8 and 9 it creates an intricate ornament. I don't know if it's a feature or a defect of the instrument. It's interesting that our ears collapse the entire 20-story harmonics tower with all these different ornaments on different floors into a single tone.

[![](violin/1.jpg)](violin/1.png)
[![](violin/2.jpg)](violin/2.png)
[![](violin/3.jpg)](violin/3.png)
[![](violin/4.jpg)](violin/4.png)
[![](violin/5.jpg)](violin/5.png)

## Voice

The bright lines are vowel formants: a pair or triple of them uniquely identify a vowel. Each greenish column is a word, usually consisting of two vowels. The horizontal bar is a bell. Vowels have pretty complex structure and look like a mix of bird songs with musical instruments, as they also have harmonics.

[![](voice/1.jpg)](voice/1.png)
[![](voice/2.jpg)](voice/2.png)
[![](voice/3.jpg)](voice/3.png)

## GitHub

[soundshader/soundshader.github.io](https://github.com/soundshader/soundshader.github.io)

