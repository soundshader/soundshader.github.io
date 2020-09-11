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

    let args = glctx.prepareFrameBuffer(width, height, channels);

    this.gl = glctx.gl;
    this.width = args.width;
    this.height = args.height;
    this.texture = args.texture;
    this.fbo = args.fbo;
    this.fmt = args.fmt;
    this.type = args.type;
    this.source = source;

    this.clear();
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
    let level = 0; // mipmap
    let border = 0;
    let offset = 0;

    gl.activeTexture(gl.TEXTURE0 + id);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    if (this.source) {
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
        this.source,
        offset);
    }

    return id;
  }
}
