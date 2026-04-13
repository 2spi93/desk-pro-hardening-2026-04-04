export type DomHistoryLevel = {
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
};

export type DomHistoryFrame = {
  time: number;
  levels: DomHistoryLevel[];
  spoofingRisk?: number;
};

const LEVEL_STRIDE = 4;

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export class DomHistoryBuffer {
  readonly buffer: Float32Array;
  private readonly frameTimes: Float64Array;
  private readonly frameCounts: Uint16Array;
  private readonly frameSpoofingRisk: Float32Array;
  private readonly frameStride: number;
  private frameCount = 0;

  constructor(
    private readonly maxFrames = 64,
    private readonly maxLevelsPerFrame = 20,
  ) {
    this.frameStride = this.maxLevelsPerFrame * LEVEL_STRIDE;
    this.buffer = new Float32Array(this.maxFrames * this.frameStride);
    this.frameTimes = new Float64Array(this.maxFrames);
    this.frameCounts = new Uint16Array(this.maxFrames);
    this.frameSpoofingRisk = new Float32Array(this.maxFrames);
  }

  reset(): void {
    this.buffer.fill(0);
    this.frameTimes.fill(0);
    this.frameCounts.fill(0);
    this.frameSpoofingRisk.fill(0);
    this.frameCount = 0;
  }

  push(frame: DomHistoryFrame): void {
    const time = toFiniteNumber(frame.time, 0);
    if (!(time > 0)) {
      return;
    }

    const levels = (frame.levels || [])
      .filter((level) => toFiniteNumber(level.price, 0) > 0 && toFiniteNumber(level.size, 0) > 0)
      .map((level) => ({
        side: (level.side === "ask" ? "ask" : "bid") as DomHistoryLevel["side"],
        price: toFiniteNumber(level.price, 0),
        size: Math.max(0, toFiniteNumber(level.size, 0)),
        intensity: Math.max(0, toFiniteNumber(level.intensity, toFiniteNumber(level.size, 0))),
      }))
      .sort((left, right) => {
        const leftScore = Math.max(left.intensity, left.size);
        const rightScore = Math.max(right.intensity, right.size);
        return rightScore - leftScore;
      })
      .slice(0, this.maxLevelsPerFrame);

    if (levels.length === 0) {
      return;
    }

    const spoofingRisk = Math.max(0, Math.min(1, toFiniteNumber(frame.spoofingRisk, 0)));
    const lastIndex = this.frameCount - 1;
    if (lastIndex >= 0 && Math.round(this.frameTimes[lastIndex]) === Math.round(time)) {
      this.writeFrame(lastIndex, time, levels, spoofingRisk);
      return;
    }

    if (this.frameCount >= this.maxFrames) {
      this.buffer.copyWithin(0, this.frameStride, this.frameCount * this.frameStride);
      this.frameTimes.copyWithin(0, 1, this.frameCount);
      this.frameCounts.copyWithin(0, 1, this.frameCount);
      this.frameSpoofingRisk.copyWithin(0, 1, this.frameCount);
      this.frameCount = this.maxFrames - 1;
    }

    this.writeFrame(this.frameCount, time, levels, spoofingRisk);
    this.frameCount += 1;
  }

  snapshot(limit = this.maxFrames): DomHistoryFrame[] {
    const count = Math.max(0, Math.min(this.frameCount, Math.floor(limit)));
    const startIndex = Math.max(0, this.frameCount - count);
    const frames: DomHistoryFrame[] = [];

    for (let frameIndex = startIndex; frameIndex < this.frameCount; frameIndex += 1) {
      const levelCount = this.frameCounts[frameIndex] || 0;
      if (levelCount <= 0) {
        continue;
      }
      const base = frameIndex * this.frameStride;
      const levels: DomHistoryLevel[] = [];
      for (let levelIndex = 0; levelIndex < levelCount; levelIndex += 1) {
        const offset = base + levelIndex * LEVEL_STRIDE;
        levels.push({
          price: this.buffer[offset + 0] || 0,
          size: this.buffer[offset + 1] || 0,
          intensity: this.buffer[offset + 2] || 0,
          side: this.buffer[offset + 3] >= 0.5 ? "ask" : "bid",
        });
      }
      frames.push({
        time: this.frameTimes[frameIndex],
        spoofingRisk: this.frameSpoofingRisk[frameIndex] || 0,
        levels,
      });
    }

    return frames;
  }

  private writeFrame(index: number, time: number, levels: DomHistoryLevel[], spoofingRisk: number): void {
    const base = index * this.frameStride;
    this.buffer.fill(0, base, base + this.frameStride);
    for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
      const level = levels[levelIndex];
      const offset = base + levelIndex * LEVEL_STRIDE;
      this.buffer[offset + 0] = level.price;
      this.buffer[offset + 1] = level.size;
      this.buffer[offset + 2] = level.intensity;
      this.buffer[offset + 3] = level.side === "ask" ? 1 : 0;
    }
    this.frameTimes[index] = time;
    this.frameCounts[index] = levels.length;
    this.frameSpoofingRisk[index] = spoofingRisk;
  }
}