import { createArrayBuffer, createProgram } from "./glUtils";

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec4 uColor;
out vec4 outColor;

void main() {
  outColor = uColor;
}
`;

export class GridLayer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private vertexCount = 0;
  private colorLocation: WebGLUniformLocation | null;
  private gridSignature = "";

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.colorLocation = gl.getUniformLocation(this.program, "uColor");

    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("gpu_grid_vao_failed");
    }
    this.vao = vao;

    const vertices = buildGridVertices(8, 6);
    this.vertexCount = vertices.length / 2;
    this.buffer = createArrayBuffer(gl, vertices, gl.DYNAMIC_DRAW);
    this.gridSignature = "8|6";

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 2 * 4, 0);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  draw(options?: { verticalLines?: number; horizontalLines?: number; alpha?: number }): void {
    const gl = this.gl;
    const verticalLines = Math.max(2, Math.floor(options?.verticalLines ?? 8));
    const horizontalLines = Math.max(2, Math.floor(options?.horizontalLines ?? 6));
    const alpha = Math.min(0.18, Math.max(0.0, options?.alpha ?? 0.06));
    this.ensureGeometry(verticalLines, horizontalLines);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    if (this.colorLocation) {
      gl.uniform4f(this.colorLocation, 1.0, 1.0, 1.0, alpha);
    }
    gl.drawArrays(gl.LINES, 0, this.vertexCount);
    gl.bindVertexArray(null);
  }

  private ensureGeometry(verticalCount: number, horizontalCount: number): void {
    const signature = `${verticalCount}|${horizontalCount}`;
    if (signature === this.gridSignature) {
      return;
    }
    this.gridSignature = signature;

    const gl = this.gl;
    const vertices = buildGridVertices(verticalCount, horizontalCount);
    this.vertexCount = vertices.length / 2;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
  }
}

function buildGridVertices(verticalCount: number, horizontalCount: number): Float32Array {
  const values: number[] = [];

  for (let index = 0; index <= verticalCount; index += 1) {
    const t = index / Math.max(1, verticalCount);
    const x = t * 2 - 1;
    values.push(x, -1, x, 1);
  }

  for (let index = 0; index <= horizontalCount; index += 1) {
    const t = index / Math.max(1, horizontalCount);
    const y = t * 2 - 1;
    values.push(-1, y, 1, y);
  }

  return new Float32Array(values);
}
