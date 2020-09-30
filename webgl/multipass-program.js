import { GpuTransformProgram } from "./transform.js";
import { GpuFrameBuffer } from "./framebuffer.js";

export class GpuMultiPassProgram {
  constructor(webgl, { size, channels, layers, layerShader, colorShader }) {
    this.webgl = webgl;
    this.layers = layers;
    this.buffer = new GpuFrameBuffer(webgl, { size, channels });
    this.layer = new GpuTransformProgram(webgl, { fshader: layerShader });
    this.colorizer = new GpuTransformProgram(webgl, { fshader: colorShader });

  }

  exec(args, output) {
    this.buffer.clear();
    let gl = this.webgl.gl;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    for (let k = 0; k < this.layers; k++) {
      this.layer.exec({
        uLayerIndex: k,
        ...args,
      }, this.buffer);
    }

    gl.disable(gl.BLEND);

    this.colorizer.exec({
      uInput: this.buffer,
      ...args,
    }, output);
  }
}
