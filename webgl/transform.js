import { GpuProgram } from "./gpu-program.js";
import { vShaderCopy, fShaderCopy } from "../glsl/basics.js";
import { GpuFrameBuffer } from "./framebuffer.js";

// This is a "GPU transformer node" that takes a few inputs
// and runs the fragment shader to produce one output buffer.
// In the final node that writes the RGBA output to canvas
// there is no output buffer.
export class GpuTransformProgram {
  constructor(glctx, {
    size = 0, // When the output is the canvas, there is no output buffer.
    width = 0,
    height = 0,
    channels = 1,
    vshader,
    fshader,
  } = {}) {
    this.glctx = glctx;
    width = width || size;
    height = height || size;
    this.output = width * height && new GpuFrameBuffer(glctx, { width, height, channels });
    this.init({ vshader, fshader });
  }

  init({ vshader, fshader }) {
    let glctx = this.glctx;
    this.vertexShader = glctx.createVertexShader(vshader || vShaderCopy);
    this.fragmentShader = glctx.createFragmentShader(fshader || fShaderCopy);
    this.program = glctx.createProgram(
      this.vertexShader,
      this.fragmentShader);
  }

  exec(args = {}, output = this.output) {
    if (output == GpuFrameBuffer.DUMMY)
      return;
    let gl = this.glctx.gl;
    let gp = this.program;
    gp.bind();
    this.bindArgs(args);
    GpuProgram.blit(gl, output);
  }

  bindArgs(args) {
    let gl = this.glctx.gl;
    let gp = this.program;
    let nSamplers = 0;

    for (let u of gp.uniforms) {
      let arg = args[u.name];
      let uptr = gp.uniforms[u.name];

      if (arg === undefined)
        throw new Error('Missing uniform arg: ' + u.name);

      if (u.size != 1)
        throw new Error(`Uniform ${u.name} has size ${u.size} > 1`);

      switch (u.type) {
        case gl.SAMPLER_2D:
          if (!arg) throw new Error('Missing sampler2D: ' + u.name);
          gl.uniform1i(uptr, arg.attach(nSamplers++));
          break;
        case gl.BOOL:
        case gl.INT:
          gl.uniform1i(uptr, arg);
          break;
        case gl.UNSIGNED_INT:
          gl.uniform1ui(uptr, arg);
          break;
        case gl.FLOAT:
          gl.uniform1f(uptr, arg);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2f(uptr, ...arg);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3f(uptr, ...arg);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4f(uptr, ...arg);
          break;
        default:
          throw new Error(`Unknown uniform type ${u.type} for ${u.name}`);
      }
    }
  }
}
