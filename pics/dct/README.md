# The Lesser-Known Side of Discrete Cosine Transform

The 8 pictures below represent a [1 sec audio sample](1sec.ogg) (some tibetan bowl).

|  |  |  |  |
|--|--|--|--|
| k=8m+0, +5dB, 12% [![](t.8-0-76db.jpg)](8-0-76db.jpg) | k=8m+1, +10dB, 21% [![](t.8-1-72db.jpg)](8-1-72db.jpg) | k=8m+2, +12dB, 26% [![](t.8-2-70db.jpg)](8-2-70db.jpg) | k=8m+3, +8dB, 16% [![](t.8-3-73db.jpg)](8-3-73db.jpg) |
| k=8m+4, +2dB, 8% [![](t.8-4-78db.jpg)](8-4-78db.jpg) | k=8m+5, -2dB, 5% [![](t.8-5-80db.jpg)](8-5-80db.jpg) | k=8m+6, -1db, 6% [![](t.8-6-80db.jpg)](8-6-80db.jpg) | k=8m+7, 0dB, 7% [![](t.8-7-80db.jpg)](8-7-80db.jpg) |

First, the audio sample is decoded at 48 kHz, split into 2048 overlapping frames with 2048 samples each, each frame is analyzed with DCT + the Hann window function. The result is a more or less standard spectrogram. Colors correspond to the A-G notes.

[![](t.dct-1.jpg)](dct-1.jpg)

From the DCT's point of view, each frame is a sum of `A[k]*cos(2pi*k*t/N)` waves, where `A[k]` are real amplitudes and `k` are frequencies (`N=2048`). This is what happens when we select only `k=2m` or `k=8m+5` frequencies:

[![](t.dct-2.jpg)](dct-2.jpg)
[![](t.dct-8.jpg)](dct-8.jpg)

The last trick is squaring the amplitudes and applying the inverse DCT. The idea is that all the `k=8m+5` cosine waves can be combined back into a time-domain signal. This corresponds to convolving the original signal with a certain kernel. Each cosine wave is colored according to its frequency, so their sum appears quite colorful:

[![](t.acf-8.jpg)](acf-8.jpg)

This procedure can be repeated for each remainder `k=8m+r`, `r=0..7`, producing 8 pictures. Cosine waves are symmetric (even), so they look better in polar coordinates, as shown above. The sum of squared amplitudes corresponds to weight of each picture, e.g. if the total sum `A[0]^2+...A[N-1]^2 = 1`, then `sum A[8m+2]^2 = 0.26`, so the third picture contributes 1/4 to the total.
