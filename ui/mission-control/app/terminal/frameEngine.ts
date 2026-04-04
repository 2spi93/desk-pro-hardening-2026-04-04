export type LatestFrameScheduler<T> = {
  schedule: (payload: T, render: (payload: T) => void) => void;
  cancel: () => void;
  configure: (options: LatestFrameSchedulerOptions) => void;
};

export type LatestFrameSchedulerOptions = {
  minFrameMs?: number;
  strictBucketAlignment?: boolean;
};

export function createLatestFrameScheduler<T>(initialOptions?: LatestFrameSchedulerOptions): LatestFrameScheduler<T> {
  let pending = false;
  let lastPayload: T | null = null;
  let rafId: number | null = null;
  let lastFrameTime = 0;
  let lastRender: ((payload: T) => void) | null = null;
  let options: Required<LatestFrameSchedulerOptions> = {
    minFrameMs: Math.max(8, Math.round(initialOptions?.minFrameMs ?? 16)),
    strictBucketAlignment: initialOptions?.strictBucketAlignment ?? true,
  };

  const flush = (frameTime: number) => {
    if (frameTime - lastFrameTime < options.minFrameMs) {
      rafId = window.requestAnimationFrame(flush);
      return;
    }

    pending = false;
    rafId = null;
    lastFrameTime = options.strictBucketAlignment
      ? frameTime - (frameTime % options.minFrameMs)
      : frameTime;

    const nextPayload = lastPayload;
    const nextRender = lastRender;
    lastPayload = null;

    if (nextPayload !== null && nextRender) {
      nextRender(nextPayload);
    }

    if (lastPayload !== null && !pending) {
      pending = true;
      rafId = window.requestAnimationFrame(flush);
    }
  };

  return {
    schedule(payload, render) {
      lastPayload = payload;
      lastRender = render;

      if (pending) {
        return;
      }

      if (typeof window === "undefined") {
        const nextPayload = lastPayload;
        lastPayload = null;
        if (nextPayload !== null) {
          render(nextPayload);
        }
        return;
      }

      pending = true;
      rafId = window.requestAnimationFrame(flush);
    },
    cancel() {
      if (typeof window !== "undefined" && rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      pending = false;
      rafId = null;
      lastPayload = null;
      lastRender = null;
    },
    configure(nextOptions) {
      options = {
        minFrameMs: Math.max(8, Math.round(nextOptions.minFrameMs ?? options.minFrameMs)),
        strictBucketAlignment: nextOptions.strictBucketAlignment ?? options.strictBucketAlignment,
      };
    },
  };
}