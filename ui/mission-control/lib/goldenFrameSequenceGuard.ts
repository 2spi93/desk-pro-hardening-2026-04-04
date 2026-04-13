export type GoldenFrameSequenced<T> = {
  sequence: number;
  payload: T;
  enqueuedAt: number;
};

export type GoldenFrameSequenceGuardResult<T> = {
  ready: GoldenFrameSequenced<T> | null;
  skippedGapCount: number;
  queueDepth: number;
  nextWakeDelayMs: number | null;
};

export type GoldenFrameSequenceGuardOptions = {
  graceWindowMs?: number;
  maxQueueDepth?: number;
};

const DEFAULT_GRACE_WINDOW_MS = 5;
const DEFAULT_MAX_QUEUE_DEPTH = 512;

export class GoldenFrameSequenceGuard<T> {
  private graceWindowMs: number;
  private readonly maxQueueDepth: number;
  private readonly queue: Array<GoldenFrameSequenced<T>> = [];
  private expectedSequence: number | null = null;
  private gapStartedAt = 0;

  constructor(options?: GoldenFrameSequenceGuardOptions) {
    this.graceWindowMs = Math.max(1, Math.round(options?.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS));
    this.maxQueueDepth = Math.max(32, Math.round(options?.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH));
  }

  reset(): void {
    this.queue.length = 0;
    this.expectedSequence = null;
    this.gapStartedAt = 0;
  }

  size(): number {
    return this.queue.length;
  }

  getGraceWindowMs(): number {
    return this.graceWindowMs;
  }

  setGraceWindowMs(nextGraceWindowMs: number): void {
    if (!Number.isFinite(nextGraceWindowMs)) {
      return;
    }
    this.graceWindowMs = Math.max(1, Math.round(nextGraceWindowMs));
  }

  enqueue(sequence: number, payload: T, enqueuedAt = Date.now()): void {
    if (!Number.isFinite(sequence)) {
      return;
    }
    const normalizedSequence = Math.max(0, Math.trunc(sequence));
    const existingIndex = this.queue.findIndex((item) => item.sequence === normalizedSequence);
    const entry: GoldenFrameSequenced<T> = {
      sequence: normalizedSequence,
      payload,
      enqueuedAt,
    };
    if (existingIndex >= 0) {
      this.queue[existingIndex] = entry;
    } else {
      this.queue.push(entry);
    }
    this.queue.sort((left, right) => left.sequence - right.sequence);
    if (this.expectedSequence === null) {
      this.expectedSequence = normalizedSequence;
      this.gapStartedAt = 0;
    }
    while (this.queue.length > this.maxQueueDepth) {
      this.queue.shift();
      if (this.expectedSequence !== null) {
        this.expectedSequence += 1;
      }
    }
  }

  poll(now = Date.now()): GoldenFrameSequenceGuardResult<T> {
    if (this.queue.length === 0) {
      return {
        ready: null,
        skippedGapCount: 0,
        queueDepth: 0,
        nextWakeDelayMs: null,
      };
    }

    if (this.expectedSequence === null) {
      this.expectedSequence = this.queue[0]?.sequence ?? null;
    }

    let skippedGapCount = 0;
    while (this.queue.length > 0 && this.expectedSequence !== null) {
      const head = this.queue[0];
      if (!head) {
        break;
      }
      if (head.sequence < this.expectedSequence) {
        this.queue.shift();
        continue;
      }
      if (head.sequence === this.expectedSequence) {
        this.queue.shift();
        const ready = head;
        this.expectedSequence += 1;
        this.gapStartedAt = 0;
        return {
          ready,
          skippedGapCount,
          queueDepth: this.queue.length,
          nextWakeDelayMs: null,
        };
      }
      if (this.gapStartedAt <= 0) {
        this.gapStartedAt = now;
        return {
          ready: null,
          skippedGapCount,
          queueDepth: this.queue.length,
          nextWakeDelayMs: this.graceWindowMs,
        };
      }
      const elapsedMs = now - this.gapStartedAt;
      if (elapsedMs < this.graceWindowMs) {
        return {
          ready: null,
          skippedGapCount,
          queueDepth: this.queue.length,
          nextWakeDelayMs: this.graceWindowMs - elapsedMs,
        };
      }
      skippedGapCount += 1;
      this.expectedSequence += 1;
      this.gapStartedAt = now;
    }

    return {
      ready: null,
      skippedGapCount,
      queueDepth: this.queue.length,
      nextWakeDelayMs: this.queue.length > 0 ? this.graceWindowMs : null,
    };
  }
}