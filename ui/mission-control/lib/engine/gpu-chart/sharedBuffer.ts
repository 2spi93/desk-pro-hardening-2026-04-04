export type OhlcBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type SharedOhlcBuffer = {
  capacity: number;
  stride: number;
  data: Float32Array;
};

export const GPU_OHLC_STRIDE = 6;

export function createSharedOhlcBuffer(capacity: number): SharedOhlcBuffer {
  const safeCapacity = Math.max(64, Math.floor(capacity));
  return {
    capacity: safeCapacity,
    stride: GPU_OHLC_STRIDE,
    data: new Float32Array(safeCapacity * GPU_OHLC_STRIDE),
  };
}

export function writeBarToSharedBuffer(buffer: SharedOhlcBuffer, index: number, bar: OhlcBar): void {
  if (index < 0 || index >= buffer.capacity) {
    return;
  }

  const base = index * buffer.stride;
  buffer.data[base + 0] = Number(bar.time) || 0;
  buffer.data[base + 1] = Number(bar.open) || 0;
  buffer.data[base + 2] = Number(bar.high) || 0;
  buffer.data[base + 3] = Number(bar.low) || 0;
  buffer.data[base + 4] = Number(bar.close) || 0;
  buffer.data[base + 5] = Number(bar.volume) || 0;
}

export function writeBarsToSharedBuffer(buffer: SharedOhlcBuffer, bars: OhlcBar[]): number {
  const count = Math.min(buffer.capacity, bars.length);
  for (let index = 0; index < count; index += 1) {
    writeBarToSharedBuffer(buffer, index, bars[index]);
  }
  return count;
}
