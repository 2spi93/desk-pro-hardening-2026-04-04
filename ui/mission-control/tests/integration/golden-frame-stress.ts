import assert from "node:assert/strict";

import { GoldenFrameSequenceGuard } from "../../lib/goldenFrameSequenceGuard";

type SimulatedFrame = {
  seq: number;
  payload: string;
};

function createRng(seed = 1337): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(rng() * (index + 1));
    const tmp = items[index];
    items[index] = items[nextIndex] as T;
    items[nextIndex] = tmp as T;
  }
}

function runStressScenario(): void {
  const guard = new GoldenFrameSequenceGuard<SimulatedFrame>({
    graceWindowMs: 5,
    maxQueueDepth: 512,
  });
  const rng = createRng();
  const totalSequences = 5_000;
  const reorderProbability = 0.2;
  const dropRate = 0.05;
  const pendingBatch: SimulatedFrame[] = [];
  const processed: number[] = [];
  let skippedGapCount = 0;
  let maxQueueDepth = 0;
  let now = 0;

  const flushReady = (targetNow: number) => {
    now = targetNow;
    while (true) {
      const result = guard.poll(now);
      skippedGapCount += result.skippedGapCount;
      maxQueueDepth = Math.max(maxQueueDepth, result.queueDepth);
      if (result.ready) {
        processed.push(result.ready.sequence);
        continue;
      }
      if (result.nextWakeDelayMs !== null) {
        now += result.nextWakeDelayMs;
        continue;
      }
      break;
    }
  };

  for (let sequence = 1; sequence <= totalSequences; sequence += 1) {
    now += 0.2;
    if (rng() < dropRate) {
      flushReady(now + 5);
      continue;
    }
    pendingBatch.push({ seq: sequence, payload: `frame-${sequence}` });
    const shouldRelease = rng() >= reorderProbability || pendingBatch.length >= 8 || sequence === totalSequences;
    if (!shouldRelease) {
      continue;
    }
    shuffleInPlace(pendingBatch, rng);
    while (pendingBatch.length > 0) {
      const next = pendingBatch.shift();
      if (!next) {
        break;
      }
      guard.enqueue(next.seq, next, now);
      flushReady(now);
    }
  }

  flushReady(now + 25);

  assert.ok(processed.length > 4_000, `expected most frames to flush under stress, got ${processed.length}`);
  for (let index = 1; index < processed.length; index += 1) {
    assert.ok(processed[index] > processed[index - 1], "processed sequences must remain strictly ordered");
  }
  assert.ok(skippedGapCount > 0, "stress scenario should detect and skip at least one missing sequence gap");
  assert.ok(maxQueueDepth <= 512, `sequence guard must bound queued frames, got ${maxQueueDepth}`);
}

function runAdaptiveGraceScenario(): void {
  const guard = new GoldenFrameSequenceGuard<SimulatedFrame>({
    graceWindowMs: 5,
    maxQueueDepth: 32,
  });

  guard.enqueue(1, { seq: 1, payload: "frame-1" }, 0);
  let result = guard.poll(0);
  assert.equal(result.ready?.sequence, 1, "sequence guard should flush the first in-order frame immediately");

  guard.setGraceWindowMs(20);
  guard.enqueue(3, { seq: 3, payload: "frame-3" }, 1);

  result = guard.poll(1);
  assert.equal(result.ready, null, "guard must wait when a sequence gap opens");
  assert.equal(result.nextWakeDelayMs, 20, "guard should honor the updated adaptive grace window");

  result = guard.poll(11);
  assert.equal(result.ready, null, "guard must still wait before the adaptive grace expires");
  assert.equal(result.nextWakeDelayMs, 10, "remaining adaptive grace should count down deterministically");
}

runStressScenario();
runAdaptiveGraceScenario();
console.log("PASS golden-frame stress: sequence guard drains 5000 seq burst with reorder/drop while bounding queue depth and honors adaptive grace updates");