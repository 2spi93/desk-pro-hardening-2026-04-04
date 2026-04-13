import { createArrayBuffer, createProgram } from "./glUtils";

export type PriceSignalBand = {
  price: number;
  strength: number;
  kind: "execution-expected" | "execution-actual" | "slippage" | "wall" | "vacuum" | "trap" | "flow-sweep" | "flow-absorption" | "flow-exhaustion" | "flow-spoof" | "flow-memory" | "arb-buy" | "arb-sell";
  xStart?: number;
  xEnd?: number;
  thickness?: number;
};

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aLocal;
layout(location = 1) in float aCenterY;
layout(location = 2) in float aHalfHeight;
layout(location = 3) in float aXStart;
layout(location = 4) in float aXEnd;
layout(location = 5) in float aStrength;
layout(location = 6) in float aKind;

out vec2 vLocal;
out float vStrength;
out float vKind;

void main() {
  vLocal = aLocal;
  vStrength = aStrength;
  vKind = aKind;
  float x = mix(aXStart, aXEnd, (aLocal.x + 1.0) * 0.5);
  gl_Position = vec4(x, aCenterY + aLocal.y * aHalfHeight, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vLocal;
in float vStrength;
in float vKind;
uniform float uAlpha;
out vec4 outColor;

vec3 resolveTone(float kind) {
  if (kind < 0.5) {
    return vec3(0.26, 0.62, 1.0);
  }
  if (kind < 1.5) {
    return vec3(0.18, 1.0, 0.52);
  }
  if (kind < 2.5) {
    return vec3(1.0, 0.56, 0.12);
  }
  if (kind < 3.5) {
    return vec3(0.0, 0.98, 1.0);
  }
  if (kind < 4.5) {
    return vec3(1.0, 0.55, 0.18);
  }
  if (kind < 5.5) {
    return vec3(0.90, 0.34, 0.96);
  }
  if (kind < 6.5) {
    return vec3(1.0, 0.36, 0.22);
  }
  if (kind < 7.5) {
    return vec3(0.18, 0.92, 0.74);
  }
  if (kind < 8.5) {
    return vec3(1.0, 0.82, 0.24);
  }
  if (kind < 9.5) {
    return vec3(1.0, 0.92, 0.38);
  }
  if (kind < 10.5) {
    return vec3(0.82, 0.94, 1.0);
  }
  if (kind < 11.5) {
    return vec3(0.22, 0.96, 0.56);
  }
  return vec3(1.0, 0.34, 0.24);
}

void main() {
  float strength = clamp(vStrength, 0.0, 1.0);
  float edgeFade = 1.0 - smoothstep(0.82, 1.0, abs(vLocal.y));
  float glow = 0.76 + smoothstep(1.0, 0.0, abs(vLocal.x)) * 0.24;
  float alpha = clamp(uAlpha * (0.15 + strength * 0.55) * edgeFade * glow, 0.0, 0.88);
  vec3 tone = resolveTone(vKind);
  outColor = vec4(tone, alpha);
}
`;

const INSTANCE_STRIDE_FLOATS = 6;
const MAX_SIGNAL_BANDS = 160;

function kindToFloat(kind: PriceSignalBand["kind"]): number {
  switch (kind) {
    case "execution-expected":
      return 0;
    case "execution-actual":
      return 1;
    case "slippage":
      return 2;
    case "wall":
      return 3;
    case "vacuum":
      return 4;
    case "trap":
      return 5;
    case "flow-sweep":
      return 6;
    case "flow-absorption":
      return 7;
    case "flow-exhaustion":
      return 8;
    case "flow-spoof":
      return 9;
    case "flow-memory":
      return 10;
    case "arb-buy":
      return 11;
    case "arb-sell":
      return 12;
    default:
      return 0;
  }
}

export class PriceSignalLayer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private instanceBuffer: WebGLBuffer;
  private instanceData = new Float32Array(MAX_SIGNAL_BANDS * INSTANCE_STRIDE_FLOATS);
  private alphaLocation: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.alphaLocation = gl.getUniformLocation(this.program, "uAlpha");

    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("gpu_price_signal_vao_failed");
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
    signals?: PriceSignalBand[];
    alpha: number;
    minPrice: number;
    maxPrice: number;
  }): void {
    const { signals = [], alpha, minPrice, maxPrice } = input;
    const count = this.writeSignals(signals, minPrice, maxPrice);
    if (count <= 0) {
      return;
    }

    const gl = this.gl;
    gl.useProgram(this.program);
    if (this.alphaLocation) {
      gl.uniform1f(this.alphaLocation, alpha);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  private writeSignals(signals: PriceSignalBand[], minPrice: number, maxPrice: number): number {
    const priceSpan = Math.max(1e-6, maxPrice - minPrice);
    if (!(priceSpan > 0) || signals.length === 0) {
      return 0;
    }

    const visible = signals
      .filter((signal) => Number.isFinite(signal.price) && signal.price >= minPrice && signal.price <= maxPrice)
      .slice(0, MAX_SIGNAL_BANDS);

    for (let index = 0; index < visible.length; index += 1) {
      const signal = visible[index];
      const base = index * INSTANCE_STRIDE_FLOATS;
      const centerY = (((signal.price - minPrice) / priceSpan) * 2) - 1;
      const thickness = Math.min(0.045, Math.max(0.0025, Number(signal.thickness) || 0.0065));
      const start = Math.max(-1, Math.min(1, Number.isFinite(signal.xStart) ? Number(signal.xStart) : -1));
      const end = Math.max(start, Math.min(1, Number.isFinite(signal.xEnd) ? Number(signal.xEnd) : 1));
      this.instanceData[base + 0] = centerY;
      this.instanceData[base + 1] = thickness;
      this.instanceData[base + 2] = start;
      this.instanceData[base + 3] = end;
      this.instanceData[base + 4] = Math.max(0.05, Math.min(1, signal.strength || 0));
      this.instanceData[base + 5] = kindToFloat(signal.kind);
    }

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, visible.length * INSTANCE_STRIDE_FLOATS));
    return visible.length;
  }
}