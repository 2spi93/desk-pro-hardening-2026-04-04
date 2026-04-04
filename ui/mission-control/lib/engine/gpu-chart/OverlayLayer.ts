import { createArrayBuffer, createProgram } from "./glUtils";

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
uniform float uAlpha;
uniform float uTimeMs;
uniform float uFocusY;
uniform float uDiscardThreshold;
out vec4 outColor;

void main() {
  float wave = 0.5 + 0.5 * sin(vUv.x * 20.0 + uTimeMs * 0.002);
  float band = exp(-abs(vUv.y - uFocusY) * 14.0);
  float intensity = wave * band;
  if (intensity < uDiscardThreshold) discard;
  vec3 tone = mix(vec3(0.04, 0.14, 0.22), vec3(0.10, 0.42, 0.70), intensity);
  outColor = vec4(tone, clamp(uAlpha * intensity * 0.24, 0.0, 0.14));
}
`;

export class OverlayLayer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private alphaLocation: WebGLUniformLocation | null;
  private timeLocation: WebGLUniformLocation | null;
  private focusLocation: WebGLUniformLocation | null;
  private discardLocation: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.alphaLocation = gl.getUniformLocation(this.program, "uAlpha");
    this.timeLocation = gl.getUniformLocation(this.program, "uTimeMs");
    this.focusLocation = gl.getUniformLocation(this.program, "uFocusY");
    this.discardLocation = gl.getUniformLocation(this.program, "uDiscardThreshold");

    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("gpu_overlay_vao_failed");
    }
    this.vao = vao;

    const quad = new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      1, 1,
    ]);

    this.buffer = createArrayBuffer(gl, quad, gl.STATIC_DRAW);

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

  draw(frameTimeMs: number, alpha: number, focusY: number, discardThreshold = 0.018): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    if (this.alphaLocation) {
      gl.uniform1f(this.alphaLocation, alpha);
    }
    if (this.timeLocation) {
      gl.uniform1f(this.timeLocation, frameTimeMs);
    }
    if (this.focusLocation) {
      gl.uniform1f(this.focusLocation, focusY);
    }
    if (this.discardLocation) {
      gl.uniform1f(this.discardLocation, Math.min(0.08, Math.max(0.0, discardThreshold)));
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
