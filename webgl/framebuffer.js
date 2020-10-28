const MAX_BUFFER_SIZE = 2 ** 29;

export class GpuFrameBuffer {
  constructor(glctx, {
    size,
    width,
    height,
    channels = 1,
    // This GPU framebuffer can be bound to a JS ArrayBuffer,
    // so every time this framebuffer is bound to a fragment
    // shader, the CPU data would be copied to GPU.
    source = null,
  }) {
    if (source && !(source instanceof Float32Array))
      throw new Error(`Texture can be bound only to a Float32Array`);

    if (size && (width || height))
      throw new Error(`Can't set size and width x height at the same time`);

    if (size) {
      width = size;
      height = size;
    }

    let fb_size = width * height * channels * 4;
    let spec = `${width}x${height}x${channels}`;
    let note = `${spec} = ${fb_size >> 20} MB`;

    if (fb_size > MAX_BUFFER_SIZE)
      throw new Error(`FBO too large: ${note}`);

    if (fb_size > 2 ** 23)
      console.log(`Allocating a GPU buffer: ${note}`);

    let args = glctx.prepareFrameBuffer(width, height, channels);

    this.width = args.width;
    this.height = args.height;
    this.channels = channels;
    this.texture = args.texture;
    this.fbo = args.fbo;
    this.fmt = args.fmt;
    this.type = args.type;
    this.source = source;
    this.gl = glctx.gl;

    this.clear();
  }

  // Moves data from GPU to CPU. Beware that doing this at 60 fps,
  // even if the texture is 1x1, kills the performance entirely.
  download(output = new Float32Array(this.width * this.height * this.channels),
    x = 0, y = 0, width = this.width, height = this.height) {

    if (output.length != width * height * this.channels)
      throw new Error('Invalid CPU buffer length: ' + output.length);

    let gl = this.gl;

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this.texture, 0);

    this.tempbuf = this.tempbuf ||
      new Float32Array(this.width * this.height * 4);

    gl.readPixels(x, y, width, height,
      gl.RGBA /* this.fmt.format */, this.type, this.tempbuf);

    // This is ugly. readPixels() should really work with gl.RG.
    for (let i = 0; i < width * height; i++)
      for (let j = 0; j < this.channels; j++)
        output[i * this.channels + j] = this.tempbuf[i * 4 + j];

    return output;
  }

  clear() {
    let gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, this.texture, 0);
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  attach(id) {
    let gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + id);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.source)
      this.upload(this.source);
    return id;
  }

  upload(source) {
    let gl = this.gl;
    let level = 0; // mipmap
    let border = 0;
    let offset = 0;
    let type = this.type;
    let fmt = this.fmt;
    // gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    // gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      level,
      fmt.internalFormat,
      this.width,
      this.height,
      border,
      fmt.format,
      type,
      source,
      offset);
  }
}

GpuFrameBuffer.DUMMY = 'dummy';
