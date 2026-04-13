import { createArrayBuffer, createProgram } from "./glUtils";

export type OverlayHeatmapLevel = {
  price: number;
  size: number;
  intensity: number;
  side: "bid" | "ask";
};

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aLocal;
layout(location = 1) in float aCenterY;
layout(location = 2) in float aHalfHeight;
layout(location = 3) in float aVolume;
layout(location = 4) in float aSide;

out vec2 vLocal;
out float vVolume;
out float vSide;

void main() {
  vLocal = aLocal;
  vVolume = aVolume;
  vSide = aSide;
  gl_Position = vec4(aLocal.x, aCenterY + aLocal.y * aHalfHeight, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vLocal;
in float vVolume;
in float vSide;
uniform float uAlpha;
uniform float uHeatIntensity;
uniform float uDiscardThreshold;
uniform float uVolumeLogScale;
out vec4 outColor;

void main() {
  float intensity = clamp((log(vVolume + 1.0) * uHeatIntensity) / max(0.0001, uVolumeLogScale), 0.0, 1.0);
  if (intensity < uDiscardThreshold) {
    discard;
  }
  float edgeFade = 1.0 - smoothstep(0.84, 1.0, abs(vLocal.y));
  float horizontalGlow = 0.84 + smoothstep(1.0, 0.0, abs(vLocal.x)) * 0.16;
  float alpha = clamp(uAlpha * intensity * edgeFade * horizontalGlow, 0.0, 0.26);
  vec3 bidTone = vec3(0.10, 0.60, 1.00);
  vec3 askTone = vec3(1.00, 0.30, 0.10);
  vec3 tone = mix(bidTone, askTone, step(0.5, vSide));
  tone *= 0.55 + intensity * 0.75;
  outColor = vec4(clamp(tone, 0.0, 1.0), alpha);
}
`;

const INSTANCE_STRIDE_FLOATS = 4;
const MAX_HEATMAP_LEVELS = 50;

export class OverlayLayer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private instanceBuffer: WebGLBuffer;
  private instanceData = new Float32Array(MAX_HEATMAP_LEVELS * INSTANCE_STRIDE_FLOATS);
  private alphaLocation: WebGLUniformLocation | null;
  private heatIntensityLocation: WebGLUniformLocation | null;
  private discardLocation: WebGLUniformLocation | null;
  private volumeLogScaleLocation: WebGLUniformLocation | null;
  private signatureByViewport = new Map<string, string>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.alphaLocation = gl.getUniformLocation(this.program, "uAlpha");
    this.heatIntensityLocation = gl.getUniformLocation(this.program, "uHeatIntensity");
    this.discardLocation = gl.getUniformLocation(this.program, "uDiscardThreshold");
    this.volumeLogScaleLocation = gl.getUniformLocation(this.program, "uVolumeLogScale");

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

    this.quadBuffer = createArrayBuffer(gl, quad, gl.STATIC_DRAW);
    this.instanceBuffer = createArrayBuffer(gl, this.instanceData, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 2 * 4, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, INSTANCE_STRIDE_FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, INSTANCE_STRIDE_FLOATS * 4, 4);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, INSTANCE_STRIDE_FLOATS * 4, 8);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, INSTANCE_STRIDE_FLOATS * 4, 12);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  draw(input: {
    viewportId: string;
    alpha: number;
    heatIntensity?: number;
    discardThreshold?: number;
    heatmapLevels?: OverlayHeatmapLevel[];
    minPrice: number;
    maxPrice: number;
  }): void {
    const { viewportId, alpha, heatIntensity = 1, discardThreshold = 0.018, heatmapLevels = [], minPrice, maxPrice } = input;
    const count = this.writeHeatmapLevels(viewportId, heatmapLevels, minPrice, maxPrice);
    if (count <= 0) {
      return;
    }

    const gl = this.gl;
    gl.useProgram(this.program);
    if (this.alphaLocation) {
      gl.uniform1f(this.alphaLocation, alpha);
    }
    if (this.heatIntensityLocation) {
      gl.uniform1f(this.heatIntensityLocation, Math.min(3, Math.max(0.5, heatIntensity)));
    }
    if (this.discardLocation) {
      gl.uniform1f(this.discardLocation, Math.min(0.2, Math.max(0.01, discardThreshold)));
    }
    const maxVolume = heatmapLevels.slice(0, MAX_HEATMAP_LEVELS).reduce((max, level) => Math.max(max, Number(level.size) || 0), 1);
    if (this.volumeLogScaleLocation) {
      gl.uniform1f(this.volumeLogScaleLocation, Math.max(1, Math.log(maxVolume + 1)));
    }
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  private writeHeatmapLevels(viewportId: string, levels: OverlayHeatmapLevel[], minPrice: number, maxPrice: number): number {
    const span = Math.max(1e-6, maxPrice - minPrice);
    if (!(span > 0) || levels.length === 0) {
      return 0;
    }

    const visibleLevels = [...levels]
      .filter((level) => Number.isFinite(level.price) && level.price >= minPrice && level.price <= maxPrice)
      .sort((left, right) => {
        const leftScore = (left.intensity || 0) * 0.55 + Math.log1p(Math.max(0, left.size || 0)) * 0.45;
        const rightScore = (right.intensity || 0) * 0.55 + Math.log1p(Math.max(0, right.size || 0)) * 0.45;
        return rightScore - leftScore;
      })
      .slice(0, MAX_HEATMAP_LEVELS);

    if (visibleLevels.length === 0) {
      return 0;
    }

    const signature = visibleLevels
      .map((level) => `${level.side}:${Math.round(level.price * 1000)}:${Math.round((level.size || 0) * 100)}:${Math.round((level.intensity || 0) * 1000)}`)
      .join("|");

    if (this.signatureByViewport.get(viewportId) !== signature) {
      const visibleBandHeightPrice = Math.max(span / 180, Math.min(span / 40, span * 0.009));
      for (let index = 0; index < visibleLevels.length; index += 1) {
        const level = visibleLevels[index];
        const base = index * INSTANCE_STRIDE_FLOATS;
        const centerY = (((level.price - minPrice) / span) * 2) - 1;
        const halfHeight = Math.min(0.075, Math.max(0.006, ((visibleBandHeightPrice * (0.78 + (level.intensity || 0) * 0.65)) / span) * 2));
        this.instanceData[base + 0] = centerY;
        this.instanceData[base + 1] = halfHeight;
        this.instanceData[base + 2] = Math.max(0, Number(level.size) || 0);
        this.instanceData[base + 3] = level.side === "ask" ? 1 : 0;
      }
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, visibleLevels.length * INSTANCE_STRIDE_FLOATS));
      this.signatureByViewport.set(viewportId, signature);
    }

    return visibleLevels.length;
  }
}
