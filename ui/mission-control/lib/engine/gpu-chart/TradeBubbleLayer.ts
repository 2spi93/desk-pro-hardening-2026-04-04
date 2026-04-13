import { createArrayBuffer, createProgram } from "./glUtils";

export type TradeBubblePoint = {
  time: number;
  price: number;
  volume: number;
  side: "buy" | "sell";
  intensity?: number;
  kind?: "trade" | "spoof";
};

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aLocal;
layout(location = 1) in float aCenterX;
layout(location = 2) in float aCenterY;
layout(location = 3) in float aRadius;
layout(location = 4) in float aSide;
layout(location = 5) in float aIntensity;
layout(location = 6) in float aKind;

uniform float uAspect;

out vec2 vLocal;
out float vSide;
out float vIntensity;
out float vKind;

void main() {
  vLocal = aLocal;
  vSide = aSide;
  vIntensity = aIntensity;
  vKind = aKind;
  gl_Position = vec4(aCenterX + aLocal.x * aRadius * uAspect, aCenterY + aLocal.y * aRadius, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vLocal;
in float vSide;
in float vIntensity;
in float vKind;
uniform float uAlpha;
out vec4 outColor;

void main() {
  float dist = length(vLocal);
  if (dist > 1.0) {
    discard;
  }

  vec3 buyTone = vec3(0.12, 0.95, 0.46);
  vec3 sellTone = vec3(1.0, 0.24, 0.26);
  vec3 spoofTone = vec3(1.0, 0.87, 0.24);
  float intensity = clamp(vIntensity, 0.0, 1.0);
  vec3 tone = mix(buyTone, sellTone, step(0.5, vSide));

  if (vKind > 0.5) {
    float ring = smoothstep(0.98, 0.72, dist) - smoothstep(0.72, 0.52, dist);
    float alpha = clamp(uAlpha * (0.42 + intensity * 0.42) * ring, 0.0, 0.86);
    outColor = vec4(mix(tone, spoofTone, 0.72), alpha);
    return;
  }

  float core = smoothstep(1.0, 0.0, dist);
  float halo = smoothstep(1.0, 0.58, dist);
  float alpha = clamp(uAlpha * (0.18 + intensity * 0.34) * halo, 0.0, 0.62);
  vec3 mixed = mix(vec3(1.0), tone, clamp(core * 0.94, 0.0, 1.0));
  outColor = vec4(mixed, alpha);
}
`;

const INSTANCE_STRIDE_FLOATS = 6;
const MAX_BUBBLES = 320;

export class TradeBubbleLayer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private instanceBuffer: WebGLBuffer;
  private instanceData = new Float32Array(MAX_BUBBLES * INSTANCE_STRIDE_FLOATS);
  private alphaLocation: WebGLUniformLocation | null;
  private aspectLocation: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.alphaLocation = gl.getUniformLocation(this.program, "uAlpha");
    this.aspectLocation = gl.getUniformLocation(this.program, "uAspect");

    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("gpu_trade_bubble_vao_failed");
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
    for (let attribute = 1; attribute <= 6; attribute += 1) {
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
    bubbles?: TradeBubblePoint[];
    alpha: number;
    minPrice: number;
    maxPrice: number;
    minTime: number;
    maxTime: number;
    viewportWidth: number;
    viewportHeight: number;
  }): void {
    const {
      bubbles = [],
      alpha,
      minPrice,
      maxPrice,
      minTime,
      maxTime,
      viewportWidth,
      viewportHeight,
    } = input;
    const result = this.writeBubbles(bubbles, minPrice, maxPrice, minTime, maxTime, viewportHeight);
    if (result.count <= 0) {
      return;
    }

    const gl = this.gl;
    gl.useProgram(this.program);
    if (this.alphaLocation) {
      gl.uniform1f(this.alphaLocation, alpha);
    }
    if (this.aspectLocation) {
      gl.uniform1f(this.aspectLocation, Math.max(1e-3, viewportHeight / Math.max(1, viewportWidth)));
    }
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, result.count);
    gl.bindVertexArray(null);
  }

  private writeBubbles(
    bubbles: TradeBubblePoint[],
    minPrice: number,
    maxPrice: number,
    minTime: number,
    maxTime: number,
    viewportHeight: number,
  ): { count: number } {
    const priceSpan = Math.max(1e-6, maxPrice - minPrice);
    const timeSpan = Math.max(1, maxTime - minTime);
    if (!(priceSpan > 0) || !(timeSpan > 0) || bubbles.length === 0) {
      return { count: 0 };
    }

    const visibleBubbles = [...bubbles]
      .filter((bubble) => Number.isFinite(bubble.time) && bubble.time >= minTime && bubble.time <= maxTime && Number.isFinite(bubble.price) && bubble.price >= minPrice && bubble.price <= maxPrice && Number(bubble.volume) > 0)
      .sort((left, right) => left.time - right.time)
      .slice(-MAX_BUBBLES);
    if (visibleBubbles.length === 0) {
      return { count: 0 };
    }

    const maxVolume = visibleBubbles.reduce((max, bubble) => Math.max(max, Number(bubble.volume) || 0), 1);
    const radiusFloor = viewportHeight >= 720 ? 0.012 : 0.016;
    const radiusCeil = viewportHeight >= 720 ? 0.058 : 0.072;

    for (let index = 0; index < visibleBubbles.length; index += 1) {
      const bubble = visibleBubbles[index];
      const base = index * INSTANCE_STRIDE_FLOATS;
      const centerX = (((bubble.time - minTime) / timeSpan) * 2) - 1;
      const centerY = (((bubble.price - minPrice) / priceSpan) * 2) - 1;
      const volumeRatio = Math.sqrt(Math.max(0, Number(bubble.volume) || 0) / Math.max(1, maxVolume));
      const radius = Math.min(radiusCeil, Math.max(radiusFloor, radiusFloor + volumeRatio * (radiusCeil - radiusFloor)));
      this.instanceData[base + 0] = centerX;
      this.instanceData[base + 1] = centerY;
      this.instanceData[base + 2] = radius;
      this.instanceData[base + 3] = bubble.side === "sell" ? 1 : 0;
      this.instanceData[base + 4] = Math.max(0.16, Math.min(1, Number(bubble.intensity) || volumeRatio));
      this.instanceData[base + 5] = bubble.kind === "spoof" ? 1 : 0;
    }

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, visibleBubbles.length * INSTANCE_STRIDE_FLOATS));
    return { count: visibleBubbles.length };
  }
}