import { GpuFrameBuffer } from "./framebuffer.js";
import { GpuProgram } from "./gpu-program.js";

export class GpuContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.ext = null;
    this.gl = null;
  }

  createVertexShader(source) {
    return GpuProgram.createVertexShader(this.gl, source);
  }

  createFragmentShader(source) {
    return GpuProgram.createFragmentShader(this.gl, source);
  }

  createProgram(vertexShader, fragmentShader) {
    return new GpuProgram(
      this.gl,
      vertexShader,
      fragmentShader);
  }

  prepareFrameBuffer(width, height, channels = 1) {
    let gl = this.gl;
    let type = this.ext.floatTexType;
    let fmt = this.getTextureFormat(channels);

    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, width, height, 0, fmt.format, type, null);

    let fbo = gl.createFramebuffer();

    return {
      texture,
      fbo,
      fmt,
      type,
      width,
      height,
    };
  }

  createFrameBuffer(size, channels = 1) {
    return new GpuFrameBuffer(this, { size, channels });
  }

  getTextureFormat(components) {
    return components == 1 ? this.ext.formatR :
      components == 2 ? this.ext.formatRG :
        this.ext.formatRGBA;
  }

  init() {
    let canvas = this.canvas;
    console.log('Initializing WebGL');

    let params = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    };

    let gl = canvas.getContext('webgl2', params);
    let isWebGL2 = !!gl;

    if (!isWebGL2) {
      console.warn('WebGL 2.0 unavailable');
      gl = canvas.getContext('webgl', params) ||
        canvas.getContext('experimental-webgl', params);
    }

    if (!gl) {
      console.warn('getContext("webgl") blocked by getContext("2d")?');
      throw new Error('Cannot get WebGL context');
    }

    console.log('WebGL context v' + gl.VERSION, 'available at window.gl');
    window.gl = gl;

    if (isWebGL2)
      gl.getExtension('EXT_color_buffer_float');

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    let floatTexType = isWebGL2 ?
      gl.FLOAT :
      gl.getExtension('OES_texture_float').FLOAT_OES;

    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2) {
      formatRGBA = this.getSupportedFormat(gl, gl.RGBA32F, gl.RGBA, floatTexType);
      formatRG = this.getSupportedFormat(gl, gl.RG32F, gl.RG, floatTexType);
      formatR = this.getSupportedFormat(gl, gl.R32F, gl.RED, floatTexType);
    } else {
      formatRGBA = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, floatTexType);
      formatRG = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, floatTexType);
      formatR = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, floatTexType);
    }

    this.gl = gl;

    this.ext = {
      formatRGBA,
      formatRG,
      formatR,
      floatTexType,
    };

    this.initVertexBufferSquare();
  }

  // 4 vertices, 2 triangles covering the -1 < x,y < +1 square.
  initVertexBufferSquare() {
    let vertices = new Float32Array([
      -1, -1, // LB
      -1, +1, // LT
      +1, +1, // RT
      +1, -1, // RB
    ]);

    let vindexes = new Uint32Array([
      0, 1, 2, // LB-LT-RT
      0, 2, 3, // LB-RT-RB
    ]);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, vindexes, gl.STATIC_DRAW);

    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
  }

  getSupportedFormat(gl, internalFormat, format, type) {
    if (!this.supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R32F:
          return this.getSupportedFormat(gl, gl.RG32F, gl.RG, type);
        case gl.RG32F:
          return this.getSupportedFormat(gl, gl.RGBA32F, gl.RGBA, type);
        default:
          return null;
      }
    }

    return {
      internalFormat,
      format
    }
  }

  supportRenderTextureFormat(gl, internalFormat, format, type) {
    let texture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status == gl.FRAMEBUFFER_COMPLETE;
  }
}
