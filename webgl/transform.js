import { GpuProgram } from "./gpu-program.js";
import { vShaderCopy, fShaderCopy } from "../glsl/basics.js";

// This is a "GPU transformer node" that takes a few inputs
// and runs the fragment shader to produce one output buffer.
// In the final node that writes the RGBA output to canvas
// there is no output buffer.
export class GpuTransformProgram {
  constructor(glctx, {
    size = 0, // When the output is the canvas, there is no output buffer.
    channels = 1,
    vshader = vShaderCopy,
    fshader = fShaderCopy,
  }) {
    this.glctx = glctx;
    this.output = size > 0 && glctx.createFrameBuffer(size, channels);
    this.vertexShader = glctx.createVertexShader(vshader);
    this.fragmentShader = glctx.createFragmentShader(fshader);
    this.program = glctx.createProgram(
      this.vertexShader,
      this.fragmentShader);
  }

  exec(args = {}, output = this.output) {
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
        throw new Error('Missing uniform arg:', u.name);

      if (u.size != 1)
        throw new Error(`Uniform ${u.name} has size ${u.size} > 1`);

      switch (u.type) {
        case gl.SAMPLER_2D:
          gl.uniform1i(uptr, arg.attach(nSamplers++));
          break;
        case gl.INT:
          gl.uniform1i(uptr, arg);
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
