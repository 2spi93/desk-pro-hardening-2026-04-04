import { cookies } from "next/headers";

function resolveFirstControlPlaneUrl(names: string[], fallback: string): string {
  for (const name of names) {
    const candidate = String(process.env[name] || "").trim();
    if (candidate) {
      return candidate;
    }
  }
  return fallback;
}

const defaultControlPlaneUrl = "http://control-plane:8000";
const baseUrl = resolveFirstControlPlaneUrl(["CONTROL_PLANE_URL", "CONTROL_PLANE_FALLBACK_URL", "KAIROS_CONTROL_PLANE_URL"], defaultControlPlaneUrl);
const fallbackBaseUrl = resolveFirstControlPlaneUrl(["CONTROL_PLANE_FALLBACK_URL", "CONTROL_PLANE_URL", "KAIROS_CONTROL_PLANE_URL"], defaultControlPlaneUrl);
const fallbackToken = process.env.CONTROL_PLANE_TOKEN || "";
const retryAttemptsRaw = Number.parseInt(process.env.MC_CONTROL_PLANE_RETRY_ATTEMPTS || "2", 10);
const retryBaseDelayMsRaw = Number.parseInt(process.env.MC_CONTROL_PLANE_RETRY_BASE_DELAY_MS || "150", 10);
const controlPlaneRetryAttempts = Number.isFinite(retryAttemptsRaw) ? Math.min(Math.max(retryAttemptsRaw, 1), 4) : 2;
const controlPlaneRetryBaseDelayMs = Number.isFinite(retryBaseDelayMsRaw) ? Math.min(Math.max(retryBaseDelayMsRaw, 25), 1000) : 150;
const controlPlaneGlobal = globalThis as typeof globalThis & {
  __mcE2eDegradedWarnedKeys?: Set<string>;
  __mcControlPlaneNetworkMetrics?: ControlPlaneNetworkMetricsStore;
};
const degradedWarnedKeys = controlPlaneGlobal.__mcE2eDegradedWarnedKeys || new Set<string>();
if (!controlPlaneGlobal.__mcE2eDegradedWarnedKeys) {
  controlPlaneGlobal.__mcE2eDegradedWarnedKeys = degradedWarnedKeys;
}

function isE2eDevDegradedModeEnabled(): boolean {
  const raw = String(process.env.MC_E2E_DEV_DEGRADED || "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isTruthyEnvFlag(name: string): boolean {
  const raw = String(process.env[name] || "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isControlPlaneDevNoiseSuppressed(): boolean {
  if (!isE2eDevDegradedModeEnabled()) {
    return false;
  }
  if (String(process.env.MC_E2E_DEV_DEGRADED_SILENT || "").trim()) {
    return isTruthyEnvFlag("MC_E2E_DEV_DEGRADED_SILENT");
  }
  return isTruthyEnvFlag("PLAYWRIGHT_TEST");
}

function warnDegradedOnce(key: string, message: string): void {
  if (degradedWarnedKeys.has(key)) {
    return;
  }
  degradedWarnedKeys.add(key);
  if (isControlPlaneDevNoiseSuppressed()) {
    return;
  }
  console.warn(message);
}

type ControlPlaneFailureClass =
  | "dns_transient"
  | "dns_unresolved"
  | "timeout"
  | "connection_refused"
  | "connection_reset"
  | "aborted"
  | "network_unknown"
  | "unknown_error";

type ControlPlaneFailureDetails = {
  classification: ControlPlaneFailureClass;
  code: string;
  hostname: string;
  syscall: string;
  message: string;
  retryable: boolean;
};

export type ControlPlaneNetworkState = "healthy" | "retry_recovered" | "degraded";

export type ControlPlaneNetworkMeta = {
  network_state: ControlPlaneNetworkState;
  retry_count: number;
  degraded_flag: boolean;
  failure_classification: ControlPlaneFailureClass | "none";
  failure_detail: string;
  attempted_targets: string[];
  attempted_base_urls: string[];
  upstream_status: number;
};

type ControlPlaneRouteMetrics = {
  request_count: number;
  healthy_count: number;
  retry_recovered_count: number;
  degraded_count: number;
  dns_transient_count: number;
  timeout_count: number;
  failure_classifications: Record<string, number>;
  last_failure_classification: string;
  last_seen_at: string;
};

type ControlPlaneNetworkMetricsStore = {
  total_requests: number;
  healthy_count: number;
  retry_recovered_count: number;
  degraded_count: number;
  dns_transient_count: number;
  timeout_count: number;
  failure_classifications: Record<string, number>;
  route_families: Record<string, ControlPlaneRouteMetrics>;
  updated_at: string;
};

export type ControlPlaneNetworkMetricsSnapshot = ControlPlaneNetworkMetricsStore & {
  dns_transient_rate: number;
  timeout_rate: number;
  degraded_usage_ratio: number;
  retry_recovered_ratio: number;
};

export type ControlPlaneNetworkRegime = "stable" | "degraded" | "critical";

type ControlPlaneRequestPolicy = {
  attempts: number;
  baseDelayMs: number;
  preflightDelayMs: number;
  retryJitterMs: number;
  infraHealth: number;
  networkRegime: ControlPlaneNetworkRegime;
};

function createControlPlaneRouteMetrics(): ControlPlaneRouteMetrics {
  return {
    request_count: 0,
    healthy_count: 0,
    retry_recovered_count: 0,
    degraded_count: 0,
    dns_transient_count: 0,
    timeout_count: 0,
    failure_classifications: {},
    last_failure_classification: "none",
    last_seen_at: new Date(0).toISOString(),
  };
}

function createControlPlaneNetworkMetricsStore(): ControlPlaneNetworkMetricsStore {
  return {
    total_requests: 0,
    healthy_count: 0,
    retry_recovered_count: 0,
    degraded_count: 0,
    dns_transient_count: 0,
    timeout_count: 0,
    failure_classifications: {},
    route_families: {},
    updated_at: new Date(0).toISOString(),
  };
}

function getControlPlaneNetworkMetricsStore(): ControlPlaneNetworkMetricsStore {
  if (!controlPlaneGlobal.__mcControlPlaneNetworkMetrics) {
    controlPlaneGlobal.__mcControlPlaneNetworkMetrics = createControlPlaneNetworkMetricsStore();
  }
  return controlPlaneGlobal.__mcControlPlaneNetworkMetrics;
}

function incrementCounter(target: Record<string, number>, key: string): void {
  target[key] = (target[key] || 0) + 1;
}

function recordControlPlaneNetworkMetric(path: string, network: ControlPlaneNetworkMeta): void {
  const store = getControlPlaneNetworkMetricsStore();
  const family = toRouteFamily(path);
  const now = new Date().toISOString();
  const classification = String(network.failure_classification || "none");
  const bucket = store.route_families[family] || createControlPlaneRouteMetrics();

  store.total_requests += 1;
  bucket.request_count += 1;

  if (network.network_state === "degraded") {
    store.degraded_count += 1;
    bucket.degraded_count += 1;
  } else if (network.network_state === "retry_recovered") {
    store.retry_recovered_count += 1;
    bucket.retry_recovered_count += 1;
  } else {
    store.healthy_count += 1;
    bucket.healthy_count += 1;
  }

  if (classification === "dns_transient") {
    store.dns_transient_count += 1;
    bucket.dns_transient_count += 1;
  }
  if (classification === "timeout") {
    store.timeout_count += 1;
    bucket.timeout_count += 1;
  }

  incrementCounter(store.failure_classifications, classification);
  incrementCounter(bucket.failure_classifications, classification);
  bucket.last_failure_classification = classification;
  bucket.last_seen_at = now;

  store.route_families[family] = bucket;
  store.updated_at = now;
}

export function getControlPlaneNetworkMetricsSnapshot(): ControlPlaneNetworkMetricsSnapshot {
  const store = getControlPlaneNetworkMetricsStore();
  const totalRequests = store.total_requests;
  const routeFamilies = Object.fromEntries(
    Object.entries(store.route_families).map(([family, bucket]) => [family, {
      ...bucket,
      failure_classifications: { ...bucket.failure_classifications },
    }]),
  );

  return {
    ...store,
    failure_classifications: { ...store.failure_classifications },
    route_families: routeFamilies,
    dns_transient_rate: totalRequests > 0 ? store.dns_transient_count / totalRequests : 0,
    timeout_rate: totalRequests > 0 ? store.timeout_count / totalRequests : 0,
    degraded_usage_ratio: totalRequests > 0 ? store.degraded_count / totalRequests : 0,
    retry_recovered_ratio: totalRequests > 0 ? store.retry_recovered_count / totalRequests : 0,
  };
}

function clampRatio(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function computeControlPlaneInfraHealth(metrics: ControlPlaneNetworkMetricsSnapshot): number {
  const dnsPenalty = clampRatio(metrics.dns_transient_rate * 1.15, 0, 0.28);
  const timeoutPenalty = clampRatio(metrics.timeout_rate * 1.45, 0, 0.34);
  const degradedPenalty = clampRatio(metrics.degraded_usage_ratio * 1.9, 0, 0.5);
  const retryPenalty = clampRatio(metrics.retry_recovered_ratio * 0.45, 0, 0.12);
  return clampRatio(1 - dnsPenalty - timeoutPenalty - degradedPenalty - retryPenalty, 0.05, 1);
}

export function classifyControlPlaneNetworkRegime(
  metrics: ControlPlaneNetworkMetricsSnapshot,
  infraHealth = computeControlPlaneInfraHealth(metrics),
): ControlPlaneNetworkRegime {
  if (infraHealth <= 0.45 || metrics.degraded_usage_ratio >= 0.18 || metrics.timeout_rate >= 0.1) {
    return "critical";
  }
  if (infraHealth <= 0.78 || metrics.dns_transient_rate >= 0.08 || metrics.retry_recovered_ratio >= 0.12 || metrics.degraded_usage_ratio > 0) {
    return "degraded";
  }
  return "stable";
}

function buildControlPlaneRequestPolicy(path: string, method: string): ControlPlaneRequestPolicy {
  const metrics = getControlPlaneNetworkMetricsSnapshot();
  const infraHealth = computeControlPlaneInfraHealth(metrics);
  const networkRegime = classifyControlPlaneNetworkRegime(metrics, infraHealth);
  let attempts = isRetryableMethod(method) ? controlPlaneRetryAttempts : 1;
  let baseDelayMs = controlPlaneRetryBaseDelayMs;
  let preflightDelayMs = 0;
  let retryJitterMs = 25;
  const routeFamily = toRouteFamily(path);
  const routeMetrics = metrics.route_families[routeFamily];
  const routeDegradedRatio = routeMetrics && routeMetrics.request_count > 0
    ? routeMetrics.degraded_count / routeMetrics.request_count
    : 0;

  if (networkRegime === "degraded") {
    attempts = Math.max(1, attempts - 1);
    baseDelayMs = Math.min(1800, Math.round(baseDelayMs * 1.8));
    preflightDelayMs = 25 + Math.round(Math.max(metrics.degraded_usage_ratio, routeDegradedRatio) * 160);
    retryJitterMs = 80;
  } else if (networkRegime === "critical") {
    attempts = 1;
    baseDelayMs = Math.min(2200, Math.round(baseDelayMs * 2.6));
    preflightDelayMs = 80 + Math.round(Math.max(metrics.timeout_rate, metrics.degraded_usage_ratio, routeDegradedRatio) * 240);
    retryJitterMs = 140;
  }

  return {
    attempts,
    baseDelayMs,
    preflightDelayMs,
    retryJitterMs,
    infraHealth,
    networkRegime,
  };
}

export function withControlPlaneNetwork(payload: unknown, network: ControlPlaneNetworkMeta, options: {
  includeMetrics?: boolean;
} = {}): Record<string, unknown> {
  const envelope: Record<string, unknown> = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>) }
    : { payload };

  if (options.includeMetrics !== false) {
    envelope.network_metrics = getControlPlaneNetworkMetricsSnapshot();
  }

  envelope.network = network;
  envelope.network_state = network.network_state;
  envelope.retry_count = network.retry_count;
  envelope.degraded_flag = network.degraded_flag;
  return envelope;
}

export function attachInfraAwareResponseHeaders(
  headers: Headers,
  network: ControlPlaneNetworkMeta,
  retryPolicy?: string,
): void {
  const metrics = getControlPlaneNetworkMetricsSnapshot();
  const infraHealth = computeControlPlaneInfraHealth(metrics);
  const networkRegime = classifyControlPlaneNetworkRegime(metrics, infraHealth);
  headers.set("x-mc-network-state", network.network_state);
  headers.set("x-mc-retry-count", String(network.retry_count));
  headers.set("x-mc-network-regime", networkRegime);
  headers.set("x-mc-infra-health", infraHealth.toFixed(4));
  headers.set("x-mc-failure-class", network.failure_classification);
  if (network.failure_detail) {
    headers.set("x-mc-failure-detail", network.failure_detail.slice(0, 256));
  }
  if (retryPolicy) {
    headers.set("x-mc-request-scheduler", retryPolicy);
  }
}

function extractFetchErrorParts(error: unknown): {
  code: string;
  hostname: string;
  syscall: string;
  message: string;
} {
  if (!(error instanceof Error)) {
    return {
      code: "",
      hostname: "",
      syscall: "",
      message: "unknown_error",
    };
  }

  const details = error as Error & {
    code?: string;
    errno?: number;
    syscall?: string;
    hostname?: string;
    cause?: {
      code?: string;
      errno?: number;
      syscall?: string;
      hostname?: string;
      message?: string;
    };
  };

  const cause = details.cause;
  return {
    code: String(cause?.code || details.code || "").trim(),
    hostname: String(cause?.hostname || details.hostname || "").trim(),
    syscall: String(cause?.syscall || details.syscall || "").trim(),
    message: String(cause?.message || details.message || "unknown_error").trim(),
  };
}

function classifyFetchError(error: unknown): ControlPlaneFailureDetails {
  const parts = extractFetchErrorParts(error);
  const haystack = [parts.code, parts.hostname, parts.syscall, parts.message].join(" ").toUpperCase();

  if (haystack.includes("EAI_AGAIN")) {
    return { ...parts, classification: "dns_transient", retryable: true };
  }
  if (haystack.includes("ENOTFOUND") || haystack.includes("ERR_NAME_NOT_RESOLVED")) {
    return { ...parts, classification: "dns_unresolved", retryable: false };
  }
  if (haystack.includes("ETIMEDOUT") || haystack.includes("UND_ERR_CONNECT_TIMEOUT") || haystack.includes("HEADERS_TIMEOUT")) {
    return { ...parts, classification: "timeout", retryable: true };
  }
  if (haystack.includes("ECONNREFUSED")) {
    return { ...parts, classification: "connection_refused", retryable: false };
  }
  if (haystack.includes("ECONNRESET") || haystack.includes("EPIPE") || haystack.includes("UND_ERR_SOCKET")) {
    return { ...parts, classification: "connection_reset", retryable: true };
  }
  if (haystack.includes("ABORT_ERR") || haystack.includes("ABORTED")) {
    return { ...parts, classification: "aborted", retryable: true };
  }
  if (haystack.includes("FETCH FAILED") || haystack.includes("NETWORK")) {
    return { ...parts, classification: "network_unknown", retryable: true };
  }

  return { ...parts, classification: "unknown_error", retryable: false };
}

function summarizeFetchError(error: unknown): string {
  const failure = classifyFetchError(error);
  const parts = [failure.classification, failure.code, failure.hostname, failure.syscall, failure.message].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "unknown_error";
}

function getRequestMethod(init: RequestInit): string {
  return String(init.method || "GET").toUpperCase();
}

function isRetryableMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function getRetryDelayMs(attemptIndex: number, policy: ControlPlaneRequestPolicy): number {
  const jitter = policy.retryJitterMs > 0 ? Math.floor(Math.random() * (policy.retryJitterMs + 1)) : 0;
  return Math.min(policy.baseDelayMs * (attemptIndex + 1) + jitter, 2500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryFetchFailure(
  method: string,
  failure: ControlPlaneFailureDetails,
  attemptIndex: number,
  policy: ControlPlaneRequestPolicy,
): boolean {
  return isRetryableMethod(method) && failure.retryable && attemptIndex + 1 < policy.attempts;
}

function toRouteFamily(path: string): string {
  const [rawPath] = String(path).split("?");
  const segments = rawPath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "/";
  }
  if (segments[0] !== "v1") {
    return `/${segments.slice(0, Math.min(2, segments.length)).join("/")}`;
  }
  if (segments.length === 1) {
    return "/v1";
  }
  if (segments.length === 2) {
    return `/v1/${segments[1]}`;
  }
  return `/v1/${segments[1]}/${segments[2]}/*`;
}

export async function getControlPlaneToken(): Promise<string> {
  let cookieToken = "";
  let compatCookieToken = "";
  try {
    const maybeCookies = cookies as unknown as (() => Promise<{ get?: (name: string) => { value?: string } | undefined }>) | undefined;
    const store = typeof maybeCookies === "function" ? await maybeCookies() : undefined;
    cookieToken = store?.get?.("mc_token")?.value || "";
    compatCookieToken = store?.get?.("mc_token_compat")?.value || "";
  } catch {
    cookieToken = "";
    compatCookieToken = "";
  }
  return cookieToken || compatCookieToken || fallbackToken;
}

export function getControlPlaneUrl(): string {
  return baseUrl;
}

function getControlPlaneUrlCandidates(): string[] {
  const candidates = [baseUrl.trim(), fallbackBaseUrl.trim()].filter(Boolean);
  const deduped: string[] = [];
  for (const candidate of candidates) {
    if (!deduped.includes(candidate)) {
      deduped.push(candidate);
    }
  }
  return deduped;
}

export function extractMcContextHeaders(request: Request): Headers {
  const forwarded = new Headers();
  const names = [
    "x-mc-request-type",
    "x-mc-priority",
    "x-mc-market-volatility",
    "x-mc-signal-state",
    "x-mc-symbol",
    "x-mc-origin",
  ];
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) {
      forwarded.set(name, value);
    }
  }
  return forwarded;
}

export async function cpFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getControlPlaneToken();
  const headers = new Headers(init.headers || {});
  const method = getRequestMethod(init);
  const requestPolicy = buildControlPlaneRequestPolicy(path, method);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let lastError: unknown;
  let lastFailure: ControlPlaneFailureDetails | null = null;
  let attemptedBaseUrls: string[] = [];
  const attemptedTargets: string[] = [];
  try {
    const candidates = getControlPlaneUrlCandidates();
    attemptedBaseUrls = candidates;
    if (requestPolicy.preflightDelayMs > 0 && isRetryableMethod(method)) {
      await sleep(requestPolicy.preflightDelayMs + Math.floor(Math.random() * (requestPolicy.retryJitterMs + 1)));
    }
    for (const candidate of candidates) {
      for (let attemptIndex = 0; attemptIndex < requestPolicy.attempts; attemptIndex += 1) {
        attemptedTargets.push(`${candidate}#${attemptIndex + 1}`);
        try {
          const response = await fetch(`${candidate}${path}`, {
            ...init,
            headers,
            cache: "no-store",
          });
          const responseHeaders = new Headers(response.headers);
          const retryCount = Math.max(0, attemptedTargets.length - 1);
          const networkState = attemptedTargets.length > 1 ? "retry_recovered" : "healthy";
          const networkMeta: ControlPlaneNetworkMeta = {
            network_state: networkState,
            retry_count: retryCount,
            degraded_flag: false,
            failure_classification: lastFailure?.classification || "none",
            failure_detail: lastFailure ? summarizeFetchError(lastError) : "",
            attempted_targets: [...attemptedTargets],
            attempted_base_urls: [...attemptedBaseUrls],
            upstream_status: response.status,
          };

          recordControlPlaneNetworkMetric(path, networkMeta);

          responseHeaders.set("x-mc-control-plane-retry-count", String(retryCount));
          responseHeaders.set("x-mc-control-plane-attempted-targets", attemptedTargets.join(","));
          responseHeaders.set("x-mc-control-plane-attempted-base-urls", attemptedBaseUrls.join(","));
          responseHeaders.set("x-mc-control-plane-failure-class", networkMeta.failure_classification);
          responseHeaders.set("x-mc-control-plane-failure-detail", networkMeta.failure_detail);
          responseHeaders.set("x-mc-control-plane-network-state", networkState);
          responseHeaders.set(
            "x-mc-control-plane-retry-policy",
            `${requestPolicy.networkRegime}:${requestPolicy.attempts}:${requestPolicy.baseDelayMs}:${requestPolicy.preflightDelayMs}`,
          );
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        } catch (error) {
          lastError = error;
          lastFailure = classifyFetchError(error);
          if (shouldRetryFetchFailure(method, lastFailure, attemptIndex, requestPolicy)) {
            if (!isControlPlaneDevNoiseSuppressed()) {
              console.info(
                `[mc:cp] retrying ${method} ${toRouteFamily(path)} after transient ${lastFailure.classification} via ${candidate} (${attemptIndex + 2}/${requestPolicy.attempts}) policy=${requestPolicy.networkRegime}/${requestPolicy.baseDelayMs}ms`,
              );
            }
            await sleep(getRetryDelayMs(attemptIndex, requestPolicy));
            continue;
          }
          break;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("control_plane_unreachable");
  } catch {
    const degradedNetworkMeta: ControlPlaneNetworkMeta = {
      network_state: "degraded",
      retry_count: Math.max(0, attemptedTargets.length - 1),
      degraded_flag: true,
      failure_classification: lastFailure?.classification || "unknown_error",
      failure_detail: summarizeFetchError(lastError),
      attempted_targets: [...attemptedTargets],
      attempted_base_urls: [...attemptedBaseUrls],
      upstream_status: 0,
    };

    recordControlPlaneNetworkMetric(path, degradedNetworkMeta);

    if (!isE2eDevDegradedModeEnabled()) {
      throw (lastError instanceof Error ? lastError : new Error("control_plane_unreachable"));
    }

    const family = toRouteFamily(path);
    const key = `${method} ${family}`;
    warnDegradedOnce(
      key,
      `[mc:e2e-dev] control-plane unavailable (${key}) [${summarizeFetchError(lastError)}] attempted=${attemptedTargets.join(",") || attemptedBaseUrls.join(",") || "none"} -> returning degraded 503 responses for this family`,
    );

    return new Response(
      JSON.stringify({
        detail: "control_plane_unreachable_e2e_dev",
        method,
        path,
        baseUrl,
        attempted_base_urls: attemptedBaseUrls,
        attempted_targets: attemptedTargets,
        retry_count: degradedNetworkMeta.retry_count,
        degraded_flag: degradedNetworkMeta.degraded_flag,
        network_state: degradedNetworkMeta.network_state,
        failure_classification: degradedNetworkMeta.failure_classification,
        failure_detail: degradedNetworkMeta.failure_detail,
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-mc-e2e-degraded": "1",
          "x-mc-control-plane-retry-count": String(degradedNetworkMeta.retry_count),
          "x-mc-control-plane-attempted-targets": attemptedTargets.join(","),
          "x-mc-control-plane-attempted-base-urls": attemptedBaseUrls.join(","),
          "x-mc-control-plane-failure-class": degradedNetworkMeta.failure_classification,
          "x-mc-control-plane-failure-detail": degradedNetworkMeta.failure_detail,
          "x-mc-control-plane-network-state": degradedNetworkMeta.network_state,
          "x-mc-control-plane-retry-policy": `${requestPolicy.networkRegime}:${requestPolicy.attempts}:${requestPolicy.baseDelayMs}:${requestPolicy.preflightDelayMs}`,
        },
      },
    );
  }
}

function parseHeaderList(value: string | null): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildControlPlaneNetworkMeta(response: Response, payload: unknown): ControlPlaneNetworkMeta {
  const payloadMap = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const headerRetryCount = Number.parseInt(response.headers.get("x-mc-control-plane-retry-count") || "", 10);
  const payloadRetryCount = toNumber(payloadMap?.retry_count, 0);
  const retryCount = Number.isFinite(headerRetryCount) ? Math.max(0, headerRetryCount) : Math.max(0, payloadRetryCount);
  const attemptedTargets = parseHeaderList(response.headers.get("x-mc-control-plane-attempted-targets"));
  const attemptedBaseUrls = parseHeaderList(response.headers.get("x-mc-control-plane-attempted-base-urls"));
  const failureClassification = String(
    response.headers.get("x-mc-control-plane-failure-class")
      || payloadMap?.failure_classification
      || "none",
  ) as ControlPlaneFailureClass | "none";
  const failureDetail = String(
    response.headers.get("x-mc-control-plane-failure-detail")
      || payloadMap?.failure_detail
      || "",
  );
  const degradedFlag =
    response.headers.get("x-mc-e2e-degraded") === "1"
    || Boolean(payloadMap?.degraded_flag)
    || String(payloadMap?.network_state || "") === "degraded";
  const networkStateHeader = String(response.headers.get("x-mc-control-plane-network-state") || "").trim();
  const networkState = (networkStateHeader || (degradedFlag ? "degraded" : retryCount > 0 ? "retry_recovered" : "healthy")) as ControlPlaneNetworkState;
  return {
    network_state: networkState,
    retry_count: retryCount,
    degraded_flag: degradedFlag,
    failure_classification: failureClassification,
    failure_detail: failureDetail,
    attempted_targets: attemptedTargets.length > 0 ? attemptedTargets : Array.isArray(payloadMap?.attempted_targets)
      ? (payloadMap?.attempted_targets as unknown[]).map((item) => String(item)).filter(Boolean)
      : [],
    attempted_base_urls: attemptedBaseUrls.length > 0 ? attemptedBaseUrls : Array.isArray(payloadMap?.attempted_base_urls)
      ? (payloadMap?.attempted_base_urls as unknown[]).map((item) => String(item)).filter(Boolean)
      : [],
    upstream_status: response.status,
  };
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export async function readJsonFromResponseSafe(response: Response): Promise<unknown> {
  const raw = await response.text().catch(() => "");
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {
      detail: "invalid_upstream_json",
      raw: raw.slice(0, 500),
    };
  }
}

export async function cpFetchJsonSafe(path: string, init: RequestInit = {}): Promise<{
  response: Response;
  payload: unknown;
  network: ControlPlaneNetworkMeta;
}> {
  const response = await cpFetch(path, init);
  const payload = await readJsonFromResponseSafe(response);
  const network = buildControlPlaneNetworkMeta(response, payload);
  return { response, payload, network };
}
