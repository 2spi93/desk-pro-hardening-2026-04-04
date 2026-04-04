import {
  classifyControlPlaneNetworkRegime,
  computeControlPlaneInfraHealth,
  getControlPlaneNetworkMetricsSnapshot,
  readJsonFromResponseSafe,
  type ControlPlaneNetworkMeta,
} from "./controlPlane";

const predictorBaseUrl = process.env.PREDICTOR_V8_URL || "http://predictor-v8:8008";
const predictorFallbackBaseUrl = process.env.PREDICTOR_V8_FALLBACK_URL || predictorBaseUrl;

type PredictorRequestOptions = {
  allowRetry?: boolean;
  routeKey?: string;
};

type PredictorRequestPolicy = {
  attempts: number;
  baseDelayMs: number;
  preflightDelayMs: number;
  retryJitterMs: number;
  retryPolicy: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getMethod(init: RequestInit): string {
  return String(init.method || "GET").toUpperCase();
}

function classifyFetchFailure(error: unknown): { classification: string; detail: string; retryable: boolean } {
  const detail = error instanceof Error ? error.message : "unknown_error";
  const haystack = detail.toUpperCase();
  if (haystack.includes("EAI_AGAIN")) {
    return { classification: "dns_transient", detail, retryable: true };
  }
  if (haystack.includes("ENOTFOUND") || haystack.includes("ERR_NAME_NOT_RESOLVED")) {
    return { classification: "dns_unresolved", detail, retryable: false };
  }
  if (haystack.includes("ETIMEDOUT") || haystack.includes("UND_ERR_CONNECT_TIMEOUT") || haystack.includes("HEADERS_TIMEOUT")) {
    return { classification: "timeout", detail, retryable: true };
  }
  if (haystack.includes("ECONNREFUSED")) {
    return { classification: "connection_refused", detail, retryable: false };
  }
  if (haystack.includes("ECONNRESET") || haystack.includes("UND_ERR_SOCKET") || haystack.includes("EPIPE")) {
    return { classification: "connection_reset", detail, retryable: true };
  }
  return { classification: "network_unknown", detail, retryable: true };
}

function buildPredictorRequestPolicy(method: string, allowRetry: boolean): PredictorRequestPolicy {
  const metrics = getControlPlaneNetworkMetricsSnapshot();
  const infraHealth = computeControlPlaneInfraHealth(metrics);
  const networkRegime = classifyControlPlaneNetworkRegime(metrics, infraHealth);
  let attempts = allowRetry ? 2 : 1;
  let baseDelayMs = 150;
  let preflightDelayMs = 0;
  let retryJitterMs = 25;

  if (networkRegime === "degraded") {
    attempts = Math.max(1, attempts - 1);
    baseDelayMs = 280;
    preflightDelayMs = 40 + Math.round(metrics.degraded_usage_ratio * 160);
    retryJitterMs = 80;
  } else if (networkRegime === "critical") {
    attempts = 1;
    baseDelayMs = 420;
    preflightDelayMs = 90 + Math.round(Math.max(metrics.timeout_rate, metrics.degraded_usage_ratio) * 220);
    retryJitterMs = 140;
  }

  return {
    attempts,
    baseDelayMs,
    preflightDelayMs,
    retryJitterMs,
    retryPolicy: `${networkRegime}:${method}:${attempts}:${baseDelayMs}:${preflightDelayMs}`,
  };
}

function getRetryDelay(attemptIndex: number, policy: PredictorRequestPolicy): number {
  const jitter = policy.retryJitterMs > 0 ? Math.floor(Math.random() * (policy.retryJitterMs + 1)) : 0;
  return Math.min(policy.baseDelayMs * (attemptIndex + 1) + jitter, 2500);
}

function buildBaseUrlCandidates(): string[] {
  const deduped: string[] = [];
  for (const candidate of [predictorBaseUrl.trim(), predictorFallbackBaseUrl.trim()]) {
    if (candidate && !deduped.includes(candidate)) {
      deduped.push(candidate);
    }
  }
  return deduped;
}

export async function predictorFetchJsonSafe(
  path: string,
  init: RequestInit = {},
  options: PredictorRequestOptions = {},
): Promise<{
  response: Response;
  payload: unknown;
  network: ControlPlaneNetworkMeta;
  retryPolicy: string;
}> {
  const method = getMethod(init);
  const policy = buildPredictorRequestPolicy(method, Boolean(options.allowRetry));
  const headers = new Headers(init.headers || {});
  const baseUrls = buildBaseUrlCandidates();
  const attemptedTargets: string[] = [];
  let lastFailure: { classification: string; detail: string; retryable: boolean } | null = null;
  let lastError: unknown;

  if (policy.preflightDelayMs > 0) {
    await sleep(policy.preflightDelayMs + Math.floor(Math.random() * (policy.retryJitterMs + 1)));
  }

  for (const baseUrl of baseUrls) {
    for (let attemptIndex = 0; attemptIndex < policy.attempts; attemptIndex += 1) {
      attemptedTargets.push(`${baseUrl}${path}#${attemptIndex + 1}`);
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          ...init,
          headers,
          cache: "no-store",
        });
        const payload = await readJsonFromResponseSafe(response);
        const network: ControlPlaneNetworkMeta = {
          network_state: attemptedTargets.length > 1 ? "retry_recovered" : "healthy",
          retry_count: Math.max(0, attemptedTargets.length - 1),
          degraded_flag: false,
          failure_classification: (lastFailure?.classification || "none") as ControlPlaneNetworkMeta["failure_classification"],
          failure_detail: lastFailure?.detail || "",
          attempted_targets: [...attemptedTargets],
          attempted_base_urls: [...baseUrls],
          upstream_status: response.status,
        };
        return { response, payload, network, retryPolicy: policy.retryPolicy };
      } catch (error) {
        lastError = error;
        lastFailure = classifyFetchFailure(error);
        if (lastFailure.retryable && attemptIndex + 1 < policy.attempts) {
          await sleep(getRetryDelay(attemptIndex, policy));
          continue;
        }
        break;
      }
    }
  }

  const payload = {
    detail: "predictor_unreachable",
    path,
    route_key: options.routeKey || path,
    attempted_targets: attemptedTargets,
    attempted_base_urls: baseUrls,
    failure_classification: lastFailure?.classification || "network_unknown",
    failure_detail: lastFailure?.detail || (lastError instanceof Error ? lastError.message : "predictor_unreachable"),
  };
  const response = new Response(JSON.stringify(payload), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  const network: ControlPlaneNetworkMeta = {
    network_state: "degraded",
    retry_count: Math.max(0, attemptedTargets.length - 1),
    degraded_flag: true,
    failure_classification: (lastFailure?.classification || "network_unknown") as ControlPlaneNetworkMeta["failure_classification"],
    failure_detail: lastFailure?.detail || (lastError instanceof Error ? lastError.message : "predictor_unreachable"),
    attempted_targets: attemptedTargets,
    attempted_base_urls: [...baseUrls],
    upstream_status: 503,
  };
  return { response, payload, network, retryPolicy: policy.retryPolicy };
}