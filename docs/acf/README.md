# The AutoCorrelation Function

ACF is a simple method to visualize music that produces surprisingly good results. Perhaps the most unexpected property of ACF is that it accurately transfers the subjective "harmony level" from music to images: if we could define a function `H(sound)` that gives `0` to the ugliest sound possible (e.g. nails on chalkboard) and `1` to the most harmonical sound, and similar for images, then it seems that `H(sound) = H(ACF(sound))`, where `ACF(sound) = image`. It's almost an unreasonable property, if you think about it.

Live demo: [https://soundshader.github.io/?s=acf](https://soundshader.github.io/?s=acf)

First, a few examples from David Parsons:

![](../../pics/acf-1.png)

![](../../pics/acf-2.png)

![](../../pics/acf-3.png)

![](../../pics/acf-4.png)

Now a few soundtracks from Quake 2:

![](../../pics/acf-5.png)

![](../../pics/acf-6.png)

![](../../pics/acf-7.png)

![](../../pics/acf-8.png)

Just by looking at these images we can make a good guess how the musical pieces behind them sound.

# Why ACF matches our perception of sound

Contrary to what you might think, our ears don't seem to rely on an FFT-like process to extract isolated frequencies. Instead, our ears detect periodic parts in the signal, although in most cases those periodic parts closely match the FFT frequencies. There is a simple [experiment](https://auditoryneuroscience.com/pitch/missing-fundamental-stimuli) that proves this point:

![](https://auditoryneuroscience.com/sites/default/files/missingFundamental2.png)

As can be clearly seen on the FFT image, the A signal is a pure sinusoidal tone, while B is a mix of tones. Despite each tone in B is higher than A, our ears perceive B as a lower tone. However if we plot both waveforms, we'll see that A has about 9 peaks in a 20 ms window, while B has only 5. The definition of "peak" is moot, but it doesn't stop our ears from counting them and using the "number of peaks per second" as a proxy to the tone height, while the little wavelets on the B (red) waveform will "color" the tone, i.e. will define its perceived timbre.

ACF detects those peaks. ACF sees that there are 5 equally spaced time shifts where `B[t] * B[t + shift]` reaches the maximum, so on the ACF output we'll see those 5 peaks.

> Given that I've shamelessly stolen the experiment's illustration above, I feel obligated to recommend the book where the illustration came from: [Auditory Neuroscience](https://auditoryneuroscience.com/book-preview).

One downside of ACF is that it drops the phase component of the input signal, and thus ACF is not reversible. This means that images that only render ACF, lose about 50% of the information from the sound and those 50% are important, e.g. dropping the phase from recorded speech makes that speech indiscernible. Real world sounds, such as voice, heavily use nuanced amplitude and phase modulation. ACF captures the former, but ignores the latter.
