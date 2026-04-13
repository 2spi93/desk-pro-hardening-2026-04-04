import type { OhlcBar } from "./sharedBuffer";
import { clamp, pixelAlign, resolvePerceptualDominance, resolvePerceptualRange } from "./chartPerceptualDominance";
import { createArrayBuffer, createProgram } from "./glUtils";

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aLocal;
layout(location = 1) in float aCenterX;
layout(location = 2) in float aOpenY;
layout(location = 3) in float aHighY;
layout(location = 4) in float aLowY;
layout(location = 5) in float aCloseY;
layout(location = 6) in float aHalfWidth;
layout(location = 7) in vec3 aColor;
layout(location = 8) in float aWickHalfWidth;

out vec3 vColor;
out vec2 vLocal;
out float vBodyBottomT;
out float vBodyTopT;
out float vWickRatio;

void main() {
  float bodyTop = max(aOpenY, aCloseY);
  float bodyBottom = min(aOpenY, aCloseY);
  float fullHeight = max(0.0001, aHighY - aLowY);
  float x = aCenterX + aLocal.x * aHalfWidth;
  float y = mix(aLowY, aHighY, (aLocal.y + 1.0) * 0.5);
  vColor = aColor;
  vLocal = aLocal;
  vBodyBottomT = clamp((bodyBottom - aLowY) / fullHeight, 0.0, 1.0);
  vBodyTopT = clamp((bodyTop - aLowY) / fullHeight, 0.0, 1.0);
  vWickRatio = clamp(aWickHalfWidth / max(aHalfWidth, 0.0001), 0.04, 1.0);
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vColor;
in vec2 vLocal;
in float vBodyBottomT;
in float vBodyTopT;
in float vWickRatio;
out vec4 outColor;

void main() {
  float yT = (vLocal.y + 1.0) * 0.5;
  float wickMask = 1.0 - step(vWickRatio, abs(vLocal.x));
  float bodyMask = step(vBodyBottomT, yT) * step(yT, vBodyTopT);
  float shapeMask = max(bodyMask, wickMask);
  if (shapeMask < 0.5) {
    discard;
  }

  float verticalLight = mix(0.92, 1.2, (vLocal.y + 1.0) * 0.5);
  float faceHighlight = smoothstep(1.0, 0.16, abs(vLocal.x)) * 0.14;
  float edgeHighlight = smoothstep(0.98, 0.28, vLocal.y) * 0.09;
  float innerShadow = smoothstep(0.22, 1.0, abs(vLocal.x)) * 0.05;
  float emboss = smoothstep(0.0, 0.86, 1.0 - abs(vLocal.y)) * 0.05;

  float wickTaper = mix(1.0, 0.72, smoothstep(0.0, 1.0, abs(vLocal.y)));
  float wickAlpha = 1.0 - smoothstep(wickTaper, 1.0, abs(vLocal.x));
  float wickGlow = smoothstep(0.96, 0.12, 1.0 - abs(vLocal.x)) * smoothstep(0.68, 1.0, abs(vLocal.y)) * 0.24;

  vec3 bodyColor = vColor * verticalLight;
  bodyColor += vec3(0.085) * faceHighlight;
  bodyColor += vec3(0.06) * edgeHighlight;
  bodyColor += vec3(0.03) * emboss;
  bodyColor -= vec3(innerShadow);

  vec3 wickColor = mix(vColor, vec3(1.0), 0.24);
  wickColor *= 0.96 + (1.0 - abs(vLocal.y)) * 0.12;
  wickColor += vec3(0.12) * wickGlow;

  vec3 color = mix(wickColor, bodyColor, bodyMask);
  float alpha = bodyMask > 0.5 ? 0.995 : clamp(0.78 + wickAlpha * 0.18, 0.72, 0.94);
  outColor = vec4(clamp(color, 0.0, 1.0), clamp(alpha, 0.0, 1.0));
}
`;

const INSTANCE_STRIDE_FLOATS = 10;
const LAST_BAR_SMOOTH_TIME_MS_DEFAULT = 140;

type LastBarAnimState = {
  target: OhlcBar;
  display: OhlcBar;
  lastFrameMs: number;
  displaySig: string;
};

type RangeAnimState = {
  targetMinPrice: number;
  targetMaxPrice: number;
  displayMinPrice: number;
  displayMaxPrice: number;
  lastFrameMs: number;
};

type ViewportState = {
  vao: WebGLVertexArrayObject;
  instanceBuffer: WebGLBuffer;
  maxInstances: number;
  instanceData: Float32Array;
  previousCount: number;
  previousRangeSig: string;
  previousStyleSig: string;
  previousLastSig: string;
  minPrice: number;
  span: number;
  halfWidth: number;
  lastBarAnim: LastBarAnimState | null;
  rangeAnim: RangeAnimState | null;
};

export class CandleLayer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private localBuffer: WebGLBuffer;
  private viewportStates = new Map<string, ViewportState>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);

    const localQuad = new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      1, 1,
    ]);

    this.localBuffer = createArrayBuffer(gl, localQuad, gl.STATIC_DRAW);
  }

  dispose(): void {
    const gl = this.gl;
    for (const state of this.viewportStates.values()) {
      gl.deleteBuffer(state.instanceBuffer);
      gl.deleteVertexArray(state.vao);
    }
    this.viewportStates.clear();
    gl.deleteBuffer(this.localBuffer);
    gl.deleteProgram(this.program);
  }

  evictUnusedViewports(activeIds: Set<string>): void {
    const gl = this.gl;
    for (const [id, state] of this.viewportStates) {
      if (!activeIds.has(id)) {
        gl.deleteBuffer(state.instanceBuffer);
        gl.deleteVertexArray(state.vao);
        this.viewportStates.delete(id);
      }
    }
  }

  draw(viewportId: string, bars: OhlcBar[], options?: { allowUpload?: boolean; frameTimeMs?: number; smoothingMs?: number; canvasWidth?: number; canvasHeight?: number }): void {
    if (bars.length === 0) {
      return;
    }

    const gl = this.gl;
    const count = bars.length;
    const state = this.getOrCreateViewportState(viewportId);
    const allowUpload = options?.allowUpload ?? true;
    const frameTimeMs = Number.isFinite(options?.frameTimeMs) ? Number(options?.frameTimeMs) : performance.now();
    const smoothingMs = Number.isFinite(options?.smoothingMs)
      ? Math.max(0, Number(options?.smoothingMs))
      : LAST_BAR_SMOOTH_TIME_MS_DEFAULT;
    const canvasWidth = Number.isFinite(options?.canvasWidth) ? Math.max(1, Number(options?.canvasWidth)) : this.gl.canvas.width;
    const canvasHeight = Number.isFinite(options?.canvasHeight) ? Math.max(1, Number(options?.canvasHeight)) : this.gl.canvas.height;
    const cssCanvasWidth = (this.gl.canvas as HTMLCanvasElement).clientWidth || canvasWidth;
    const devicePixelRatio = canvasWidth / Math.max(1, cssCanvasWidth);

    const lastBar = bars[count - 1];
    const displayLastBar = resolveDisplayLastBar(state, lastBar, frameTimeMs, smoothingMs);

    if (!allowUpload && state.previousCount > 0) {
      gl.useProgram(this.program);
      gl.bindVertexArray(state.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, state.previousCount);
      gl.bindVertexArray(null);
      return;
    }

    this.ensureInstanceCapacity(state, count);

    const targetRange = resolvePerceptualRange(bars, count);
    const rangeSig = `${count}|${targetRange.minPrice}|${targetRange.maxPrice}`;
    const lastSig = buildLastBarSignature(lastBar);
    const shouldResetRange = state.previousCount < 0
      || state.previousCount !== count
      || !state.rangeAnim;
    const range = resolveDisplayRange(state, targetRange, frameTimeMs, shouldResetRange);
    const displaySpan = Math.max(1e-6, range.maxPrice - range.minPrice);
    const rangeNeedsUpload = Math.abs(state.minPrice - range.minPrice) > 1e-6
      || Math.abs(state.span - displaySpan) > 1e-6;
    const styleSig = buildBarsStyleSignature(bars, count);
    const isFullUpload = state.previousCount !== count
      || state.previousRangeSig !== rangeSig
      || state.previousStyleSig !== styleSig
      || rangeNeedsUpload;
    const averageRange = resolveAverageRange(bars, count);
    const visibleTimes = bars
      .slice(0, count)
      .map((bar) => Number(bar.time))
      .filter((time) => Number.isFinite(time));
    const minTime = visibleTimes.length > 0 ? Math.min(...visibleTimes) : 0;
    const maxTime = visibleTimes.length > 0 ? Math.max(...visibleTimes) : minTime;
    let smallestDelta = Number.POSITIVE_INFINITY;
    for (let index = 1; index < visibleTimes.length; index += 1) {
      const delta = visibleTimes[index] - visibleTimes[index - 1];
      if (delta > 0 && delta < smallestDelta) {
        smallestDelta = delta;
      }
    }
    const edgePadTime = Number.isFinite(smallestDelta) ? smallestDelta * 0.5 : 1;

    gl.useProgram(this.program);
    gl.bindVertexArray(state.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.instanceBuffer);

    if (isFullUpload) {
      const packed = packAllBars(bars, count, range.minPrice, range.maxPrice, state.instanceData, canvasWidth, canvasHeight, devicePixelRatio);
      const lastBase = (count - 1) * INSTANCE_STRIDE_FLOATS;
      writePackedBar(
        state.instanceData,
        lastBase,
        count - 1,
        count,
        displayLastBar,
        range.minPrice,
        displaySpan,
        Math.min(0.028, 0.76 / Math.max(1, count)),
        canvasWidth,
        canvasHeight,
        averageRange,
        devicePixelRatio,
        minTime,
        maxTime,
        edgePadTime,
      );
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed.subarray(0, count * INSTANCE_STRIDE_FLOATS));
      state.minPrice = range.minPrice;
      state.span = displaySpan;
      state.halfWidth = Math.min(0.028, 0.76 / Math.max(1, count));
      state.previousCount = count;
      state.previousRangeSig = rangeSig;
      state.previousStyleSig = styleSig;
      state.previousLastSig = lastSig;
    } else {
      const index = count - 1;
      const base = index * INSTANCE_STRIDE_FLOATS;
      const displaySig = buildLastBarSignature(displayLastBar);
      const shouldUploadLast = state.previousLastSig !== lastSig
        || state.lastBarAnim?.displaySig !== displaySig;
      if (shouldUploadLast) {
        writePackedBar(
          state.instanceData,
          base,
          index,
          count,
          displayLastBar,
          state.minPrice,
          state.span,
          state.halfWidth,
          canvasWidth,
          canvasHeight,
          averageRange,
          devicePixelRatio,
          minTime,
          maxTime,
          edgePadTime,
        );
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          base * 4,
          state.instanceData.subarray(base, base + INSTANCE_STRIDE_FLOATS),
        );
      }
      state.previousLastSig = lastSig;
      if (state.lastBarAnim) {
        state.lastBarAnim.displaySig = displaySig;
      }
    }

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  private getOrCreateViewportState(viewportId: string): ViewportState {
    const existing = this.viewportStates.get(viewportId);
    if (existing) {
      return existing;
    }

    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("gpu_candle_vao_failed");
    }
    const instanceBuffer = createArrayBuffer(gl, new Float32Array(16), gl.DYNAMIC_DRAW);

    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.localBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 2 * 4, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);

    // x/open/high/low/close/halfWidth/color.rgb
    this.bindInstanceAttrib(1, 1, 0);
    this.bindInstanceAttrib(2, 1, 1);
    this.bindInstanceAttrib(3, 1, 2);
    this.bindInstanceAttrib(4, 1, 3);
    this.bindInstanceAttrib(5, 1, 4);
    this.bindInstanceAttrib(6, 1, 5);
    this.bindInstanceAttrib(7, 3, 6);
    this.bindInstanceAttrib(8, 1, 9);

    gl.bindVertexArray(null);

    const state: ViewportState = {
      vao,
      instanceBuffer,
      maxInstances: 0,
      instanceData: new Float32Array(0),
      previousCount: -1,
      previousRangeSig: "",
      previousStyleSig: "",
      previousLastSig: "",
      minPrice: 0,
      span: 1,
      halfWidth: 0.02,
      lastBarAnim: null,
      rangeAnim: null,
    };
    this.viewportStates.set(viewportId, state);
    return state;
  }

  private bindInstanceAttrib(location: number, size: number, offsetFloats: number): void {
    const gl = this.gl;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, INSTANCE_STRIDE_FLOATS * 4, offsetFloats * 4);
    gl.vertexAttribDivisor(location, 1);
  }

  private ensureInstanceCapacity(state: ViewportState, count: number): void {
    if (count <= state.maxInstances) {
      return;
    }

    const gl = this.gl;
    state.maxInstances = Math.max(count, state.maxInstances * 2, 512);
    state.instanceData = new Float32Array(state.maxInstances * INSTANCE_STRIDE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, state.instanceData.byteLength, gl.DYNAMIC_DRAW);
  }
}

function resolveDisplayLastBar(state: ViewportState, target: OhlcBar, frameTimeMs: number, smoothingMs: number): OhlcBar {
  if (!state.lastBarAnim) {
    const seeded = sanitizeBar(target);
    state.lastBarAnim = {
      target: { ...seeded },
      display: { ...seeded },
      lastFrameMs: frameTimeMs,
      displaySig: buildLastBarSignature(seeded),
    };
    return state.lastBarAnim.display;
  }

  const anim = state.lastBarAnim;
  const sanitizedTarget = sanitizeBar(target);
  if (smoothingMs <= 0) {
    anim.target = { ...sanitizedTarget };
    anim.display = { ...sanitizedTarget };
    anim.lastFrameMs = frameTimeMs;
    anim.displaySig = buildLastBarSignature(sanitizedTarget);
    return anim.display;
  }
  const targetSig = buildLastBarSignature(sanitizedTarget);
  if (targetSig !== buildLastBarSignature(anim.target)) {
    anim.target = { ...sanitizedTarget };
    if (anim.display.time !== sanitizedTarget.time) {
      anim.display = { ...sanitizedTarget };
    }
  }

  const dt = Math.max(0, frameTimeMs - anim.lastFrameMs);
  anim.lastFrameMs = frameTimeMs;
  const alpha = 1 - Math.exp(-dt / Math.max(1, smoothingMs));

  anim.display.open = smoothValue(anim.display.open, anim.target.open, alpha);
  anim.display.high = smoothValue(anim.display.high, anim.target.high, alpha);
  anim.display.low = smoothValue(anim.display.low, anim.target.low, alpha);
  anim.display.close = smoothValue(anim.display.close, anim.target.close, alpha);
  anim.display.volume = smoothValue(Number(anim.display.volume || 0), Number(anim.target.volume || 0), alpha);
  anim.display.time = anim.target.time;

  // Keep OHLC invariants while smoothing.
  const maxBody = Math.max(anim.display.open, anim.display.close);
  const minBody = Math.min(anim.display.open, anim.display.close);
  anim.display.high = Math.max(anim.display.high, maxBody);
  anim.display.low = Math.min(anim.display.low, minBody);

  return anim.display;
}

function resolveDisplayRange(
  state: ViewportState,
  targetRange: { minPrice: number; maxPrice: number },
  frameTimeMs: number,
  reset: boolean,
): { minPrice: number; maxPrice: number } {
  const safeMin = Number.isFinite(targetRange.minPrice) ? targetRange.minPrice : 0;
  const safeMax = Number.isFinite(targetRange.maxPrice) ? targetRange.maxPrice : safeMin + 1;
  const safeSpan = Math.max(1e-6, safeMax - safeMin);

  if (reset || !state.rangeAnim) {
    state.rangeAnim = {
      targetMinPrice: safeMin,
      targetMaxPrice: safeMax,
      displayMinPrice: safeMin,
      displayMaxPrice: safeMax,
      lastFrameMs: frameTimeMs,
    };
    return { minPrice: safeMin, maxPrice: safeMax };
  }

  const anim = state.rangeAnim;
  const previousSpan = Math.max(1e-6, anim.displayMaxPrice - anim.displayMinPrice);
  const spanShift = Math.abs(Math.log(safeSpan / previousSpan));
  if (!Number.isFinite(spanShift) || spanShift > 1.1) {
    anim.targetMinPrice = safeMin;
    anim.targetMaxPrice = safeMax;
    anim.displayMinPrice = safeMin;
    anim.displayMaxPrice = safeMax;
    anim.lastFrameMs = frameTimeMs;
    return { minPrice: safeMin, maxPrice: safeMax };
  }

  anim.targetMinPrice = safeMin;
  anim.targetMaxPrice = safeMax;
  const dt = Math.max(0, frameTimeMs - anim.lastFrameMs);
  anim.lastFrameMs = frameTimeMs;
  const alpha = 1 - Math.exp(-dt / 180);

  anim.displayMinPrice = safeMin < anim.displayMinPrice
    ? safeMin
    : smoothValue(anim.displayMinPrice, safeMin, alpha);
  anim.displayMaxPrice = safeMax > anim.displayMaxPrice
    ? safeMax
    : smoothValue(anim.displayMaxPrice, safeMax, alpha);

  if (anim.displayMaxPrice - anim.displayMinPrice < 1e-6) {
    anim.displayMinPrice = safeMin;
    anim.displayMaxPrice = safeMax;
  }

  return {
    minPrice: anim.displayMinPrice,
    maxPrice: anim.displayMaxPrice,
  };
}

function smoothValue(current: number, target: number, alpha: number): number {
  const c = Number.isFinite(current) ? current : target;
  const t = Number.isFinite(target) ? target : c;
  if (!Number.isFinite(c) && !Number.isFinite(t)) {
    return 0;
  }
  if (Math.abs(t - c) < 1e-10) {
    return t;
  }
  return c + (t - c) * Math.min(1, Math.max(0, alpha));
}

function sanitizeBar(bar: OhlcBar): OhlcBar {
  const open = Number(bar.open) || 0;
  const close = Number(bar.close) || open;
  const high = Math.max(Number(bar.high) || open, open, close);
  const low = Math.min(Number(bar.low) || close, open, close);
  return {
    time: Number(bar.time) || 0,
    open,
    high,
    low,
    close,
    volume: Number(bar.volume) || 0,
    __visual: bar.__visual ? { ...bar.__visual } : undefined,
  };
}

function packAllBars(
  bars: OhlcBar[],
  count: number,
  minPrice: number,
  maxPrice: number,
  target: Float32Array,
  canvasWidth: number,
  canvasHeight: number,
  devicePixelRatio: number,
): Float32Array {
  const span = Math.max(1e-6, maxPrice - minPrice);
  const halfWidth = Math.min(0.028, 0.76 / Math.max(1, count));
  const averageRange = bars.length > 0
    ? bars.reduce((sum, bar) => sum + Math.max(0, bar.high - bar.low), 0) / bars.length
    : 0;
  const visibleTimes = bars
    .slice(0, count)
    .map((bar) => Number(bar.time))
    .filter((time) => Number.isFinite(time));
  const minTime = visibleTimes.length > 0 ? Math.min(...visibleTimes) : 0;
  const maxTime = visibleTimes.length > 0 ? Math.max(...visibleTimes) : minTime;
  let smallestDelta = Number.POSITIVE_INFINITY;
  for (let index = 1; index < visibleTimes.length; index += 1) {
    const delta = visibleTimes[index] - visibleTimes[index - 1];
    if (delta > 0 && delta < smallestDelta) {
      smallestDelta = delta;
    }
  }
  const edgePadTime = Number.isFinite(smallestDelta) ? smallestDelta * 0.5 : 1;

  for (let index = 0; index < count; index += 1) {
    const base = index * INSTANCE_STRIDE_FLOATS;
    writePackedBar(target, base, index, count, bars[index], minPrice, span, halfWidth, canvasWidth, canvasHeight, averageRange, devicePixelRatio, minTime, maxTime, edgePadTime);
  }

  return target;
}

function writePackedBar(
  target: Float32Array,
  base: number,
  index: number,
  count: number,
  bar: OhlcBar,
  minPrice: number,
  span: number,
  halfWidth: number,
  canvasWidth: number,
  canvasHeight: number,
  averageRange: number,
  devicePixelRatio: number,
  minTime: number,
  maxTime: number,
  edgePadTime: number,
): void {
  const rangeImportance = averageRange > 1e-6 ? Math.max(0.8, Math.min(1.8, (Math.max(0, bar.high - bar.low) / averageRange))) : 1;
  const renderStyle = resolvePackedRenderStyle(bar, count, canvasWidth, canvasHeight, rangeImportance, devicePixelRatio);
  const totalTimeSpan = Math.max(1, (maxTime - minTime) + edgePadTime * 2);
  const normalizedTime = Number.isFinite(bar.time)
    ? ((Number(bar.time) - (minTime - edgePadTime)) / totalTimeSpan)
    : ((index + 0.5) / Math.max(1, count));
  const x = snapNdcX(-1 + Math.max(0, Math.min(1, normalizedTime)) * 2, canvasWidth, renderStyle.pixelSnapping);
  let openY = snapNdcY(normalizePrice(bar.open, minPrice, span), canvasHeight, renderStyle.pixelSnapping);
  let highY = snapNdcY(normalizePrice(bar.high, minPrice, span), canvasHeight, renderStyle.pixelSnapping);
  let lowY = snapNdcY(normalizePrice(bar.low, minPrice, span), canvasHeight, renderStyle.pixelSnapping);
  let closeY = snapNdcY(normalizePrice(bar.close, minPrice, span), canvasHeight, renderStyle.pixelSnapping);
  ({ openY, closeY } = enforceMinimumBodyHeight(openY, closeY, canvasHeight, renderStyle.minBodyHeightPx));
  highY = Math.max(highY, openY, closeY);
  lowY = Math.min(lowY, openY, closeY);
  const isUp = closeY >= openY;
  const [red, green, blue] = resolvePackedBarColor(bar, isUp);

  target[base + 0] = x;
  target[base + 1] = openY;
  target[base + 2] = highY;
  target[base + 3] = lowY;
  target[base + 4] = closeY;
  target[base + 5] = renderStyle.bodyHalfWidthNdc || halfWidth;
  target[base + 6] = red;
  target[base + 7] = green;
  target[base + 8] = blue;
  target[base + 9] = renderStyle.wickHalfWidthNdc;
}

function resolvePackedBarColor(bar: OhlcBar, isUp: boolean): [number, number, number] {
  const base: [number, number, number] = isUp ? [0.08, 0.84, 0.66] : [0.93, 0.34, 0.40];
  const visual = bar.__visual;
  if (!visual) {
    return base;
  }

  const signal = visual.footprintSignal || "neutral";
  const bias = clamp(visual.footprintBias ?? 0, -1, 1);
  const heat = clamp(visual.footprintHeat ?? 0, 0, 1);
  const liquidity = clamp(visual.liquidityScore ?? 0, 0, 1);

  let color = [...base] as [number, number, number];
  if (signal === "absorption") {
    color = mixColor(color, [0.62, 0.35, 0.9], 0.38 + heat * 0.24);
  } else if (signal === "exhaustion") {
    color = mixColor(color, [0.96, 0.72, 0.22], 0.28 + heat * 0.18);
  } else if (signal === "stacked-imbalance" || Math.abs(bias) >= 0.42) {
    color = bias >= 0
      ? mixColor(color, [0.12, 0.95, 0.50], 0.16 + heat * 0.3)
      : mixColor(color, [0.98, 0.22, 0.26], 0.16 + heat * 0.3);
  }

  const brightness = 1 + liquidity * 0.12 + heat * 0.08;
  return [
    clamp(color[0] * brightness, 0, 1),
    clamp(color[1] * brightness, 0, 1),
    clamp(color[2] * brightness, 0, 1),
  ];
}

function mixColor(base: [number, number, number], tint: [number, number, number], alpha: number): [number, number, number] {
  const weight = clamp(alpha, 0, 1);
  return [
    base[0] * (1 - weight) + tint[0] * weight,
    base[1] * (1 - weight) + tint[1] * weight,
    base[2] * (1 - weight) + tint[2] * weight,
  ];
}

function buildLastBarSignature(bar: OhlcBar): string {
  const visual = bar.__visual;
  return [
    bar.time,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    visual?.wickType || "neutral",
    Math.round((visual?.importance ?? 0) * 1000),
    Math.round((visual?.bodyBoost ?? 1) * 1000),
    Math.round((visual?.wickBoost ?? 0) * 100000),
    Math.round((visual?.lastCandleEmphasis ?? 0) * 1000),
    visual?.footprintSignal || "neutral",
    Math.round((visual?.footprintBias ?? 0) * 1000),
    Math.round((visual?.footprintHeat ?? 0) * 1000),
    Math.round((visual?.liquidityScore ?? 0) * 1000),
  ].join("|");
}

function buildBarsStyleSignature(bars: OhlcBar[], count: number): string {
  let importanceSum = 0;
  let bodyBoostSum = 0;
  let wickBoostSum = 0;
  let emphasisSum = 0;
  let biasSum = 0;
  let heatSum = 0;
  let liquiditySum = 0;
  let wickSignalCount = 0;
  let footprintSignalCount = 0;

  for (let index = 0; index < count; index += 1) {
    const visual = bars[index].__visual;
    importanceSum += visual?.importance ?? 0;
    bodyBoostSum += visual?.bodyBoost ?? 1;
    wickBoostSum += visual?.wickBoost ?? 0;
    emphasisSum += visual?.lastCandleEmphasis ?? 0;
    biasSum += visual?.footprintBias ?? 0;
    heatSum += visual?.footprintHeat ?? 0;
    liquiditySum += visual?.liquidityScore ?? 0;
    if (visual?.wickType && visual.wickType !== "neutral") {
      wickSignalCount += 1;
    }
    if (visual?.footprintSignal && visual.footprintSignal !== "neutral") {
      footprintSignalCount += 1;
    }
  }

  return [
    count,
    Math.round(importanceSum * 1000),
    Math.round(bodyBoostSum * 1000),
    Math.round(wickBoostSum * 100000),
    Math.round(emphasisSum * 1000),
    Math.round(biasSum * 1000),
    Math.round(heatSum * 1000),
    Math.round(liquiditySum * 1000),
    wickSignalCount,
    footprintSignalCount,
  ].join("|");
}

function normalizePrice(price: number, minPrice: number, span: number): number {
  const t = (Number(price) - minPrice) / span;
  return t * 2 - 1;
}

function resolveAverageRange(bars: OhlcBar[], count: number): number {
  if (count <= 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const bar = bars[index];
    sum += Math.max(0, bar.high - bar.low);
  }
  return sum / count;
}

function resolvePackedRenderStyle(bar: OhlcBar, count: number, canvasWidth: number, canvasHeight: number, importance = 1, devicePixelRatio = 1): {
  pixelSnapping: boolean;
  bodyHalfWidthNdc: number;
  wickHalfWidthNdc: number;
  minBodyHeightPx: number;
} {
  const stepPx = canvasWidth / Math.max(1, count);
  const pixelSnapping = stepPx <= 14;
  const normalizedDensity = clamp((12 - Math.min(12, stepPx)) / 10, 0, 1);
  const normalizedVolatility = clamp((importance - 0.82) / 0.92, 0, 1);
  const dominance = resolvePerceptualDominance(bar, {
    spacingPx: stepPx,
    volatility: normalizedVolatility,
    density: normalizedDensity,
    zoom: clamp(stepPx / Math.max(2, Math.min(stepPx, 16)), 0.92, 1.08),
    devicePixelRatio,
  });
  const bodyWidthPx = pixelAlign(dominance.bodyWidthPx, devicePixelRatio);
  const wickWidthPx = pixelAlign(dominance.wickWidthPx, devicePixelRatio);
  return {
    pixelSnapping,
    bodyHalfWidthNdc: pixelWidthToNdcX(bodyWidthPx * 0.5, canvasWidth),
    wickHalfWidthNdc: pixelWidthToNdcX(wickWidthPx * 0.5, canvasWidth),
    minBodyHeightPx: Math.min(dominance.minBodyHeightPx, Math.max(1.8, canvasHeight * 0.032)),
  };
}

function pixelWidthToNdcX(widthPx: number, canvasWidth: number): number {
  return (Math.max(0.5, widthPx) / Math.max(1, canvasWidth)) * 2;
}

function snapNdcX(value: number, canvasWidth: number, enabled: boolean): number {
  if (!enabled) {
    return value;
  }
  const pixel = ((value + 1) * 0.5) * canvasWidth;
  const snapped = Math.round(pixel - 0.5) + 0.5;
  return (snapped / Math.max(1, canvasWidth)) * 2 - 1;
}

function snapNdcY(value: number, canvasHeight: number, enabled: boolean): number {
  if (!enabled) {
    return value;
  }
  const pixel = ((value + 1) * 0.5) * canvasHeight;
  const snapped = Math.round(pixel - 0.5) + 0.5;
  return (snapped / Math.max(1, canvasHeight)) * 2 - 1;
}

function enforceMinimumBodyHeight(openY: number, closeY: number, canvasHeight: number, minBodyHeightPx: number): { openY: number; closeY: number } {
  const openPx = ((openY + 1) * 0.5) * canvasHeight;
  const closePx = ((closeY + 1) * 0.5) * canvasHeight;
  const deltaPx = closePx - openPx;
  if (Math.abs(deltaPx) >= minBodyHeightPx) {
    return { openY, closeY };
  }
  const nextOpenPx = deltaPx < 0
    ? closePx + minBodyHeightPx
    : openPx;
  const nextClosePx = deltaPx < 0
    ? closePx
    : openPx + minBodyHeightPx;
  return {
    openY: (nextOpenPx / Math.max(1, canvasHeight)) * 2 - 1,
    closeY: (nextClosePx / Math.max(1, canvasHeight)) * 2 - 1,
  };
}
