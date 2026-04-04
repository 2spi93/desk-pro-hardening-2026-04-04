export type TerminalComputePerfEntry = {
  label: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  lastMs: number;
  lastAt: string;
};

type MutableTerminalComputePerfEntry = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  lastAt: number;
};

type TerminalComputePerfStore = {
  updatedAt: number;
  entries: Record<string, MutableTerminalComputePerfEntry>;
};

declare global {
  interface Window {
    __MC_TERMINAL_COMPUTE_PERF__?: TerminalComputePerfStore;
  }
}

function roundPerfValue(value: number): number {
  return Number(value.toFixed(3));
}

function ensureTerminalComputePerfStore(createIfMissing: boolean): TerminalComputePerfStore | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (!window.__MC_TERMINAL_COMPUTE_PERF__ && createIfMissing) {
    window.__MC_TERMINAL_COMPUTE_PERF__ = {
      updatedAt: Date.now(),
      entries: {},
    };
  }
  return window.__MC_TERMINAL_COMPUTE_PERF__ || null;
}

export function clearTerminalComputePerf(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.__MC_TERMINAL_COMPUTE_PERF__ = {
    updatedAt: Date.now(),
    entries: {},
  };
}

export function measureTerminalCompute<T>(label: string, enabled: boolean, compute: () => T): T {
  if (!enabled) {
    return compute();
  }
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const result = compute();
  const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const elapsedMs = Math.max(0, finishedAt - startedAt);
  const store = ensureTerminalComputePerfStore(true);
  if (!store) {
    return result;
  }
  const current = store.entries[label] || {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    lastAt: 0,
  };
  current.count += 1;
  current.totalMs += elapsedMs;
  current.maxMs = Math.max(current.maxMs, elapsedMs);
  current.lastMs = elapsedMs;
  current.lastAt = Date.now();
  store.entries[label] = current;
  store.updatedAt = current.lastAt;
  return result;
}

export function snapshotTerminalComputePerf(limit = 6): TerminalComputePerfEntry[] {
  const store = ensureTerminalComputePerfStore(false);
  if (!store) {
    return [];
  }
  return Object.entries(store.entries)
    .map(([label, entry]) => ({
      label,
      count: entry.count,
      totalMs: roundPerfValue(entry.totalMs),
      avgMs: roundPerfValue(entry.totalMs / Math.max(entry.count, 1)),
      maxMs: roundPerfValue(entry.maxMs),
      lastMs: roundPerfValue(entry.lastMs),
      lastAt: new Date(entry.lastAt).toISOString(),
    }))
    .sort((left, right) => {
      if (right.totalMs !== left.totalMs) {
        return right.totalMs - left.totalMs;
      }
      if (right.maxMs !== left.maxMs) {
        return right.maxMs - left.maxMs;
      }
      return right.count - left.count;
    })
    .slice(0, limit);
}