emcc ./fft.c -O3 -msimd128 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS="['_malloc','_free']" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s FILESYSTEM=0 \
  -o ./fft-native.js;
