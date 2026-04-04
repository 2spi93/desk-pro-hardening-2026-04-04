export type LocalFreshnessState = "fresh" | "stale" | "degraded" | "hard-fail";
export type LocalHealthTone = "good" | "warn" | "bad";
export type LocalStreamState = "offline" | "connecting" | "live";
export type LocalOhlcvSignal = "OHLCV_RENDERABLE" | "OHLCV_PARTIAL" | "OHLCV_UNUSABLE";

export type LocalTerminalPerceptualRuntime = {
  engine: "v3" | "v4";
  densityLevel: string;
  visibleBars: number;
  candleStepPx: number;
  profile: string | null;
  renderer: string | null;
  gridLabel: string | null;
  pixelSnapping: boolean;
  denseMode: string | null;
  preferredBodyWidthPx: number | null;
  wickWidthPx: number | null;
  minGapPx: number | null;
  fps: number;
  frameTimeMs: number | null;
  cpuLoad: number | null;
  workerLatencyMs: number | null;
  drawCalls: number | null;
  batchSize: number | null;
  reframeCount: number | null;
  transitionMode: string | null;
  lastPriceDriftPx: number | null;
  peakPriceDriftPx: number | null;
  updatedAt: string;
};

export type LocalTerminalRuntimeCapture = {
  version: 1;
  clientId: string;
  capturedAt: string;
  auth: {
    status: string;
    sessionRequired: boolean;
  };
  chart: {
    symbol: string;
    instrument: string;
    venue: string;
    timeframe: string;
    mode: "line" | "candles" | "footprint";
    visualMode: "auto" | "clean" | "full";
    feedLabel: string;
  };
  localFeed: {
    signal: LocalOhlcvSignal;
    message: string;
    fetchedRows: number;
    renderableRows: number;
    droppedRows: number;
    duplicateTimestamps: number;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    reasons: string[];
    droppedReasonKinds: string[];
  };
  runtime: {
    bus: {
      status: string;
      tone: LocalHealthTone;
      display: string;
    };
    ohlcv: {
      status: LocalStreamState;
      tone: LocalHealthTone;
      display: string;
    };
    seq: {
      contiguous: boolean;
      latestSeq: number;
      tone: LocalHealthTone;
      display: string;
    };
    dom: {
      status: LocalStreamState;
      tone: LocalHealthTone;
      display: string;
    };
    bars: {
      state: LocalFreshnessState;
      age: string;
      tone: LocalHealthTone;
      display: string;
    };
    depth: {
      state: LocalFreshnessState;
      age: string;
      tone: LocalHealthTone;
      display: string;
    };
    trades: {
      state: LocalFreshnessState;
      age: string;
      tone: LocalHealthTone;
      display: string;
    };
    candles: {
      receivedTicks: number;
      candleUpdates: number;
      syntheticHeartbeatOpens: number;
      lastUpdateAge: string;
    };
    perceptual: LocalTerminalPerceptualRuntime | null;
    compactAlertLabel: string;
    alertText: string;
    exactStateVector: string[];
    noCandlesExpected: boolean;
    blockedByFiveStateFailure: boolean;
  };
};

export type LocalTerminalAutoIncident = {
  clientId: string;
  signature: string;
  openedAt: string;
  closedAt?: string | null;
  ticketKey: string | null;
  title: string;
  detail: string;
  status: "opened" | "closed" | "suppressed" | "failed" | "close-failed";
};

export type PersistedLocalTerminalCaptureStore = {
  version: 1;
  updatedAt: string | null;
  latestClientId: string | null;
  captures: Record<string, LocalTerminalRuntimeCapture>;
  captureHistory: Record<string, LocalTerminalRuntimeCapture[]>;
  autoIncidents: Record<string, LocalTerminalAutoIncident>;
};

export type BuildLocalTerminalRuntimeCaptureInput = {
  clientId: string;
  capturedAt: string;
  authStatus: string;
  authSessionRequired: boolean;
  symbol: string;
  instrument: string;
  venue: string;
  timeframe: string;
  chartMode: "line" | "candles" | "footprint";
  chartVisualMode: "auto" | "clean" | "full";
  feedLabel: string;
  localFeedSignal: LocalOhlcvSignal;
  localFeedMessage: string;
  fetchedRows: number;
  renderableRows: number;
  droppedRows: number;
  duplicateTimestamps: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  reasons: string[];
  droppedReasonKinds: string[];
  marketBusHealthStatus: string;
  marketBusHealthTone: LocalHealthTone;
  ohlcvStreamState: LocalStreamState;
  displayDepthStreamState: LocalStreamState;
  marketBusOhlcvContiguous: boolean;
  marketBusOhlcvLatestSeq: number;
  ohlcvFreshnessState: LocalFreshnessState;
  depthFreshnessState: LocalFreshnessState;
  tradesFreshnessState: LocalFreshnessState;
  barsAge: string;
  depthAge: string;
  tradesAge: string;
  candleTicks: number;
  candleUpdates: number;
  syntheticHeartbeatOpens: number;
  candleLastUpdateAge: string;
  chartCompactAlertLabel: string;
  chartFlowAlertText: string;
  perceptual?: LocalTerminalPerceptualRuntime | null;
};

const MAX_CAPTURE_COUNT = 12;
const MAX_CAPTURE_HISTORY_PER_CLIENT = 24;

function asToneForStatus(status: LocalFreshnessState | LocalStreamState | string): LocalHealthTone {
  if (status === "ok" || status === "live" || status === "fresh") {
    return "good";
  }
  if (status === "connecting" || status === "stale") {
    return "warn";
  }
  return "bad";
}

export function defaultLocalTerminalCaptureStore(): PersistedLocalTerminalCaptureStore {
  return {
    version: 1,
    updatedAt: null,
    latestClientId: null,
    captures: {},
    captureHistory: {},
    autoIncidents: {},
  };
}

export function buildLocalTerminalIncidentSignature(capture: LocalTerminalRuntimeCapture): string {
  return JSON.stringify({
    clientId: capture.clientId,
    feed: capture.chart.feedLabel,
    signal: capture.localFeed.signal,
    state: capture.runtime.exactStateVector,
    blocked: capture.runtime.blockedByFiveStateFailure,
  });
}

export function buildLocalTerminalRuntimeCapture(input: BuildLocalTerminalRuntimeCaptureInput): LocalTerminalRuntimeCapture {
  const exactStateVector = [
    `BUS ${String(input.marketBusHealthStatus || "offline").toUpperCase()}`,
    `OHLCV ${input.ohlcvStreamState.toUpperCase()}`,
    `BARS ${input.ohlcvFreshnessState.toUpperCase()} ${input.barsAge}`,
    `DEPTH ${input.depthFreshnessState.toUpperCase()} ${input.depthAge}`,
    `TRADES ${input.tradesFreshnessState.toUpperCase()} ${input.tradesAge}`,
  ];
  const blockedByFiveStateFailure = String(input.marketBusHealthStatus || "offline") !== "ok"
    && input.ohlcvStreamState !== "live"
    && input.ohlcvFreshnessState === "hard-fail"
    && input.depthFreshnessState === "hard-fail"
    && input.tradesFreshnessState === "hard-fail";
  const noCandlesExpected = blockedByFiveStateFailure
    || input.localFeedSignal === "OHLCV_UNUSABLE"
    || input.ohlcvStreamState !== "live"
    || input.ohlcvFreshnessState === "hard-fail";

  return {
    version: 1,
    clientId: input.clientId,
    capturedAt: input.capturedAt,
    auth: {
      status: input.authStatus,
      sessionRequired: input.authSessionRequired,
    },
    chart: {
      symbol: input.symbol,
      instrument: input.instrument,
      venue: input.venue,
      timeframe: input.timeframe,
      mode: input.chartMode,
      visualMode: input.chartVisualMode,
      feedLabel: input.feedLabel,
    },
    localFeed: {
      signal: input.localFeedSignal,
      message: input.localFeedMessage,
      fetchedRows: input.fetchedRows,
      renderableRows: input.renderableRows,
      droppedRows: input.droppedRows,
      duplicateTimestamps: input.duplicateTimestamps,
      firstTimestamp: input.firstTimestamp,
      lastTimestamp: input.lastTimestamp,
      reasons: input.reasons,
      droppedReasonKinds: input.droppedReasonKinds,
    },
    runtime: {
      bus: {
        status: input.marketBusHealthStatus,
        tone: input.marketBusHealthTone,
        display: `BUS ${String(input.marketBusHealthStatus || "offline").toUpperCase()}`,
      },
      ohlcv: {
        status: input.ohlcvStreamState,
        tone: asToneForStatus(input.ohlcvStreamState),
        display: `OHLCV ${input.ohlcvStreamState.toUpperCase()}`,
      },
      seq: {
        contiguous: input.marketBusOhlcvContiguous,
        latestSeq: input.marketBusOhlcvLatestSeq,
        tone: input.marketBusOhlcvContiguous ? "good" : "warn",
        display: `${input.marketBusOhlcvContiguous ? "SEQ OK" : "SEQ GAP"} ${input.marketBusOhlcvLatestSeq > 0 ? `#${input.marketBusOhlcvLatestSeq}` : "#-"}`,
      },
      dom: {
        status: input.displayDepthStreamState,
        tone: asToneForStatus(input.displayDepthStreamState),
        display: `DOM ${input.displayDepthStreamState.toUpperCase()}`,
      },
      bars: {
        state: input.ohlcvFreshnessState,
        age: input.barsAge,
        tone: asToneForStatus(input.ohlcvFreshnessState),
        display: `BARS ${input.ohlcvFreshnessState.toUpperCase()} ${input.barsAge}`,
      },
      depth: {
        state: input.depthFreshnessState,
        age: input.depthAge,
        tone: asToneForStatus(input.depthFreshnessState),
        display: `DEPTH ${input.depthFreshnessState.toUpperCase()} ${input.depthAge}`,
      },
      trades: {
        state: input.tradesFreshnessState,
        age: input.tradesAge,
        tone: asToneForStatus(input.tradesFreshnessState),
        display: `TRADES ${input.tradesFreshnessState.toUpperCase()} ${input.tradesAge}`,
      },
      candles: {
        receivedTicks: input.candleTicks,
        candleUpdates: input.candleUpdates,
        syntheticHeartbeatOpens: input.syntheticHeartbeatOpens,
        lastUpdateAge: input.candleLastUpdateAge,
      },
      perceptual: input.perceptual || null,
      compactAlertLabel: input.chartCompactAlertLabel,
      alertText: input.chartFlowAlertText,
      exactStateVector,
      noCandlesExpected,
      blockedByFiveStateFailure,
    },
  };
}

export function normalizeLocalTerminalCaptureStore(raw: unknown): PersistedLocalTerminalCaptureStore {
  if (!raw || typeof raw !== "object") {
    return defaultLocalTerminalCaptureStore();
  }
  const payload = raw as Partial<PersistedLocalTerminalCaptureStore> & {
    captures?: Record<string, LocalTerminalRuntimeCapture>;
    captureHistory?: Record<string, LocalTerminalRuntimeCapture[]>;
    autoIncidents?: Record<string, LocalTerminalAutoIncident>;
  };
  const captures = payload.captures && typeof payload.captures === "object"
    ? payload.captures
    : {};
  const captureHistoryRaw = payload.captureHistory && typeof payload.captureHistory === "object"
    ? payload.captureHistory
    : {};
  const autoIncidents = payload.autoIncidents && typeof payload.autoIncidents === "object"
    ? Object.entries(payload.autoIncidents).reduce<Record<string, LocalTerminalAutoIncident>>((accumulator, [clientId, incident]) => {
      if (!incident || typeof incident !== "object") {
        return accumulator;
      }
      const candidate = incident as Partial<LocalTerminalAutoIncident>;
      if (typeof candidate.clientId !== "string" || typeof candidate.signature !== "string" || typeof candidate.openedAt !== "string") {
        return accumulator;
      }
      accumulator[clientId] = {
        clientId: candidate.clientId,
        signature: candidate.signature,
        openedAt: candidate.openedAt,
        closedAt: typeof candidate.closedAt === "string" ? candidate.closedAt : null,
        ticketKey: typeof candidate.ticketKey === "string" ? candidate.ticketKey : null,
        title: typeof candidate.title === "string" ? candidate.title : "Local terminal hard fail",
        detail: typeof candidate.detail === "string" ? candidate.detail : "unknown",
        status: candidate.status === "opened" || candidate.status === "closed" || candidate.status === "suppressed" || candidate.status === "failed" || candidate.status === "close-failed"
          ? candidate.status
          : "failed",
      };
      return accumulator;
    }, {})
    : {};
  const orderedCaptures = Object.values(captures)
    .filter((capture) => Boolean(capture && typeof capture === "object" && typeof capture.clientId === "string" && typeof capture.capturedAt === "string"))
    .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
    .slice(0, MAX_CAPTURE_COUNT);
  const normalizedHistory = Object.entries(captureHistoryRaw).reduce<Record<string, LocalTerminalRuntimeCapture[]>>((accumulator, [clientId, history]) => {
    if (!Array.isArray(history)) {
      return accumulator;
    }
    const entries = history
      .filter((capture) => Boolean(capture && typeof capture === "object" && typeof (capture as LocalTerminalRuntimeCapture).clientId === "string" && typeof (capture as LocalTerminalRuntimeCapture).capturedAt === "string"))
      .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
      .slice(0, MAX_CAPTURE_HISTORY_PER_CLIENT);
    if (entries.length > 0) {
      accumulator[clientId] = entries;
    }
    return accumulator;
  }, {});

  return {
    version: 1,
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
    latestClientId: typeof payload.latestClientId === "string" ? payload.latestClientId : (orderedCaptures[0]?.clientId || null),
    captures: orderedCaptures.reduce<Record<string, LocalTerminalRuntimeCapture>>((accumulator, capture) => {
      accumulator[capture.clientId] = capture;
      return accumulator;
    }, {}),
    captureHistory: normalizedHistory,
    autoIncidents,
  };
}

export function upsertLocalTerminalCaptureStore(
  store: PersistedLocalTerminalCaptureStore,
  capture: LocalTerminalRuntimeCapture,
): PersistedLocalTerminalCaptureStore {
  const nextHistory = [capture, ...(store.captureHistory[capture.clientId] || [])]
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.capturedAt === entry.capturedAt) === index)
    .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
    .slice(0, MAX_CAPTURE_HISTORY_PER_CLIENT);
  const nextStore = normalizeLocalTerminalCaptureStore({
    ...store,
    updatedAt: capture.capturedAt,
    latestClientId: capture.clientId,
    captures: {
      ...store.captures,
      [capture.clientId]: capture,
    },
    captureHistory: {
      ...store.captureHistory,
      [capture.clientId]: nextHistory,
    },
  });
  return nextStore;
}

export function setLocalTerminalAutoIncident(
  store: PersistedLocalTerminalCaptureStore,
  incident: LocalTerminalAutoIncident,
): PersistedLocalTerminalCaptureStore {
  return normalizeLocalTerminalCaptureStore({
    ...store,
    autoIncidents: {
      ...store.autoIncidents,
      [incident.clientId]: incident,
    },
  });
}

export function getLocalTerminalCaptureByClientId(
  store: PersistedLocalTerminalCaptureStore,
  clientId: string | null | undefined,
): LocalTerminalRuntimeCapture | null {
  if (!clientId) {
    return null;
  }
  return store.captures[clientId] || null;
}

export function getLocalTerminalCaptureHistory(
  store: PersistedLocalTerminalCaptureStore,
  clientId: string | null | undefined,
): LocalTerminalRuntimeCapture[] {
  if (!clientId) {
    return [];
  }
  return store.captureHistory[clientId] || [];
}

export function getLocalTerminalAutoIncident(
  store: PersistedLocalTerminalCaptureStore,
  clientId: string | null | undefined,
): LocalTerminalAutoIncident | null {
  if (!clientId) {
    return null;
  }
  return store.autoIncidents[clientId] || null;
}

export function getLatestLocalTerminalCapture(store: PersistedLocalTerminalCaptureStore): LocalTerminalRuntimeCapture | null {
  const latestClientId = store.latestClientId;
  if (latestClientId && store.captures[latestClientId]) {
    return store.captures[latestClientId];
  }
  const captures = Object.values(store.captures).sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)));
  return captures[0] || null;
}

export function summarizeLocalTerminalCaptures(store: PersistedLocalTerminalCaptureStore): Array<{
  client_id: string;
  captured_at: string;
  chart_feed: string;
  local_feed_signal: LocalOhlcvSignal;
  exact_state_vector: string[];
  no_candles_expected: boolean;
  synthetic_heartbeat_opens: number;
  history_count: number;
}> {
  return Object.values(store.captures)
    .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
    .map((capture) => ({
      client_id: capture.clientId,
      captured_at: capture.capturedAt,
      chart_feed: capture.chart.feedLabel,
      local_feed_signal: capture.localFeed.signal,
      exact_state_vector: capture.runtime.exactStateVector,
      no_candles_expected: capture.runtime.noCandlesExpected,
      synthetic_heartbeat_opens: capture.runtime.candles?.syntheticHeartbeatOpens ?? 0,
      history_count: store.captureHistory[capture.clientId]?.length || 0,
    }));
}

export function summarizeRecentLocalTerminalCaptureEvents(store: PersistedLocalTerminalCaptureStore): Array<{
  client_id: string;
  captured_at: string;
  chart_feed: string;
  blocked_by_five_state_failure: boolean;
  exact_state_vector: string[];
}> {
  return Object.entries(store.captureHistory)
    .flatMap(([clientId, history]) => history.map((capture) => ({
      client_id: clientId,
      captured_at: capture.capturedAt,
      chart_feed: capture.chart.feedLabel,
      blocked_by_five_state_failure: capture.runtime.blockedByFiveStateFailure,
      exact_state_vector: capture.runtime.exactStateVector,
    })))
    .sort((left, right) => String(right.captured_at).localeCompare(String(left.captured_at)))
    .slice(0, MAX_CAPTURE_COUNT * 4);
}

export function isLocalTerminalRuntimeCapture(value: unknown): value is LocalTerminalRuntimeCapture {
  if (!value || typeof value !== "object") {
    return false;
  }
  const capture = value as Partial<LocalTerminalRuntimeCapture>;
  return capture.version === 1
    && typeof capture.clientId === "string"
    && typeof capture.capturedAt === "string"
    && Boolean(capture.chart && typeof capture.chart === "object")
    && Boolean(capture.runtime && typeof capture.runtime === "object")
    && Boolean(capture.localFeed && typeof capture.localFeed === "object");
}