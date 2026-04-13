import { createArrayBuffer, createProgram } from "./glUtils";
import type { DomHistoryFrame } from "../../domHistoryBuffer";

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aLocal;
layout(location = 1) in float aCenterX;
layout(location = 2) in float aHalfWidth;
layout(location = 3) in float aCenterY;
layout(location = 4) in float aHalfHeight;
layout(location = 5) in float aVolume;
layout(location = 6) in float aSide;
layout(location = 7) in float aSpoof;

out vec2 vLocal;
out float vVolume;
out float vSide;
out float vSpoof;

void main() {
  vLocal = aLocal;
  vVolume = aVolume;
  vSide = aSide;
  vSpoof = aSpoof;
  gl_Position = vec4(aCenterX + aLocal.x * aHalfWidth, aCenterY + aLocal.y * aHalfHeight, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vLocal;
in float vVolume;
in float vSide;
in float vSpoof;
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
  float verticalFade = 1.0 - smoothstep(0.82, 1.0, abs(vLocal.y));
  float horizontalFade = 1.0 - smoothstep(0.9, 1.0, abs(vLocal.x));
  float alpha = clamp(uAlpha * intensity * verticalFade * horizontalFade, 0.0, 0.58);
  vec3 dark = vec3(0.0, 0.02, 0.08);
  vec3 bidTone = vec3(0.05, 0.92, 0.98);
  vec3 askTone = vec3(1.0, 0.38, 0.12);
  vec3 tone = mix(bidTone, askTone, step(0.5, vSide));
  tone = mix(dark, tone, clamp(intensity * 1.08, 0.0, 1.0));
  if (vSpoof > 0.02) {
    tone = mix(tone, vec3(1.0, 0.92, 0.25), clamp(vSpoof * 0.55, 0.0, 0.42));
    alpha = min(0.72, alpha + vSpoof * 0.16);
  }
  outColor = vec4(clamp(tone, 0.0, 1.0), alpha);
}
`;

const INSTANCE_STRIDE_FLOATS = 7;
const MAX_HISTORY_INSTANCES = 960;

export class HeatmapHistoryLayer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private instanceBuffer: WebGLBuffer;
  private instanceData = new Float32Array(MAX_HISTORY_INSTANCES * INSTANCE_STRIDE_FLOATS);
  private alphaLocation: WebGLUniformLocation | null;
  private heatIntensityLocation: WebGLUniformLocation | null;
  private discardLocation: WebGLUniformLocation | null;
  private volumeLogScaleLocation: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.alphaLocation = gl.getUniformLocation(this.program, "uAlpha");
    this.heatIntensityLocation = gl.getUniformLocation(this.program, "uHeatIntensity");
    this.discardLocation = gl.getUniformLocation(this.program, "uDiscardThreshold");
    this.volumeLogScaleLocation = gl.getUniformLocation(this.program, "uVolumeLogScale");

    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("gpu_heatmap_history_vao_failed");
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
    for (let attribute = 1; attribute <= 7; attribute += 1) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, 1, gl.FLOAT, false, INSTANCE_STRIDE_FLOATS * 4, (attribute - 1) * 4);
      gl.vertexAttribDivisor(attribute, 1);
    }
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
    historyFrames?: DomHistoryFrame[];
    alpha: number;
    heatIntensity?: number;
    discardThreshold?: number;
    minPrice: number;
    maxPrice: number;
    minTime: number;
    maxTime: number;
  }): void {
    const {
      historyFrames = [],
      alpha,
      heatIntensity = 1,
      discardThreshold = 0.018,
      minPrice,
      maxPrice,
      minTime,
      maxTime,
    } = input;
    const result = this.writeHistoryFrames(historyFrames, minPrice, maxPrice, minTime, maxTime);
    if (result.count <= 0) {
      return;
    }

    const gl = this.gl;
    gl.useProgram(this.program);
    if (this.alphaLocation) {
      gl.uniform1f(this.alphaLocation, alpha);
    }
    if (this.heatIntensityLocation) {
      gl.uniform1f(this.heatIntensityLocation, Math.min(3.2, Math.max(0.5, heatIntensity)));
    }
    if (this.discardLocation) {
      gl.uniform1f(this.discardLocation, Math.min(0.2, Math.max(0.005, discardThreshold)));
    }
    if (this.volumeLogScaleLocation) {
      gl.uniform1f(this.volumeLogScaleLocation, Math.max(1, Math.log(result.maxVolume + 1)));
    }
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, result.count);
    gl.bindVertexArray(null);
  }

  private writeHistoryFrames(
    historyFrames: DomHistoryFrame[],
    minPrice: number,
    maxPrice: number,
    minTime: number,
    maxTime: number,
  ): { count: number; maxVolume: number } {
    const priceSpan = Math.max(1e-6, maxPrice - minPrice);
    const timeSpan = Math.max(1, maxTime - minTime);
    if (!(priceSpan > 0) || !(timeSpan > 0) || historyFrames.length === 0) {
      return { count: 0, maxVolume: 1 };
    }

    const visibleFrames = [...historyFrames]
      .filter((frame) => Number.isFinite(frame.time) && frame.time >= minTime && frame.time <= maxTime)
      .sort((left, right) => left.time - right.time)
      .slice(-56);

    if (visibleFrames.length === 0) {
      return { count: 0, maxVolume: 1 };
    }

    let cursor = 0;
    let maxVolume = 1;
    const defaultStep = visibleFrames.length > 1
      ? Math.max(1, (visibleFrames[visibleFrames.length - 1].time - visibleFrames[0].time) / Math.max(visibleFrames.length - 1, 1))
      : Math.max(1, timeSpan / 24);

    for (let frameIndex = 0; frameIndex < visibleFrames.length && cursor < MAX_HISTORY_INSTANCES; frameIndex += 1) {
      const frame = visibleFrames[frameIndex];
      const previousTime = visibleFrames[frameIndex - 1]?.time ?? (frame.time - defaultStep);
      const nextTime = visibleFrames[frameIndex + 1]?.time ?? (frame.time + defaultStep);
      const halfWidthTime = Math.max(0.5, Math.min(defaultStep * 1.35, Math.max(frame.time - previousTime, nextTime - frame.time) * 0.48));
      const centerX = (((frame.time - minTime) / timeSpan) * 2) - 1;
      const halfWidth = Math.min(0.22, Math.max(0.004, (halfWidthTime / timeSpan) * 2));
      const ageFade = Math.max(0.18, Math.min(1, ((frame.time - minTime) / timeSpan) * 0.82 + 0.18));
      const spoof = Math.max(0, Math.min(1, (Number(frame.spoofingRisk) || 0) * ageFade));
      const levels = (frame.levels || [])
        .filter((level) => Number.isFinite(level.price) && level.price >= minPrice && level.price <= maxPrice && Number(level.size) > 0)
        .sort((left, right) => Math.max(right.intensity || 0, right.size || 0) - Math.max(left.intensity || 0, left.size || 0))
        .slice(0, 18);

      for (let levelIndex = 0; levelIndex < levels.length && cursor < MAX_HISTORY_INSTANCES; levelIndex += 1) {
        const level = levels[levelIndex];
        const base = cursor * INSTANCE_STRIDE_FLOATS;
        const centerY = (((level.price - minPrice) / priceSpan) * 2) - 1;
        const halfHeight = Math.min(0.06, Math.max(0.004, ((Math.max(priceSpan / 180, priceSpan * 0.008) * (0.82 + (level.intensity || 0) * 0.55)) / priceSpan) * 2));
        const volume = Math.max(0, Number(level.size) || 0) * ageFade;
        this.instanceData[base + 0] = centerX;
        this.instanceData[base + 1] = halfWidth;
        this.instanceData[base + 2] = centerY;
        this.instanceData[base + 3] = halfHeight;
        this.instanceData[base + 4] = volume;
        this.instanceData[base + 5] = level.side === "ask" ? 1 : 0;
        this.instanceData[base + 6] = spoof;
        maxVolume = Math.max(maxVolume, volume);
        cursor += 1;
      }
    }

    if (cursor <= 0) {
      return { count: 0, maxVolume };
    }

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, cursor * INSTANCE_STRIDE_FLOATS));
    return { count: cursor, maxVolume };
  }
}