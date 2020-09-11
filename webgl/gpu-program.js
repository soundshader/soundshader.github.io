const SHADER_PREFACE = `
  #version 300 es
  precision highp float;
  precision highp int;
`;

const VSHADER_PREFACE = `
  // TODO
`;

const FSHADER_PREFACE = `
  out vec4 v_FragColor;
`;

export class GpuProgram {
  constructor(gl, vertexShader, fragmentShader, nPoints) {
    this.gl = gl;
    this.uniforms = {};
    this.program = GpuProgram.createProgram(gl, vertexShader, fragmentShader);
    // uniforms[0] = {type:5,size:2,name:"uInput"}
    // uniforms["uInput"] = 32
    this.uniforms = this.getUniforms();
  }

  bind() {
    this.gl.useProgram(this.program);
  }

  getUniforms() {
    let gl = this.gl;
    let program = this.program;
    let uniforms = [];
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
      let uniform = gl.getActiveUniform(program, i);
      // "uniform float x[3]" appears as {name:"x[0]", size:3}
      let name = /^\w+/.exec(uniform.name)[0];
      let uid = gl.getUniformLocation(program, name);
      uniforms[name] = uid;
      uniforms[i] = uniform;
    }
    return uniforms;
  }

  static blit(gl, output) {
    let w = output ? output.width : gl.drawingBufferWidth;
    let h = output ? output.height : gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, output ? output.fbo : null);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_INT, 0);
  }

  static createProgram(gl, vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw gl.getProgramInfoLog(program);

    return program;
  }

  static prepareShader(source, type) {
    return [
      SHADER_PREFACE,
      type == gl.VERTEX_SHADER ?
        VSHADER_PREFACE :
        FSHADER_PREFACE,
      source,
    ].join('\n').trim();
  }

  static createFragmentShader(gl, source) {
    return GpuProgram.createShader(
      gl, gl.FRAGMENT_SHADER, source);
  }

  static createVertexShader(gl, source) {
    return GpuProgram.createShader(
      gl, gl.VERTEX_SHADER, source);
  }

  static createShader(gl, type, source) {
    const source2 = GpuProgram.prepareShader(source, type);
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source2);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      GpuProgram.reportError(shader, source2);

    return shader;
  }

  static reportError(shader, source) {
    let log = gl.getShaderInfoLog(shader);
    let [, col, row] = /^ERROR: (\d+):(\d+):/.exec(log) || [];

    if (row) {
      let lines = source.split(/\n/g);
      let line = lines[+row - 1];
      console.info('Error at line ' + row + ':', line.trim());
    }

    console.groupCollapsed('Failed shader:');
    console.log(source);
    console.groupEnd();

    throw new Error(log);
  }
}