import net from "node:net";

import { readHealthwatchDashboard } from "./healthwatchDashboard";
import { cpFetchJsonSafe } from "./controlPlane";
import {
  LEGACY_WATCHDOG_SUPERSESSION,
  type LegacyWatchdogSupersessionDeclaration,
} from "./legacyWatchdogSupersession";
import { buildRuntimeTruthSnapshot } from "./runtimeTruth";
import { buildTradeLifecycleHealthSnapshot } from "./tradeLifecycleHealth";

export type JsonMap = Record<string, unknown>;

export type ControlledLiveRampGateContext = "ci" | "ops";
export type ControlPlaneSourceContext = "docker_service_network" | "host_local" | "mission_control_gateway" | "configured_external" | "unknown";

export type LifecyclePublishGateReport = {
  publish_blocked?: boolean;
  block_reasons?: string[];
  terminal_decision_state_diagnostic?: unknown;
  execution_gap_diagnostic?: unknown;
};

export type ReplayCertificationArtifact = {
  aligned?: {
    certified_outcomes?: {
      required_total?: number;
      certified_total?: number;
      remaining_total?: number;
      ready?: boolean;
    };
    findings?: Array<Record<string, unknown>>;
  };
};

export type ControlledLiveRampGateReport = {
  schema_version: "controlled-live-ramp-gate/v2.0";
  generated_at_iso: string;
  context: ControlledLiveRampGateContext;
  controlled_live_ramp_gate: {
    mode: "blocked_by_observability" | "halted" | "probe" | "micro_live" | "reduced_live" | "normal_controlled";
    allowed: boolean;
    ops_verdict_available: boolean;
    ops_verdict_unavailable_reasons: string[];
    max_notional_multiplier: number;
    promotion_target: "micro_live" | "reduced_live" | "normal_controlled" | "certified_nominal";
    required_clean_cycles: number;
    current_clean_cycles: number;
    missing_runtime_truth_sources: string[];
    degraded_runtime_truth_sources: string[];
    // Backend execution-router observation is the authority for the live edge,
    // not the fragile browser terminal capture. When live_observation is online,
    // capture-derived degraded sources (NO_EDGE / live_state / decision_quote_coverage)
    // are reclassified here as non-blocking instead of blocking the gate.
    observation_source: "execution_router" | "terminal_capture" | "unknown";
    ui_capture_status: "ok" | "degraded" | "unknown";
    ui_capture_blocks_live: boolean;
    ui_capture_degraded_sources: string[];
    backend_bus_seq: number | null;
    backend_flags: string[];
    kill_switch: {
      active: boolean | null;
      reason: string | null;
      last_transition: string | null;
      reset_eligible: boolean;
      reset_blockers: string[];
    };
    block_reasons: string[];
    yellow_flags: string[];
  };
  lifecycle_publish_gate: {
    publish_blocked: boolean;
    block_reasons: string[];
  };
  terminal_decision_state_diagnostic: JsonMap;
  execution_gap_diagnostic: JsonMap;
  runtime_truth_gate: {
    available: boolean;
    verdict: string;
    summary: string;
    kill_switch_active: boolean | null;
    blockers: string[];
    degraded_reasons: string[];
  };
  replay_certification_gate: {
    available: boolean;
    ready: boolean | null;
    certified_total: number | null;
    required_total: number | null;
    remaining_total: number | null;
    blockers: string[];
  };
  gateway_public_health: {
    available: boolean;
    healthy: boolean | null;
    mode: "external_probe" | "healthwatch_dashboard" | "unavailable";
    summary: string;
    checked_url: string | null;
  };
  public_probe: {
    available: boolean;
    required: boolean;
    status: "pass" | "fail" | "skipped";
    url: string | null;
    expected: string;
    observed: string;
    summary: string;
  };
  auth_probe: {
    available: boolean;
    required: boolean;
    status: "pass" | "fail" | "not_run" | "not_authorized" | "schema_not_verified" | "skipped";
    url: string | null;
    method: "cookie" | "service_to_service" | "unauthenticated" | "skipped";
    expected: string;
    observed: string | null;
    summary: string;
    expected_schema: string[];
    missing_fields: string[];
    schema_verified: boolean;
    token_exposed: false;
  };
  settlement_truth: {
    status: "available" | "empty_but_valid" | "stale" | "missing_contract" | "missing_source" | "join_failed" | "source_unreachable" | "missing" | "degraded" | "skipped";
    source: string | null;
    last_seen_at: string | null;
    expected_contract: "settlement-truth/v1";
    blocking: boolean;
    repair_hint: string | null;
  };
  settlement_source_context_diff: {
    schema_version: "settlement-source-context-diff/v1";
    expected_url: string;
    resolved_url: string | null;
    http_status: number | null;
    schema_version_observed: string | null;
    status: string | null;
    context: ControlledLiveRampGateContext;
    source_context: ControlPlaneSourceContext;
    missing_source_reason: string | null;
    ops_context_allowed: boolean;
    repair_hint: string | null;
  };
  ops_runner_context: {
    schema_version: "ops-runner-context/v1";
    valid: boolean;
    network_context: ControlPlaneSourceContext;
    control_plane_url: string;
    required_control_plane_url_present: boolean;
    host_local_allowed: boolean;
    runner_service: string | null;
    repair_hint: string | null;
  };
  bus_health: {
    schema_version: "bus-health/v1";
    status: "online" | "offline" | "degraded" | "unverified" | "skipped";
    verified: boolean;
    observer: "scanner" | "control_plane" | "mission_control" | "ci";
    source_context: ControlPlaneSourceContext;
    checked_url: string | null;
    http_status: number | null;
    last_seen_at: string | null;
    last_event_at: string | null;
    event_lag_ms: number | null;
    publisher_status: string;
    consumer_status: string;
    publisher: {
      status: "online" | "stale" | "unknown";
      stream: string | null;
      producer_id: string | null;
      last_heartbeat_at: string | null;
      last_event_id: string | null;
      event_lag_ms: number | null;
    };
    live_observation: {
      status: "online" | "degraded" | "unavailable" | "unknown";
      source: string | null;
      opportunity_gate_status: string | null;
      valid_observation: boolean | null;
      bus_seq: number | null;
      updated_at: string | null;
      freshness_ms: number | null;
      flags: string[];
    };
    consumer: {
      status: "online" | "stale" | "unknown" | "unavailable" | "not_required";
      source: string | null;
      last_read_at: string | null;
      reason: string | null;
    };
    transport: {
      status: "online" | "offline" | "unknown";
      kind: "redis_stream" | "unknown";
      url: string | null;
      ping_ms: number | null;
      streams_checked: string[];
      streams: Array<{
        name: string;
        length: number | null;
        groups: number | null;
        last_generated_id: string | null;
        error: string | null;
      }>;
      errors: string[];
    };
    repair_hint: string | null;
  };
  legacy_watchdog_reconciliation: {
    schema_version: "legacy-watchdog-reconciliation/v2";
    stream: "txt.watchdog";
    expected_publisher: string | null;
    writer_process_detected: boolean | null;
    publisher_last_seen_at: string | null;
    redis_stream_status: "fresh" | "stale" | "missing" | "unreachable" | "unknown";
    redis_groups: number | null;
    redis_last_generated_id: string | null;
    live_observation_status: "online" | "degraded" | "unavailable" | "unknown";
    consumer_mode: "consumer_group_present" | "no_consumer_group_configured" | "unknown";
    reconciliation_mode: "required" | "superseded" | "not_required";
    decision: "recover_legacy_publisher_or_formally_supersede" | "legacy_publisher_recovered" | "formally_superseded_by_live_observation" | "redis_transport_unreachable";
    supersession: {
      schema_version: LegacyWatchdogSupersessionDeclaration["schema_version"];
      declared: boolean;
      superseded_by: string;
      declared_at: string;
      declared_by: string;
      reason: string;
      effective: boolean;
      ineffective_reasons: string[];
    } | null;
    blocks_reset: boolean;
    repair_hint: string | null;
  };
  runtime_truth_matrix: {
    status: "available" | "degraded" | "missing" | "skipped";
    coverage: {
      required: number;
      available: number;
      missing: string[];
    };
    summary: string;
  };
  runtime_source_degradation_map: {
    schema_version: "runtime-source-degradation-map/v1";
    sources: Array<{
      name: string;
      status: "available" | "degraded" | "missing" | "not_authorized" | "schema_not_verified" | "skipped";
      detail_status: string | null;
      degradation_reasons: string[];
      freshness: {
        last_seen_at: string | null;
        freshness_ms: number | null;
        expected_max_staleness_ms: number | null;
        stale: boolean | null;
      };
      blocking: boolean;
      repair_hint: string | null;
    }>;
  };
  new_cycle_cleanliness: {
    available: boolean;
    clean_cycles: number;
    required_for_next_promotion: number;
    stable_review_required_total: boolean | null;
    summary: string;
  };
};

export type ControlledLiveRampGateBuildInput = {
  context: ControlledLiveRampGateContext;
  sinceDays?: number;
  lifecycleReport?: LifecyclePublishGateReport | null;
  replayArtifact?: ReplayCertificationArtifact | null;
  runtimeTruth?: unknown;
  publicUrl?: string;
  authProbeUrl?: string;
  authMode?: "auto" | "cookie" | "service";
  authCookie?: string;
  authToken?: string;
  currentCleanCycles?: number;
  reviewRequiredBaseline?: number | null;
  generatedAtIso?: string;
};

type SettlementDirectProbe = Awaited<ReturnType<typeof cpFetchJsonSafe>>;

type RedisStreamEntry = {
  stream: string;
  id: string | null;
  fields: JsonMap;
};

type RedisStreamInfo = {
  name: string;
  length: number | null;
  groups: number | null;
  last_generated_id: string | null;
  error: string | null;
};

type RedisBusProbe = {
  transport_status: "online" | "offline" | "unknown";
  url: string | null;
  ping_ms: number | null;
  streams_checked: string[];
  stream_info: RedisStreamInfo[];
  errors: string[];
  entries: RedisStreamEntry[];
  latest_entry: RedisStreamEntry | null;
};

export function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

export function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeControlledLiveRampGateContext(value: unknown): ControlledLiveRampGateContext {
  return String(value || "").trim().toLowerCase() === "ci" ? "ci" : "ops";
}

const AUTH_PROBE_EXPECTED_SCHEMA = [
  "controlled_live_ramp_gate",
  "controlled_live_ramp_gate.controlled_live_ramp_gate",
  "controlled_live_ramp_gate.lifecycle_publish_gate",
  "controlled_live_ramp_gate.terminal_decision_state_diagnostic",
  "controlled_live_ramp_gate.execution_gap_diagnostic",
];

export function buildLifecyclePublishGateReportFromSnapshot(snapshot: unknown): LifecyclePublishGateReport {
  const lifecycleSnapshot = asRecord(snapshot);
  const terminalDecisionStateDiagnostic = asRecord(lifecycleSnapshot.terminal_decision_state_diagnostic);
  const executionGapDiagnostic = asRecord(lifecycleSnapshot.execution_gap_diagnostic);
  const blockedFamilyBreakdown = Array.isArray(executionGapDiagnostic.blocked_family_breakdown)
    ? executionGapDiagnostic.blocked_family_breakdown as Array<Record<string, unknown>>
    : [];

  return {
    publish_blocked: Boolean(terminalDecisionStateDiagnostic.publish_blocked)
      || toNumber(executionGapDiagnostic.blocked_decision_total, 0) > 0,
    block_reasons: [
      ...asStringArray(terminalDecisionStateDiagnostic.publish_block_reasons),
      ...blockedFamilyBreakdown.flatMap((entry) => {
        const familyKey = String(entry.family_key || "").trim();
        const decisionTotal = toNumber(entry.decision_total, 0);
        return familyKey && decisionTotal > 0 ? [`execution_gap:${familyKey}:${decisionTotal}`] : [];
      }),
    ],
    terminal_decision_state_diagnostic: terminalDecisionStateDiagnostic,
    execution_gap_diagnostic: executionGapDiagnostic,
  };
}

export function resolveControlledLiveRampStage(currentCleanCycles: number): {
  mode: ControlledLiveRampGateReport["controlled_live_ramp_gate"]["mode"];
  maxNotionalMultiplier: number;
  promotionTarget: ControlledLiveRampGateReport["controlled_live_ramp_gate"]["promotion_target"];
  requiredCleanCycles: number;
} {
  if (currentCleanCycles >= 50) {
    return { mode: "normal_controlled", maxNotionalMultiplier: 1, promotionTarget: "certified_nominal", requiredCleanCycles: 100 };
  }
  if (currentCleanCycles >= 25) {
    return { mode: "normal_controlled", maxNotionalMultiplier: 0.5, promotionTarget: "certified_nominal", requiredCleanCycles: 50 };
  }
  if (currentCleanCycles >= 10) {
    return { mode: "reduced_live", maxNotionalMultiplier: 0.25, promotionTarget: "normal_controlled", requiredCleanCycles: 25 };
  }
  if (currentCleanCycles >= 3) {
    return { mode: "micro_live", maxNotionalMultiplier: 0.1, promotionTarget: "reduced_live", requiredCleanCycles: 10 };
  }
  return { mode: "probe", maxNotionalMultiplier: 0.02, promotionTarget: "micro_live", requiredCleanCycles: 3 };
}

async function probeExternalUrl(url: string): Promise<{ healthy: boolean; summary: string; statusCode: number; location: string | null; contentType: string | null }> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { "user-agent": "mission-control-controlled-live-ramp-gate/1.0" },
  });

  const location = response.headers.get("location");
  const contentType = response.headers.get("content-type");
  return {
    healthy: response.status < 500,
    summary: `${response.status}${location ? ` -> ${location}` : ""}`,
    statusCode: response.status,
    location,
    contentType,
  };
}

async function loadLifecycleReportFromRuntime(sinceDays: number): Promise<LifecyclePublishGateReport> {
  const snapshot = await buildTradeLifecycleHealthSnapshot({ sinceDays });
  return buildLifecyclePublishGateReportFromSnapshot(snapshot);
}

function buildRuntimeTruthGate(runtimeTruth: unknown): ControlledLiveRampGateReport["runtime_truth_gate"] {
  const runtimeTruthRecord = asRecord(runtimeTruth);
  const health = asRecord(asRecord(runtimeTruthRecord.layers).health);
  return {
    available: Object.keys(runtimeTruthRecord).length > 0,
    verdict: String(runtimeTruthRecord.verdict || "UNAVAILABLE").trim().toUpperCase() || "UNAVAILABLE",
    summary: String(runtimeTruthRecord.summary || "runtime truth available").trim() || "runtime truth available",
    kill_switch_active: typeof health.kill_switch_active === "boolean" ? Boolean(health.kill_switch_active) : null,
    blockers: asStringArray(runtimeTruthRecord.blockers),
    degraded_reasons: asStringArray(runtimeTruthRecord.degraded_reasons),
  };
}

async function resolveRuntimeTruthGate(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
): Promise<ControlledLiveRampGateReport["runtime_truth_gate"]> {
  if (context !== "ops") {
    return {
      available: false,
      verdict: "UNAVAILABLE",
      summary: "runtime truth skipped in ci context",
      kill_switch_active: null,
      blockers: [],
      degraded_reasons: [],
    };
  }
  if (runtimeTruth) {
    return buildRuntimeTruthGate(runtimeTruth);
  }

  try {
    return buildRuntimeTruthGate(await buildRuntimeTruthSnapshot());
  } catch (error) {
    return {
      available: false,
      verdict: "UNAVAILABLE",
      summary: error instanceof Error ? error.message : String(error || "runtime truth unavailable"),
      kill_switch_active: null,
      blockers: [],
      degraded_reasons: [],
    };
  }
}

async function resolveRuntimeTruth(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
): Promise<{ gate: ControlledLiveRampGateReport["runtime_truth_gate"]; snapshot: unknown }> {
  if (context !== "ops") {
    return {
      gate: {
        available: false,
        verdict: "UNAVAILABLE",
        summary: "runtime truth skipped in ci context",
        kill_switch_active: null,
        blockers: [],
        degraded_reasons: [],
      },
      snapshot: null,
    };
  }
  if (runtimeTruth) {
    return { gate: buildRuntimeTruthGate(runtimeTruth), snapshot: runtimeTruth };
  }

  try {
    const snapshot = await buildRuntimeTruthSnapshot();
    return { gate: buildRuntimeTruthGate(snapshot), snapshot };
  } catch (error) {
    return {
      gate: {
        available: false,
        verdict: "UNAVAILABLE",
        summary: error instanceof Error ? error.message : String(error || "runtime truth unavailable"),
        kill_switch_active: null,
        blockers: [],
        degraded_reasons: [],
      },
      snapshot: null,
    };
  }
}

function buildReplayGate(replayArtifact: ReplayCertificationArtifact | null | undefined): ControlledLiveRampGateReport["replay_certification_gate"] {
  const replayAligned = asRecord(replayArtifact?.aligned);
  const replayCertifiedOutcomes = asRecord(replayAligned.certified_outcomes);
  const replayFindings = Array.isArray(replayAligned.findings)
    ? replayAligned.findings.map((finding) => String(asRecord(finding).code || "").trim()).filter(Boolean)
    : [];

  return {
    available: Boolean(replayArtifact),
    ready: replayArtifact ? Boolean(replayCertifiedOutcomes.ready) : null,
    certified_total: replayArtifact ? toNumber(replayCertifiedOutcomes.certified_total, 0) : null,
    required_total: replayArtifact ? toNumber(replayCertifiedOutcomes.required_total, 0) : null,
    remaining_total: replayArtifact ? toNumber(replayCertifiedOutcomes.remaining_total, 0) : null,
    blockers: replayFindings,
  };
}

async function resolveGatewayPublicHealth(
  context: ControlledLiveRampGateContext,
  publicUrl: string,
): Promise<ControlledLiveRampGateReport["gateway_public_health"]> {
  const base: ControlledLiveRampGateReport["gateway_public_health"] = {
    available: false,
    healthy: null,
    mode: "unavailable",
    summary: context === "ci" ? "public probe skipped in ci context" : "public probe unavailable",
    checked_url: publicUrl || null,
  };

  if (context !== "ops") {
    return base;
  }
  if (publicUrl) {
    try {
      const probe = await probeExternalUrl(publicUrl);
      return { available: true, healthy: probe.healthy, mode: "external_probe", summary: probe.summary, checked_url: publicUrl };
    } catch (error) {
      return {
        available: true,
        healthy: false,
        mode: "external_probe",
        summary: error instanceof Error ? error.message : String(error || "external probe failed"),
        checked_url: publicUrl,
      };
    }
  }

  try {
    const dashboard = await readHealthwatchDashboard();
    const publicChartVisibility = asRecord(asRecord(dashboard || {}).public_chart_visibility);
    const chartVisible = typeof publicChartVisibility.visible === "boolean" ? Boolean(publicChartVisibility.visible) : null;
    return {
      available: Boolean(dashboard),
      healthy: chartVisible,
      mode: "healthwatch_dashboard",
      summary: dashboard
        ? String(publicChartVisibility.summary || publicChartVisibility.status || "public chart visibility observed").trim() || "public chart visibility observed"
        : "healthwatch dashboard unavailable",
      checked_url: null,
    };
  } catch (error) {
    return { ...base, summary: error instanceof Error ? error.message : String(error || "public health unavailable") };
  }
}

async function resolvePublicProbe(
  context: ControlledLiveRampGateContext,
  publicUrl: string,
): Promise<ControlledLiveRampGateReport["public_probe"]> {
  const required = context === "ops";
  if (context !== "ops") {
    return {
      available: false,
      required,
      status: "skipped",
      url: publicUrl || null,
      expected: "skipped_in_ci",
      observed: "skipped_in_ci",
      summary: "public probe skipped in ci context",
    };
  }
  if (!publicUrl) {
    return {
      available: false,
      required,
      status: "fail",
      url: null,
      expected: "public_url_required_in_ops",
      observed: "missing_url",
      summary: "CONTROLLED_LIVE_GATE_PUBLIC_URL is required in ops context",
    };
  }
  try {
    const probe = await probeExternalUrl(publicUrl);
    const pass = probe.statusCode < 500;
    return {
      available: true,
      required,
      status: pass ? "pass" : "fail",
      url: publicUrl,
      expected: "http_status_below_500",
      observed: probe.summary,
      summary: pass ? `public route reachable: ${probe.summary}` : `public route failed: ${probe.summary}`,
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error || "public probe failed");
    return {
      available: true,
      required,
      status: "fail",
      url: publicUrl,
      expected: "http_status_below_500",
      observed: summary,
      summary,
    };
  }
}

async function resolveAuthProbe(
  context: ControlledLiveRampGateContext,
  authProbeUrl: string,
  authMode: "auto" | "cookie" | "service",
  authCookie: string,
  authToken: string,
): Promise<ControlledLiveRampGateReport["auth_probe"]> {
  if (context !== "ops") {
    return {
      available: false,
      required: false,
      status: "skipped",
      url: authProbeUrl || null,
      method: "skipped",
      expected: "skipped_in_ci",
      observed: "skipped_in_ci",
      summary: "auth probe skipped in ci context",
      expected_schema: AUTH_PROBE_EXPECTED_SCHEMA,
      missing_fields: [],
      schema_verified: false,
      token_exposed: false,
    };
  }
  if (!authProbeUrl) {
    return {
      available: false,
      required: false,
      status: "not_run",
      url: null,
      method: "unauthenticated",
      expected: "200_json_with_controlled_live_ramp_gate",
      observed: null,
      summary: "auth probe not configured",
      expected_schema: AUTH_PROBE_EXPECTED_SCHEMA,
      missing_fields: [],
      schema_verified: false,
      token_exposed: false,
    };
  }

  try {
    const headers: Record<string, string> = { "user-agent": "mission-control-controlled-live-ramp-gate/1.0", accept: "application/json" };
    const method = authMode === "service"
      ? "service_to_service"
      : authCookie
        ? "cookie"
        : "unauthenticated";
    if (authMode === "service" && authToken) {
      headers.authorization = `Bearer ${authToken}`;
    } else if (authCookie) {
      headers.cookie = authCookie;
    }
    const response = await fetch(authProbeUrl, {
      method: "GET",
      redirect: "manual",
      headers,
    });
    const location = response.headers.get("location");
    const contentType = response.headers.get("content-type");
    const observed = `${response.status}${location ? ` -> ${location}` : ""}${contentType ? ` content-type=${contentType}` : ""}`;
    const expectsJson = String(contentType || "").toLowerCase().includes("application/json");
    let missingFields = [...AUTH_PROBE_EXPECTED_SCHEMA];
    if (expectsJson) {
      try {
        const payload = await response.json();
        const payloadRecord = asRecord(payload);
        missingFields = AUTH_PROBE_EXPECTED_SCHEMA.filter((field) => !hasPath(payloadRecord, field));
      } catch {
        missingFields = [...AUTH_PROBE_EXPECTED_SCHEMA];
      }
    }
    const notAuthorized = response.status === 401 || response.status === 403;
    const schemaNotVerified = response.status === 200 && expectsJson && missingFields.length > 0;
    const pass = response.status === 200 && expectsJson && missingFields.length === 0;
    return {
      available: true,
      required: false,
      status: pass ? "pass" : notAuthorized ? "not_authorized" : schemaNotVerified ? "schema_not_verified" : "fail",
      url: authProbeUrl,
      method,
      expected: "200_json_with_controlled_live_ramp_gate",
      observed,
      summary: pass
        ? "authenticated operator endpoint returned expected JSON schema"
        : notAuthorized
          ? "authenticated operator endpoint rejected unauthenticated probe; schema not verified"
        : missingFields.length > 0
          ? `authenticated operator endpoint missing fields: ${missingFields.join(", ")}`
          : "authenticated operator endpoint did not return expected JSON",
      expected_schema: AUTH_PROBE_EXPECTED_SCHEMA,
      missing_fields: missingFields,
      schema_verified: pass,
      token_exposed: false,
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error || "auth probe failed");
    return {
      available: true,
      required: false,
      status: "fail",
      url: authProbeUrl,
      method: authMode === "service" ? "service_to_service" : authCookie ? "cookie" : "unauthenticated",
      expected: "200_json_with_controlled_live_ramp_gate",
      observed: summary,
      summary,
      expected_schema: AUTH_PROBE_EXPECTED_SCHEMA,
      missing_fields: AUTH_PROBE_EXPECTED_SCHEMA,
      schema_verified: false,
      token_exposed: false,
    };
  }
}

function hasKeys(value: JsonMap): boolean {
  return Object.keys(value).length > 0;
}

function dedupe(values: Array<unknown>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function hasPath(root: JsonMap, path: string): boolean {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    const record = asRecord(cursor);
    if (!(segment in record)) {
      return false;
    }
    cursor = record[segment];
  }
  return cursor !== undefined && cursor !== null;
}

function networkEntryIsDegraded(value: unknown): boolean {
  const entry = asRecord(value);
  const status = String(entry.status || entry.health || "").trim().toLowerCase();
  return Boolean(entry.degraded_flag)
    || Boolean(entry.partial_data)
    || status === "degraded"
    || status === "partial"
    || status === "unavailable"
    || status === "error";
}

export function buildRuntimeTruthSourceDiagnostics(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
  runtimeTruthGate: ControlledLiveRampGateReport["runtime_truth_gate"],
  settlementTruth: ControlledLiveRampGateReport["settlement_truth"],
): Pick<
  ControlledLiveRampGateReport["controlled_live_ramp_gate"],
  | "missing_runtime_truth_sources"
  | "degraded_runtime_truth_sources"
  | "observation_source"
  | "ui_capture_status"
  | "ui_capture_blocks_live"
  | "ui_capture_degraded_sources"
  | "backend_bus_seq"
  | "backend_flags"
> {
  if (context !== "ops") {
    return {
      missing_runtime_truth_sources: [],
      degraded_runtime_truth_sources: [],
      observation_source: "unknown",
      ui_capture_status: "unknown",
      ui_capture_blocks_live: false,
      ui_capture_degraded_sources: [],
      backend_bus_seq: null,
      backend_flags: [],
    };
  }

  const runtimeTruthRecord = asRecord(runtimeTruth);
  const layers = asRecord(runtimeTruthRecord.layers);
  const raw = asRecord(runtimeTruthRecord.raw);
  const network = asRecord(raw.network);
  const missing: string[] = [];
  const degraded: string[] = [];

  if (!runtimeTruthGate.available || Object.keys(runtimeTruthRecord).length === 0) {
    missing.push("runtime_truth_matrix");
  }
  if (!hasKeys(asRecord(layers.health))) {
    missing.push("control_plane_health");
  }
  if (!hasKeys(asRecord(layers.execution))) {
    missing.push("execution_truth");
  }
  if (!hasKeys(asRecord(layers.broker_reality))) {
    missing.push("position_truth");
  }
  if (["missing", "missing_source", "source_unreachable"].includes(settlementTruth.status)) {
    missing.push("settlement_truth");
  }
  if (["degraded", "stale", "missing_contract", "join_failed"].includes(settlementTruth.status)) {
    degraded.push("settlement_truth");
  }
  if (!hasKeys(asRecord(raw.runtime_decision))) {
    missing.push("decision_truth");
  }
  if (!hasKeys(asRecord(raw.controlled_collection))) {
    missing.push("controlled_collection_truth");
  }
  if (!hasKeys(asRecord(raw.edge_evidence))) {
    missing.push("edge_evidence_truth");
  }
  if (runtimeTruthGate.verdict === "BLOCKED" && runtimeTruthGate.blockers.some((reason) => reason !== "kill_switch_active")) {
    degraded.push("runtime_truth_matrix");
  }
  if (runtimeTruthGate.blockers.some((reason) => reason.includes("BLOCKED_BY_DATA") || reason.includes("NO_DATA_PARTIAL"))) {
    degraded.push("control_plane");
  }
  if (runtimeTruthGate.degraded_reasons.some((reason) => reason.includes("NO_EDGE"))) {
    degraded.push("edge_evidence_truth");
  }
  if (runtimeTruthGate.degraded_reasons.some((reason) => reason.includes("controlled_collection"))) {
    degraded.push("controlled_collection_truth");
  }
  if (runtimeTruthGate.blockers.some((reason) => reason.startsWith("runtime_reliability:") || reason.startsWith("live_state:"))) {
    degraded.push("runtime_reliability_live_state");
  }
  if (runtimeTruthGate.degraded_reasons.some((reason) => reason.startsWith("runtime_reliability:") || reason.startsWith("live_state:"))) {
    degraded.push("runtime_reliability_live_state");
  }
  if (Boolean(runtimeTruthRecord.partial_data)) {
    degraded.push("runtime_truth_matrix");
  }
  if (runtimeTruthGate.degraded_reasons.length > 0) {
    degraded.push("runtime_truth_matrix");
  }
  if (Object.values(network).some(networkEntryIsDegraded)) {
    degraded.push("control_plane");
  }
  if (networkEntryIsDegraded(network.execution_telemetry_recent) || networkEntryIsDegraded(network.execution_reality_gap_recent)) {
    degraded.push("execution_truth");
  }
  if (networkEntryIsDegraded(network.kill_switch) || networkEntryIsDegraded(network.system_config) || networkEntryIsDegraded(network.opportunity_gate)) {
    degraded.push("control_plane");
  }

  // --- Backend authority over the fragile browser terminal capture ---
  // The execution-router observation (surfaced as raw.opportunity_gate) is the
  // canonical truth for the live edge. A headless browser terminal WebSocket
  // can be CLOSED/throttled and emit bus_seq=0 / NO_EDGE while the backend bus
  // is perfectly healthy. So when live_observation is online, capture-derived
  // degraded sources are reclassified as non-blocking ui_capture_degraded.
  const rawOpportunityGate = asRecord(raw.opportunity_gate);
  const opportunityGate = asRecord(rawOpportunityGate.gate || rawOpportunityGate);
  const opportunityMetrics = asRecord(opportunityGate.metrics);
  const routing = asRecord(layers.routing);
  const opportunityStatus = String(opportunityGate.status || routing.status || "").trim().toLowerCase();
  const opportunityValidObservation = typeof opportunityGate.valid_observation === "boolean"
    ? Boolean(opportunityGate.valid_observation)
    : null;
  const backendBusSeq = Number.isFinite(Number(opportunityMetrics.bus_seq)) ? Number(opportunityMetrics.bus_seq) : null;
  const backendFlags = asStringArray(opportunityMetrics.flags).map((item) => item.toUpperCase());
  // Identical predicate to buildBusHealthDiagnostic's liveObservationOnline.
  const liveObservationOnline = opportunityStatus === "go"
    && opportunityValidObservation !== false
    && backendBusSeq !== null
    && backendBusSeq > 0
    && !backendFlags.includes("BUS_OFFLINE")
    && !backendFlags.includes("OBSERVATION_ERROR");

  // Degraded SOURCES that originate from the terminal capture / opportunity-edge
  // signal (NO_EDGE, live_state, runtime_reliability, controlled_collection).
  // settlement_truth, control_plane, execution_truth, position/broker truth stay
  // blocking regardless — they are backend execution truth, not UI capture.
  const captureOriginSources = new Set([
    "edge_evidence_truth",
    "runtime_reliability_live_state",
    "controlled_collection_truth",
  ]);
  const isCaptureReason = (reason: string): boolean =>
    /no_edge|live_state|runtime_reliability|decision_quote_coverage|controlled_collection|edge/i.test(reason);
  // runtime_truth_matrix is only capture-origin when ALL of its degraded_reasons
  // are capture-derived; a genuine non-capture degraded reason keeps it blocking.
  const hasNonCaptureDegradedReason = runtimeTruthGate.degraded_reasons.some((reason) => !isCaptureReason(reason));

  const uiCaptureDegraded: string[] = [];
  let blockingDegraded = dedupe(degraded);
  if (liveObservationOnline) {
    blockingDegraded = blockingDegraded.filter((source) => {
      if (captureOriginSources.has(source)) {
        uiCaptureDegraded.push(source);
        return false;
      }
      if (source === "runtime_truth_matrix" && !hasNonCaptureDegradedReason) {
        uiCaptureDegraded.push(source);
        return false;
      }
      return true;
    });
  }

  return {
    missing_runtime_truth_sources: dedupe(missing),
    degraded_runtime_truth_sources: blockingDegraded,
    observation_source: liveObservationOnline ? "execution_router" : "terminal_capture",
    ui_capture_status: uiCaptureDegraded.length > 0 ? "degraded" : "ok",
    ui_capture_blocks_live: false,
    ui_capture_degraded_sources: dedupe(uiCaptureDegraded),
    backend_bus_seq: backendBusSeq,
    backend_flags: backendFlags,
  };
}

function buildKillSwitchDiagnostics(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
  runtimeTruthGate: ControlledLiveRampGateReport["runtime_truth_gate"],
  missingRuntimeTruthSources: string[],
  degradedRuntimeTruthSources: string[],
  lifecyclePublishBlocked: boolean,
  activeDebtTotal: number,
  executionGapDiagnostic: JsonMap,
  publicProbe: ControlledLiveRampGateReport["public_probe"],
  replayGate: ControlledLiveRampGateReport["replay_certification_gate"],
  busHealthVerified: boolean,
): ControlledLiveRampGateReport["controlled_live_ramp_gate"]["kill_switch"] {
  if (context !== "ops") {
    return { active: null, reason: null, last_transition: null, reset_eligible: false, reset_blockers: [] };
  }

  const runtimeTruthRecord = asRecord(runtimeTruth);
  const health = asRecord(asRecord(runtimeTruthRecord.layers).health);
  const killSwitchEnvelope = asRecord(asRecord(runtimeTruthRecord.raw).kill_switch);
  const killSwitchState = asRecord(killSwitchEnvelope.state);
  const active = runtimeTruthGate.kill_switch_active === null
    ? typeof killSwitchState.active === "boolean" ? Boolean(killSwitchState.active) : null
    : runtimeTruthGate.kill_switch_active;
  const reason = String(health.kill_switch_reason || killSwitchState.reason || "").trim() || null;
  const lastTransition = String(killSwitchState.activated_at || killSwitchState.updated_at || killSwitchState.last_transition || "").trim() || null;
  const blockedDecisionTotal = toNumber(executionGapDiagnostic.blocked_decision_total, 0);
  // Reset eligibility asks "is it safe to unlatch?", so conditions that are
  // pure consequences of the latch itself must not veto it: the latch makes
  // the runtime truth verdict BLOCKED and keeps controlled collection stale
  // by design, which would otherwise deadlock the reset forever.
  const nonLatchRuntimeTruthBlockers = runtimeTruthGate.blockers.filter((item) => item !== "kill_switch_active");
  const runtimeTruthReadyForReset = runtimeTruthGate.available
    && (runtimeTruthGate.verdict === "READY" || nonLatchRuntimeTruthBlockers.length === 0);
  // While latched: edge_evidence_truth measures opportunity quality (NO_EDGE
  // on an empty halted window), runtime_reliability_live_state is demoted to
  // degradation by design (a halted system cannot accumulate observation
  // hours), and runtime_truth_matrix is a derivative aggregate of the other
  // sources' degradations. None of them measures unlatch safety; primary
  // sources (control_plane, execution_truth, settlement, position, decision)
  // keep their individual veto.
  const haltInducedDegradedSources = new Set(
    Boolean(active)
      ? ["controlled_collection_truth", "edge_evidence_truth", "runtime_reliability_live_state", "runtime_truth_matrix"]
      : [],
  );
  const blockingDegradedSources = degradedRuntimeTruthSources.filter((source) => !haltInducedDegradedSources.has(source));
  const resetBlockers = dedupe([
    !Boolean(active) ? "kill_switch_not_active" : null,
    lifecyclePublishBlocked ? "lifecycle_publish_gate_blocked" : null,
    activeDebtTotal > 0 ? "active_debt_present" : null,
    blockedDecisionTotal > 0 ? "execution_gap_blocked" : null,
    !runtimeTruthGate.available ? "runtime_truth_unavailable" : null,
    !runtimeTruthReadyForReset ? "runtime_truth_not_ready" : null,
    ...missingRuntimeTruthSources.map((source) => `${source}_missing`),
    ...blockingDegradedSources.map((source) => `${source}_degraded`),
    publicProbe.status !== "pass" ? "public_probe_not_pass" : null,
    !replayGate.available ? "replay_certification_gate_unavailable" : null,
    replayGate.ready === false ? "replay_certification_gate_not_ready" : null,
    reason === "BUS_OFFLINE" && !busHealthVerified ? "bus_health_unverified" : null,
  ]);
  const resetEligible = Boolean(active)
    && !lifecyclePublishBlocked
    && activeDebtTotal === 0
    && blockedDecisionTotal === 0
    && runtimeTruthReadyForReset
    && missingRuntimeTruthSources.length === 0
    && blockingDegradedSources.length === 0
    && publicProbe.status === "pass"
    && replayGate.available
    && replayGate.ready !== false
    && resetBlockers.length === 0;

  return { active, reason, last_transition: lastTransition, reset_eligible: resetEligible, reset_blockers: resetBlockers };
}

function pickString(record: JsonMap, keys: string[]): string | null {
  for (const key of keys) {
    const value = String(record[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveRuntimeRedisUrl(): string {
  return String(process.env.RUNTIME_REDIS_URL || "redis://runtime-redis:6379/0").trim();
}

function encodeRedisCommand(args: string[]): Buffer {
  return Buffer.from(`*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`, "utf8");
}

function parseRedisResp(buffer: Buffer): unknown {
  let offset = 0;
  const readLine = (): string => {
    const end = buffer.indexOf("\r\n", offset, "utf8");
    if (end < 0) {
      throw new Error("redis_resp_incomplete_line");
    }
    const line = buffer.toString("utf8", offset, end);
    offset = end + 2;
    return line;
  };
  const parseValue = (): unknown => {
    const prefix = buffer.toString("utf8", offset, offset + 1);
    offset += 1;
    if (prefix === "+") {
      return readLine();
    }
    if (prefix === "-") {
      throw new Error(readLine() || "redis_error");
    }
    if (prefix === ":") {
      return Number(readLine());
    }
    if (prefix === "$") {
      const length = Number(readLine());
      if (!Number.isFinite(length) || length < 0) {
        return null;
      }
      const value = buffer.toString("utf8", offset, offset + length);
      offset += length + 2;
      return value;
    }
    if (prefix === "*") {
      const length = Number(readLine());
      if (!Number.isFinite(length) || length < 0) {
        return null;
      }
      const items: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        items.push(parseValue());
      }
      return items;
    }
    throw new Error(`redis_resp_unknown_prefix:${prefix || "empty"}`);
  };
  return parseValue();
}

async function redisCommand(args: string[], timeoutMs = 1500): Promise<unknown> {
  const url = new URL(resolveRuntimeRedisUrl());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      fn();
      socket.destroy();
    };
    const socket = net.createConnection({ host: url.hostname || "runtime-redis", port: Number(url.port || "6379") });
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("redis_probe_timeout")));
    }, timeoutMs);
    socket.on("connect", () => {
      socket.write(encodeRedisCommand(args));
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      try {
        const parsed = parseRedisResp(Buffer.concat(chunks));
        settle(() => resolve(parsed));
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "redis_resp_incomplete_line") {
          settle(() => reject(error));
        }
      }
    });
    socket.on("error", (error) => {
      settle(() => reject(error));
    });
  });
}

function redisEntryFromResp(stream: string, value: unknown): RedisStreamEntry | null {
  if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0])) {
    return null;
  }
  const entry = value[0] as unknown[];
  const id = String(entry[0] || "").trim() || null;
  const rawFields = Array.isArray(entry[1]) ? entry[1] as unknown[] : [];
  const fields: JsonMap = {};
  for (let index = 0; index + 1 < rawFields.length; index += 2) {
    const key = String(rawFields[index] || "").trim();
    if (key) {
      fields[key] = rawFields[index + 1];
    }
  }
  return { stream, id, fields };
}

function redisStreamInfoFromResp(stream: string, value: unknown): RedisStreamInfo {
  const info: RedisStreamInfo = {
    name: stream,
    length: null,
    groups: null,
    last_generated_id: null,
    error: null,
  };
  if (!Array.isArray(value)) {
    return info;
  }
  for (let index = 0; index + 1 < value.length; index += 2) {
    const key = String(value[index] || "").trim().toLowerCase();
    const raw = value[index + 1];
    if (key === "length") {
      const numeric = Number(raw);
      info.length = Number.isFinite(numeric) ? numeric : null;
    } else if (key === "groups") {
      const numeric = Number(raw);
      info.groups = Number.isFinite(numeric) ? numeric : null;
    } else if (key === "last-generated-id") {
      info.last_generated_id = String(raw || "").trim() || null;
    }
  }
  return info;
}

async function probeRedisBus(): Promise<RedisBusProbe> {
  const url = resolveRuntimeRedisUrl();
  const streams = ["txt.runtime", "txt.watchdog", "txt.execution", "txt.observations"];
  const startedAt = Date.now();
  const errors: string[] = [];
  try {
    await redisCommand(["PING"]);
  } catch (error) {
    return {
      transport_status: "offline",
      url,
      ping_ms: null,
      streams_checked: streams,
      stream_info: streams.map((stream) => ({
        name: stream,
        length: null,
        groups: null,
        last_generated_id: null,
        error: error instanceof Error ? error.message : String(error || "redis_ping_failed"),
      })),
      errors: [error instanceof Error ? error.message : String(error || "redis_ping_failed")],
      entries: [],
      latest_entry: null,
    };
  }

  let latestEntry: RedisStreamEntry | null = null;
  const entries: RedisStreamEntry[] = [];
  const streamInfo: RedisStreamInfo[] = [];
  for (const stream of streams) {
    try {
      const entry = redisEntryFromResp(stream, await redisCommand(["XREVRANGE", stream, "+", "-", "COUNT", "1"]));
      if (!entry) {
        streamInfo.push(redisStreamInfoFromResp(stream, await redisCommand(["XINFO", "STREAM", stream])));
        continue;
      }
      entries.push(entry);
      const entryMs = parseIsoMs(String(entry.fields.emitted_at || entry.fields.as_of || entry.fields.timestamp || ""));
      const latestMs = latestEntry ? parseIsoMs(String(latestEntry.fields.emitted_at || latestEntry.fields.as_of || latestEntry.fields.timestamp || "")) : null;
      if (!latestEntry || (entryMs !== null && (latestMs === null || entryMs > latestMs))) {
        latestEntry = entry;
      }
      streamInfo.push(redisStreamInfoFromResp(stream, await redisCommand(["XINFO", "STREAM", stream])));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || "stream_probe_failed");
      errors.push(`${stream}:${detail}`);
      streamInfo.push({
        name: stream,
        length: null,
        groups: null,
        last_generated_id: null,
        error: detail,
      });
    }
  }

  return {
    transport_status: "online",
    url,
    ping_ms: Math.max(0, Date.now() - startedAt),
    streams_checked: streams,
    stream_info: streamInfo,
    errors,
    entries,
    latest_entry: latestEntry,
  };
}

function freshnessFromIso(
  lastSeenAt: string | null,
  expectedMaxStalenessMs: number | null,
): ControlledLiveRampGateReport["runtime_source_degradation_map"]["sources"][number]["freshness"] {
  const parsed = parseIsoMs(lastSeenAt);
  const freshnessMs = parsed === null ? null : Math.max(0, Date.now() - parsed);
  return {
    last_seen_at: lastSeenAt,
    freshness_ms: freshnessMs,
    expected_max_staleness_ms: expectedMaxStalenessMs,
    stale: freshnessMs === null || expectedMaxStalenessMs === null ? null : freshnessMs > expectedMaxStalenessMs,
  };
}

function buildSettlementTruthDiagnostic(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
): ControlledLiveRampGateReport["settlement_truth"] {
  if (context !== "ops") {
    return {
      status: "skipped",
      source: null,
      last_seen_at: null,
      expected_contract: "settlement-truth/v1",
      blocking: false,
      repair_hint: null,
    };
  }

  const runtimeTruthRecord = asRecord(runtimeTruth);
  const raw = asRecord(runtimeTruthRecord.raw);
  const layers = asRecord(runtimeTruthRecord.layers);
  const rawSettlement = asRecord(raw.settlement_truth || raw.settlementTruth);
  const layerSettlement = asRecord(layers.settlement || layers.settlement_truth);
  const settlementPayload = hasKeys(rawSettlement) ? rawSettlement : layerSettlement;
  const source = hasKeys(rawSettlement)
    ? "control_plane"
    : hasKeys(layerSettlement)
      ? "runtime_truth.layers.settlement"
      : "control_plane";

  if (!hasKeys(settlementPayload)) {
    return {
      status: "missing_source",
      source,
      last_seen_at: null,
      expected_contract: "settlement-truth/v1",
      blocking: true,
      repair_hint: "control_plane_snapshot_missing_settlement_truth",
    };
  }

  const schemaVersion = String(settlementPayload.schema_version || settlementPayload.schema || "").trim();
  const upstreamStatus = String(settlementPayload.status || "").trim();
  const contractValid = schemaVersion === "settlement-truth/v1" && settlementPayload.contract_valid !== false;
  const status = !contractValid
    ? "missing_contract"
    : ["available", "empty_but_valid", "stale", "missing_contract", "missing_source", "join_failed", "source_unreachable"].includes(upstreamStatus)
      ? upstreamStatus as ControlledLiveRampGateReport["settlement_truth"]["status"]
      : "available";
  const blocking = !["available", "empty_but_valid"].includes(status);
  return {
    status,
    source,
    last_seen_at: pickString(settlementPayload, ["last_seen_at", "generated_at", "updated_at", "timestamp", "as_of"]),
    expected_contract: "settlement-truth/v1",
    blocking,
    repair_hint: blocking
      ? String(settlementPayload.repair_hint || (status === "missing_contract" ? `settlement_truth_contract_mismatch:${schemaVersion || "missing_schema"}` : status)).trim()
      : null,
  };
}

async function resolveSettlementTruthDiagnostic(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
): Promise<{
  settlementTruth: ControlledLiveRampGateReport["settlement_truth"];
  directProbe: SettlementDirectProbe | null;
}> {
  const fromRuntimeTruth = buildSettlementTruthDiagnostic(context, runtimeTruth);
  if (context !== "ops" || !fromRuntimeTruth.blocking || !["missing_source", "source_unreachable", "missing"].includes(fromRuntimeTruth.status)) {
    return { settlementTruth: fromRuntimeTruth, directProbe: null };
  }

  try {
    const directProbe = await cpFetchJsonSafe("/v1/settlement/truth", { authMode: "service" });
    const payload = asRecord(directProbe.payload);
    if (!directProbe.response.ok || !hasKeys(payload)) {
      return { settlementTruth: fromRuntimeTruth, directProbe };
    }
    const directRuntimeTruth = {
      raw: { settlement_truth: payload },
      layers: { settlement: payload },
    };
    const directSettlementTruth = buildSettlementTruthDiagnostic(context, directRuntimeTruth);
    return {
      settlementTruth: directSettlementTruth.blocking ? fromRuntimeTruth : {
        ...directSettlementTruth,
        source: "control_plane_direct_probe",
      },
      directProbe,
    };
  } catch {
    return { settlementTruth: fromRuntimeTruth, directProbe: null };
  }
}

function buildRuntimeTruthMatrixDiagnostic(
  context: ControlledLiveRampGateContext,
  runtimeTruthGate: ControlledLiveRampGateReport["runtime_truth_gate"],
  missingRuntimeTruthSources: string[],
  // True when the backend execution-router observation is online AND the only
  // reason the runtime-truth verdict is non-READY is capture-derived (NO_EDGE /
  // decision_quote_coverage from the dead browser terminal). In that case the
  // matrix must not report degraded — the backend bus is the authority.
  backendAuthoritativeCaptureOnly = false,
): ControlledLiveRampGateReport["runtime_truth_matrix"] {
  if (context !== "ops") {
    return {
      status: "skipped",
      coverage: { required: 0, available: 0, missing: [] },
      summary: "runtime truth matrix skipped in ci context",
    };
  }

  const requiredSources = ["runtime_truth_matrix", "control_plane_health", "execution_truth", "position_truth", "settlement_truth", "decision_truth", "controlled_collection_truth", "edge_evidence_truth"];
  const missing = requiredSources.filter((source) => missingRuntimeTruthSources.includes(source));
  const required = requiredSources.length;
  const available = Math.max(0, required - missing.length);
  const verdictDegrades = runtimeTruthGate.verdict !== "READY" && !backendAuthoritativeCaptureOnly;
  const status = !runtimeTruthGate.available ? "missing" : missing.length > 0 || verdictDegrades ? "degraded" : "available";
  return {
    status,
    coverage: { required, available, missing },
    summary: `${available}/${required} runtime truth sources available${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}`,
  };
}

function degradationStatus(
  context: ControlledLiveRampGateContext,
  missingSources: string[],
  degradedSources: string[],
  sourceName: string,
): "available" | "degraded" | "missing" | "skipped" {
  if (context !== "ops") {
    return "skipped";
  }
  if (missingSources.includes(sourceName)) {
    return "missing";
  }
  if (degradedSources.includes(sourceName)) {
    return "degraded";
  }
  return "available";
}

function networkDegradationReasons(network: JsonMap): string[] {
  return dedupe(Object.entries(network).flatMap(([key, value]) => {
    const entry = asRecord(value);
    if (!networkEntryIsDegraded(entry)) {
      return [];
    }
    return [
      `${key}:${String(entry.failure_classification || entry.network_state || "degraded")}`,
      String(entry.failure_detail || "").trim(),
    ];
  }));
}

function classifyControlledCollectionTruth(controlled: JsonMap, liveBlocked: boolean): {
  detailStatus: string;
  degradationReasons: string[];
  repairHint: string | null;
} {
  const available = Boolean(controlled.available);
  const phase = String(controlled.phase || "").trim().toUpperCase();
  const cycles = toNumber(controlled.cycles, 0);
  const fillsSeen = toNumber(controlled.fillsSeen, 0);
  const labelsSeen = toNumber(controlled.labelsSeen, 0);
  const watchStale = Boolean(controlled.watchStale);

  if (!available && phase === "NO_SESSION") {
    return {
      detailStatus: "empty_but_valid",
      degradationReasons: ["no_recent_cycles"],
      repairHint: "resume_controlled_collection_or_keep_probe_gate_until_cycles_exist",
    };
  }
  if (!available && phase === "UNAVAILABLE") {
    return {
      detailStatus: "missing_source",
      degradationReasons: ["controlled_collection_unavailable"],
      repairHint: "restore_controlled_collection_source",
    };
  }
  if ((watchStale || phase === "STALE_SESSION") && liveBlocked) {
    return {
      detailStatus: "stale_due_to_live_block",
      degradationReasons: ["controlled_collection_watch_stale", "live_block_active"],
      repairHint: "keep_collection_passive_until_runtime_live_state_recovers",
    };
  }
  if (watchStale || phase === "STALE_SESSION") {
    return {
      detailStatus: "stale",
      degradationReasons: ["controlled_collection_watch_stale"],
      repairHint: "refresh_controlled_collection_watch",
    };
  }
  if (cycles > 0 && fillsSeen <= 0) {
    return {
      detailStatus: "no_recent_cycles",
      degradationReasons: ["fills_empty"],
      repairHint: "resume_controlled_collection_or_mark_empty_but_valid",
    };
  }
  if (fillsSeen > 0 && labelsSeen <= 0) {
    return {
      detailStatus: "label_gap",
      degradationReasons: ["labels_empty"],
      repairHint: "backfill_controlled_collection_labels",
    };
  }
  if (labelsSeen <= 0) {
    return {
      detailStatus: "no_labels_required",
      degradationReasons: ["labels_empty"],
      repairHint: "confirm_probe_phase_label_expectations",
    };
  }
  return {
    detailStatus: "available",
    degradationReasons: [],
    repairHint: null,
  };
}

function configuredControlPlaneBaseUrl(): string {
  return String(
    process.env.CONTROLLED_LIVE_GATE_CONTROL_PLANE_URL
    || process.env.CONTROL_PLANE_URL
    || process.env.CONTROL_PLANE_FALLBACK_URL
    || process.env.KAIROS_CONTROL_PLANE_URL
    || "http://control-plane:8000",
  ).trim();
}

function allowHostLocalOpsContext(): boolean {
  const raw = String(process.env.CONTROLLED_LIVE_GATE_ALLOW_HOST_LOCAL_OPS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function buildOpsRunnerContext(
  context: ControlledLiveRampGateContext,
  settlementSourceContextDiff: ControlledLiveRampGateReport["settlement_source_context_diff"],
): ControlledLiveRampGateReport["ops_runner_context"] {
  const controlPlaneUrl = configuredControlPlaneBaseUrl();
  const requiredControlPlaneUrlPresent = Boolean(String(process.env.CONTROLLED_LIVE_GATE_CONTROL_PLANE_URL || "").trim());
  const hostLocalAllowed = allowHostLocalOpsContext();
  const valid = context !== "ops"
    || (
      requiredControlPlaneUrlPresent
      && settlementSourceContextDiff.ops_context_allowed
      && settlementSourceContextDiff.source_context !== "unknown"
    );
  const repairHint = valid
    ? null
    : !requiredControlPlaneUrlPresent
      ? "set_CONTROLLED_LIVE_GATE_CONTROL_PLANE_URL_for_ops_runner"
      : settlementSourceContextDiff.repair_hint || "run_ops_scanner_inside_docker_service_network";
  return {
    schema_version: "ops-runner-context/v1",
    valid,
    network_context: settlementSourceContextDiff.source_context,
    control_plane_url: controlPlaneUrl,
    required_control_plane_url_present: requiredControlPlaneUrlPresent,
    host_local_allowed: hostLocalAllowed,
    runner_service: String(process.env.CONTROLLED_LIVE_GATE_RUNNER_SERVICE || "").trim() || null,
    repair_hint: repairHint,
  };
}

function classifySourceContext(url: string | null): ControlPlaneSourceContext {
  const value = String(url || "").trim();
  if (!value) {
    return "unknown";
  }
  if (value.includes("control-plane:8000")) {
    return "docker_service_network";
  }
  if (value.includes("127.0.0.1") || value.includes("localhost")) {
    return "host_local";
  }
  if (value.includes("/__mc_internal/control-plane") || value.includes("mission-control-gateway")) {
    return "mission_control_gateway";
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return "configured_external";
  }
  return "unknown";
}

function buildSettlementSourceContextDiff(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
  settlementTruth: ControlledLiveRampGateReport["settlement_truth"],
  directProbe: SettlementDirectProbe | null,
): ControlledLiveRampGateReport["settlement_source_context_diff"] {
  const runtimeTruthRecord = asRecord(runtimeTruth);
  const raw = asRecord(runtimeTruthRecord.raw);
  const network = asRecord(raw.network);
  const settlementNetwork = directProbe?.network ? directProbe.network as unknown as JsonMap : asRecord(network.settlement_truth);
  const rawSettlement = directProbe?.payload ? asRecord(directProbe.payload) : asRecord(raw.settlement_truth || raw.settlementTruth);
  const attemptedTargets = Array.isArray(settlementNetwork.attempted_targets)
    ? settlementNetwork.attempted_targets.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const attemptedBaseUrls = Array.isArray(settlementNetwork.attempted_base_urls)
    ? settlementNetwork.attempted_base_urls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const expectedBaseUrl = configuredControlPlaneBaseUrl();
  const expectedUrl = `${expectedBaseUrl.replace(/\/+$/, "")}/v1/settlement/truth`;
  const resolvedUrl = attemptedTargets[0] || attemptedBaseUrls[0] || (directProbe ? expectedUrl : null);
  const sourceContext = classifySourceContext(resolvedUrl || expectedUrl);
  const opsContextAllowed = context !== "ops" || sourceContext !== "host_local" || allowHostLocalOpsContext();
  const httpStatus = Number.isFinite(Number(settlementNetwork.upstream_status))
    ? Number(settlementNetwork.upstream_status)
    : null;
  const schemaVersion = String(rawSettlement.schema_version || rawSettlement.schema || "").trim() || null;
  const status = String(rawSettlement.status || settlementTruth.status || "").trim() || null;
  const networkFailure = String(settlementNetwork.failure_detail || settlementNetwork.failure_classification || "").trim();
  const missingSourceReason = settlementTruth.blocking
    ? networkFailure || settlementTruth.repair_hint || `settlement_truth_${settlementTruth.status}`
    : null;
  const repairHint = !opsContextAllowed
    ? "use_docker_service_control_plane_url_in_ops_context"
    : settlementTruth.blocking
      ? missingSourceReason
      : null;
  return {
    schema_version: "settlement-source-context-diff/v1",
    expected_url: expectedUrl,
    resolved_url: resolvedUrl,
    http_status: httpStatus,
    schema_version_observed: schemaVersion,
    status,
    context,
    source_context: sourceContext,
    missing_source_reason: missingSourceReason,
    ops_context_allowed: opsContextAllowed,
    repair_hint: repairHint,
  };
}

async function buildBusHealthDiagnostic(
  context: ControlledLiveRampGateContext,
  runtimeTruth: unknown,
  runtimeTruthGate: ControlledLiveRampGateReport["runtime_truth_gate"],
): Promise<ControlledLiveRampGateReport["bus_health"]> {
  if (context !== "ops") {
    return {
      schema_version: "bus-health/v1",
      status: "skipped",
      verified: false,
      observer: context === "ci" ? "ci" : "scanner",
      source_context: "unknown",
      checked_url: null,
      http_status: null,
      last_seen_at: null,
      last_event_at: null,
      event_lag_ms: null,
      publisher_status: "skipped",
      consumer_status: "skipped",
      publisher: {
        status: "unknown",
        stream: null,
        producer_id: null,
        last_heartbeat_at: null,
        last_event_id: null,
        event_lag_ms: null,
      },
      live_observation: {
        status: "unknown",
        source: null,
        opportunity_gate_status: null,
        valid_observation: null,
        bus_seq: null,
        updated_at: null,
        freshness_ms: null,
        flags: [],
      },
      consumer: {
        status: "unknown",
        source: null,
        last_read_at: null,
        reason: null,
      },
      transport: {
        status: "unknown",
        kind: "unknown",
        url: null,
        ping_ms: null,
        streams_checked: [],
        streams: [],
        errors: [],
      },
      repair_hint: null,
    };
  }
  const redisBus = await probeRedisBus();
  const runtimeTruthRecord = asRecord(runtimeTruth);
  const layers = asRecord(runtimeTruthRecord.layers);
  const raw = asRecord(runtimeTruthRecord.raw);
  const network = asRecord(raw.network);
  const killSwitchNetwork = asRecord(network.kill_switch);
  const rawOpportunityGate = asRecord(raw.opportunity_gate);
  const opportunityGate = asRecord(rawOpportunityGate.gate || rawOpportunityGate);
  const opportunityMetrics = asRecord(opportunityGate.metrics);
  const health = asRecord(layers.health);
  const routing = asRecord(layers.routing);
  const readiness = asRecord(layers.readiness);
  const controlled = asRecord(raw.controlled_collection);
  const expectedBaseUrl = configuredControlPlaneBaseUrl();
  const checkedUrl = `${expectedBaseUrl.replace(/\/+$/, "")}/v1/system/kill-switch`;
  const generatedAt = pickString(runtimeTruthRecord, ["generated_at", "generated_at_iso"]);
  const watchdogEntry = redisBus.entries.find((entry) => entry.stream === "txt.watchdog") || null;
  const publisherEntry = watchdogEntry || redisBus.latest_entry;
  const redisLastEventAt = publisherEntry
    ? String(publisherEntry.fields.emitted_at || publisherEntry.fields.as_of || publisherEntry.fields.timestamp || "").trim() || null
    : null;
  const lastEventAt = redisLastEventAt || pickString(controlled, ["lastSnapshotAt", "latestFillAt", "latestLabeledAt", "openedAt"]);
  const lastEventMs = parseIsoMs(lastEventAt);
  const eventLagMs = lastEventMs === null ? null : Math.max(0, Date.now() - lastEventMs);
  const reason = String(health.kill_switch_reason || "").trim();
  const liveState = String(readiness.live_state || "").trim().toUpperCase();
  const reliability = String(readiness.runtime_reliability || "").trim().toUpperCase();
  const opportunityStatus = String(opportunityGate.status || routing.status || "").trim().toLowerCase() || null;
  const opportunityFlags = asStringArray(opportunityMetrics.flags).map((item) => item.toUpperCase());
  const opportunityValidObservation = typeof opportunityGate.valid_observation === "boolean"
    ? Boolean(opportunityGate.valid_observation)
    : null;
  const opportunityBusSeq = Number.isFinite(Number(opportunityMetrics.bus_seq)) ? Number(opportunityMetrics.bus_seq) : null;
  const opportunityFreshnessMs = Number.isFinite(Number(opportunityMetrics.freshness_ms)) ? Number(opportunityMetrics.freshness_ms) : null;
  const opportunityUpdatedAt = pickString(opportunityGate, ["updated_at", "evaluated_at"]);
  const liveObservationOnline = opportunityStatus === "go"
    && opportunityValidObservation !== false
    && opportunityBusSeq !== null
    && opportunityBusSeq > 0
    && !opportunityFlags.includes("BUS_OFFLINE")
    && !opportunityFlags.includes("OBSERVATION_ERROR");
  const liveObservationStatus: ControlledLiveRampGateReport["bus_health"]["live_observation"]["status"] = liveObservationOnline
    ? "online"
    : opportunityStatus || opportunityBusSeq !== null || opportunityUpdatedAt
      ? "degraded"
      : "unavailable";
  const publisherStatus: ControlledLiveRampGateReport["bus_health"]["publisher"]["status"] = publisherEntry && eventLagMs !== null
    ? eventLagMs > 10 * 60 * 1000 ? "stale" : "online"
    : "unknown";
  // Formal supersession of the legacy txt.watchdog channel: only effective
  // while its declared conditions hold, and a recovered legacy publisher
  // always takes precedence over the declaration.
  const supersessionEffective = LEGACY_WATCHDOG_SUPERSESSION.declared
    && publisherStatus !== "online"
    && redisBus.transport_status === "online"
    && liveObservationOnline;
  const consumerSource = String(controlled.killSwitchSource || liveState || "unknown").trim() || "unknown";
  const consumerStatus: ControlledLiveRampGateReport["bus_health"]["consumer"]["status"] = supersessionEffective
    ? "not_required"
    : consumerSource === "unavailable"
      ? "unavailable"
      : ["GO", "LIVE", "READY", "RELIABLE"].includes(consumerSource.toUpperCase())
        ? "online"
        : "unknown";
  const legacyPublisherBlocking = publisherStatus === "stale" && !supersessionEffective;
  const latchedBusOfflineBlocking = reason === "BUS_OFFLINE" && !supersessionEffective;
  const status: ControlledLiveRampGateReport["bus_health"]["status"] = redisBus.transport_status === "offline"
    ? "offline"
    : liveObservationOnline && legacyPublisherBlocking
      ? "degraded"
    : legacyPublisherBlocking
      ? "offline"
      : latchedBusOfflineBlocking
    ? "offline"
    : runtimeTruthGate.blockers.some((item) => item.includes("NO_DATA") || item.includes("BLOCKED_BY_DATA"))
      ? "unverified"
      : runtimeTruthGate.verdict === "READY"
        || (runtimeTruthGate.verdict === "BLOCKED"
          && runtimeTruthGate.blockers.length > 0
          && runtimeTruthGate.blockers.every((item) => item === "kill_switch_active"))
        ? "online"
        : "degraded";
  const verified = status === "online";
  const repairHint = verified
    ? null
    : redisBus.transport_status === "offline"
      ? "verify_runtime_redis_transport"
      : liveObservationOnline && legacyPublisherBlocking
        ? "reconcile_runtime_redis_stream_publisher"
      : legacyPublisherBlocking
        ? "restart_or_reconcile_runtime_bus_publishers"
        : "verify_event_bus_publishers_and_consumers";
  return {
    schema_version: "bus-health/v1",
    status,
    verified,
    observer: "scanner",
    source_context: classifySourceContext(checkedUrl),
    checked_url: checkedUrl,
    http_status: Number.isFinite(Number(killSwitchNetwork.upstream_status)) ? Number(killSwitchNetwork.upstream_status) : null,
    last_seen_at: generatedAt,
    last_event_at: lastEventAt,
    event_lag_ms: eventLagMs,
    publisher_status: publisherStatus === "stale" ? "stale" : reason === "BUS_OFFLINE" ? "unknown" : reliability || publisherStatus,
    consumer_status: consumerStatus,
    publisher: {
      status: publisherStatus,
      stream: publisherEntry?.stream || null,
      producer_id: publisherEntry ? String(publisherEntry.fields.producer_id || "").trim() || null : null,
      last_heartbeat_at: lastEventAt,
      last_event_id: publisherEntry?.id || null,
      event_lag_ms: eventLagMs,
    },
    live_observation: {
      status: liveObservationStatus,
      source: String(opportunityGate.source || "execution-router/health").trim() || null,
      opportunity_gate_status: opportunityStatus,
      valid_observation: opportunityValidObservation,
      bus_seq: opportunityBusSeq,
      updated_at: opportunityUpdatedAt,
      freshness_ms: opportunityFreshnessMs,
      flags: opportunityFlags,
    },
    consumer: {
      status: consumerStatus,
      source: consumerSource,
      last_read_at: generatedAt,
      reason: supersessionEffective ? LEGACY_WATCHDOG_SUPERSESSION.reason : null,
    },
    transport: {
      status: redisBus.transport_status,
      kind: redisBus.transport_status === "unknown" ? "unknown" : "redis_stream",
      url: redisBus.url,
      ping_ms: redisBus.ping_ms,
      streams_checked: redisBus.streams_checked,
      streams: redisBus.stream_info,
      errors: redisBus.errors,
    },
    repair_hint: repairHint,
  };
}

function buildLegacyWatchdogReconciliation(
  context: ControlledLiveRampGateContext,
  busHealth: ControlledLiveRampGateReport["bus_health"],
): ControlledLiveRampGateReport["legacy_watchdog_reconciliation"] {
  const watchdogStream = busHealth.transport.streams.find((stream) => stream.name === "txt.watchdog") || null;
  const publisherStatus = busHealth.publisher.status;
  const transportStatus = busHealth.transport.status;
  const liveObservationStatus = busHealth.live_observation.status;
  const redisStreamStatus: ControlledLiveRampGateReport["legacy_watchdog_reconciliation"]["redis_stream_status"] = transportStatus === "offline"
    ? "unreachable"
    : !watchdogStream || watchdogStream.error
      ? "unknown"
      : publisherStatus === "online"
        ? "fresh"
        : publisherStatus === "stale"
          ? "stale"
          : "unknown";
  const consumerMode: ControlledLiveRampGateReport["legacy_watchdog_reconciliation"]["consumer_mode"] = typeof watchdogStream?.groups === "number"
    ? watchdogStream.groups > 0 ? "consumer_group_present" : "no_consumer_group_configured"
    : "unknown";
  const supersessionIneffectiveReasons = dedupe([
    !LEGACY_WATCHDOG_SUPERSESSION.declared ? "supersession_not_declared" : null,
    transportStatus !== "online" ? "redis_transport_not_online" : null,
    liveObservationStatus !== "online" ? "live_observation_not_online" : null,
    publisherStatus === "online" ? "legacy_publisher_recovered_takes_precedence" : null,
  ]);
  const supersessionEffective = supersessionIneffectiveReasons.length === 0;
  const decision: ControlledLiveRampGateReport["legacy_watchdog_reconciliation"]["decision"] = transportStatus === "offline"
    ? "redis_transport_unreachable"
    : publisherStatus === "online"
      ? "legacy_publisher_recovered"
      : supersessionEffective
        ? "formally_superseded_by_live_observation"
        : "recover_legacy_publisher_or_formally_supersede";
  const blocksReset = context === "ops"
    && decision !== "legacy_publisher_recovered"
    && decision !== "formally_superseded_by_live_observation";
  return {
    schema_version: "legacy-watchdog-reconciliation/v2",
    stream: "txt.watchdog",
    expected_publisher: busHealth.publisher.producer_id || "control-plane/runtime-headless",
    writer_process_detected: publisherStatus === "online" ? true : publisherStatus === "stale" ? false : null,
    publisher_last_seen_at: busHealth.publisher.last_heartbeat_at,
    redis_stream_status: redisStreamStatus,
    redis_groups: watchdogStream?.groups ?? null,
    redis_last_generated_id: watchdogStream?.last_generated_id || busHealth.publisher.last_event_id,
    live_observation_status: liveObservationStatus,
    consumer_mode: consumerMode,
    reconciliation_mode: decision === "legacy_publisher_recovered"
      ? "not_required"
      : decision === "formally_superseded_by_live_observation"
        ? "superseded"
        : "required",
    decision,
    supersession: LEGACY_WATCHDOG_SUPERSESSION.declared
      ? {
        schema_version: LEGACY_WATCHDOG_SUPERSESSION.schema_version,
        declared: LEGACY_WATCHDOG_SUPERSESSION.declared,
        superseded_by: LEGACY_WATCHDOG_SUPERSESSION.superseded_by,
        declared_at: LEGACY_WATCHDOG_SUPERSESSION.declared_at,
        declared_by: LEGACY_WATCHDOG_SUPERSESSION.declared_by,
        reason: LEGACY_WATCHDOG_SUPERSESSION.reason,
        effective: supersessionEffective,
        ineffective_reasons: supersessionIneffectiveReasons,
      }
      : null,
    blocks_reset: blocksReset,
    repair_hint: blocksReset
      ? "recover_legacy_watchdog_publisher_or_formally_supersede_with_live_observation_contract"
      : null,
  };
}

function buildRuntimeSourceDegradationMap(params: {
  context: ControlledLiveRampGateContext;
  runtimeTruth: unknown;
  runtimeTruthGate: ControlledLiveRampGateReport["runtime_truth_gate"];
  runtimeTruthMatrix: ControlledLiveRampGateReport["runtime_truth_matrix"];
  settlementTruth: ControlledLiveRampGateReport["settlement_truth"];
  authProbe: ControlledLiveRampGateReport["auth_probe"];
  missingRuntimeTruthSources: string[];
  degradedRuntimeTruthSources: string[];
}): ControlledLiveRampGateReport["runtime_source_degradation_map"] {
  const runtimeTruthRecord = asRecord(params.runtimeTruth);
  const generatedAt = pickString(runtimeTruthRecord, ["generated_at", "generated_at_iso"]);
  const layers = asRecord(runtimeTruthRecord.layers);
  const raw = asRecord(runtimeTruthRecord.raw);
  const network = asRecord(raw.network);
  const controlled = asRecord(raw.controlled_collection);
  const edgeEvidence = asRecord(raw.edge_evidence);
  const health = asRecord(layers.health);
  const readiness = asRecord(layers.readiness);
  const settlementFreshness = freshnessFromIso(params.settlementTruth.last_seen_at, 24 * 60 * 60 * 1000);
  const runtimeReliabilityState = String(readiness.runtime_reliability || "").trim().toUpperCase() || "UNAVAILABLE";
  const liveState = String(readiness.live_state || "").trim().toUpperCase() || "UNAVAILABLE";
  const controlledCollectionTruth = classifyControlledCollectionTruth(
    controlled,
    Boolean(health.kill_switch_active) || !["GO", "LIVE"].includes(liveState),
  );
  const controlPlaneReasons = dedupe([
    ...networkDegradationReasons(network),
    ...params.runtimeTruthGate.blockers.filter((reason) => reason.includes("BLOCKED_BY_DATA") || reason.includes("NO_DATA")),
    ...params.runtimeTruthGate.degraded_reasons.filter((reason) => reason.includes("partial_data") || reason.includes("mt5_health") || reason.includes("runtime_reliability")),
    Boolean(health.kill_switch_reason) ? String(health.kill_switch_reason) : null,
  ]);
  const controlledCollectionReasons = dedupe([
    ...controlledCollectionTruth.degradationReasons,
    ...params.runtimeTruthGate.degraded_reasons.filter((reason) => reason.includes("controlled_collection")),
  ]);
  const runtimeReliabilityReasons = dedupe([
    runtimeReliabilityState && runtimeReliabilityState !== "RELIABLE" ? `runtime_reliability:${runtimeReliabilityState}` : null,
    liveState && !["GO", "LIVE"].includes(liveState) ? `live_state:${liveState}` : null,
    ...params.runtimeTruthGate.blockers.filter((reason) => reason.startsWith("runtime_reliability:") || reason.startsWith("live_state:")),
    ...params.runtimeTruthGate.degraded_reasons.filter((reason) => reason.startsWith("runtime_reliability:") || reason.startsWith("live_state:")),
  ]);
  const edgeReasons = dedupe([
    Boolean(edgeEvidence.available) ? null : "edge_evidence_unavailable",
    String(edgeEvidence.state || "").toUpperCase() && String(edgeEvidence.state || "").toUpperCase() !== "READY" ? `edge_state:${String(edgeEvidence.state).toUpperCase()}` : null,
    toNumber(edgeEvidence.matureCells, 0) <= 0 ? "mature_cells_empty" : null,
    ...params.runtimeTruthGate.degraded_reasons.filter((reason) => reason.includes("NO_EDGE") || reason.includes("edge")),
  ]);
  const executionReasons = dedupe([
    networkEntryIsDegraded(network.execution_telemetry_recent) ? "execution_telemetry_recent_degraded" : null,
    networkEntryIsDegraded(network.execution_reality_gap_recent) ? "execution_reality_gap_recent_degraded" : null,
    ...params.runtimeTruthGate.degraded_reasons.filter((reason) => reason.includes("broker_reality") || reason.includes("quote_reality") || reason.includes("mt5_health")),
  ]);
  const matrixReasons = dedupe([
    params.runtimeTruthMatrix.status === "degraded" ? "runtime_truth_matrix_degraded" : null,
    ...params.runtimeTruthMatrix.coverage.missing.map((source) => `${source}_missing`),
    ...params.runtimeTruthGate.blockers,
    ...params.runtimeTruthGate.degraded_reasons,
  ]);
  const authReasons = dedupe([
    params.authProbe.status === "not_run" ? "auth_probe_not_run" : null,
    params.authProbe.status === "not_authorized" ? "auth_probe_not_authorized" : null,
    params.authProbe.status === "schema_not_verified" ? "auth_probe_schema_not_verified" : null,
    params.authProbe.status === "fail" ? "auth_probe_failed" : null,
    ...params.authProbe.missing_fields.map((field) => `missing_field:${field}`),
  ]);

  const sources: ControlledLiveRampGateReport["runtime_source_degradation_map"]["sources"] = [
    {
      name: "settlement_truth",
      status: params.settlementTruth.blocking ? "degraded" : params.settlementTruth.status === "skipped" ? "skipped" : "available",
      detail_status: params.settlementTruth.status,
      degradation_reasons: params.settlementTruth.blocking ? dedupe([params.settlementTruth.status, params.settlementTruth.repair_hint]) : [],
      freshness: settlementFreshness,
      blocking: params.settlementTruth.blocking,
      repair_hint: params.settlementTruth.repair_hint,
    },
    {
      name: "runtime_truth_matrix",
      status: params.context !== "ops" ? "skipped" : params.runtimeTruthMatrix.status === "missing" ? "missing" : params.runtimeTruthMatrix.status,
      detail_status: params.runtimeTruthMatrix.status,
      degradation_reasons: params.runtimeTruthMatrix.status === "available" ? [] : matrixReasons,
      freshness: freshnessFromIso(generatedAt, 30_000),
      blocking: params.context === "ops" && params.runtimeTruthMatrix.status !== "available",
      repair_hint: params.runtimeTruthMatrix.status === "available" ? null : "clear_runtime_truth_blockers_and_degraded_sources",
    },
    {
      name: "control_plane",
      status: degradationStatus(params.context, params.missingRuntimeTruthSources, params.degradedRuntimeTruthSources, "control_plane"),
      detail_status: controlPlaneReasons.some((reason) => reason.includes("BUS_OFFLINE")) ? "bus_offline" : controlPlaneReasons.some((reason) => reason.includes("NO_DATA") || reason.includes("BLOCKED_BY_DATA")) ? "partial_data" : "truth_ready",
      degradation_reasons: controlPlaneReasons,
      freshness: freshnessFromIso(generatedAt, 30_000),
      blocking: params.context === "ops" && (params.degradedRuntimeTruthSources.includes("control_plane") || params.missingRuntimeTruthSources.includes("control_plane")),
      repair_hint: controlPlaneReasons.some((reason) => reason.includes("NO_DATA") || reason.includes("BLOCKED_BY_DATA"))
        ? "verify_control_plane_bus_health_and_runtime_reliability"
        : controlPlaneReasons.length > 0 ? "inspect_control_plane_network_and_runtime_sources" : null,
    },
    {
      name: "controlled_collection_truth",
      status: degradationStatus(params.context, params.missingRuntimeTruthSources, params.degradedRuntimeTruthSources, "controlled_collection_truth"),
      detail_status: controlledCollectionTruth.detailStatus,
      degradation_reasons: controlledCollectionReasons,
      freshness: freshnessFromIso(pickString(controlled, ["lastSnapshotAt", "latestFillAt", "latestLabeledAt", "openedAt"]), 10 * 60 * 1000),
      blocking: params.context === "ops" && (params.degradedRuntimeTruthSources.includes("controlled_collection_truth") || params.missingRuntimeTruthSources.includes("controlled_collection_truth")),
      repair_hint: controlledCollectionReasons.length > 0 ? controlledCollectionTruth.repairHint : null,
    },
    {
      name: "runtime_reliability_live_state",
      status: degradationStatus(params.context, params.missingRuntimeTruthSources, params.degradedRuntimeTruthSources, "runtime_reliability_live_state"),
      detail_status: runtimeReliabilityState === "RELIABLE" && ["GO", "LIVE"].includes(liveState) ? "verified" : liveState === "UNAVAILABLE" || runtimeReliabilityState === "UNAVAILABLE" ? "live_state_unverified" : "degraded",
      degradation_reasons: runtimeReliabilityReasons,
      freshness: freshnessFromIso(generatedAt, 30_000),
      blocking: params.context === "ops" && params.degradedRuntimeTruthSources.includes("runtime_reliability_live_state"),
      repair_hint: runtimeReliabilityReasons.length > 0 ? "verify_runtime_reliability_live_state" : null,
    },
    {
      name: "edge_evidence_truth",
      status: degradationStatus(params.context, params.missingRuntimeTruthSources, params.degradedRuntimeTruthSources, "edge_evidence_truth"),
      detail_status: String(edgeEvidence.state || "").trim().toLowerCase() || null,
      degradation_reasons: degradationStatus(params.context, params.missingRuntimeTruthSources, params.degradedRuntimeTruthSources, "edge_evidence_truth") === "available" ? [] : edgeReasons,
      freshness: freshnessFromIso(pickString(edgeEvidence, ["fileUpdatedAt", "generated_at", "updated_at"]), 60 * 60 * 1000),
      blocking: params.context === "ops" && (params.degradedRuntimeTruthSources.includes("edge_evidence_truth") || params.missingRuntimeTruthSources.includes("edge_evidence_truth")),
      repair_hint: degradationStatus(params.context, params.missingRuntimeTruthSources, params.degradedRuntimeTruthSources, "edge_evidence_truth") !== "available" && edgeReasons.length > 0 ? "refresh_edge_evidence_maturity_snapshot" : null,
    },
    {
      name: "execution_truth",
      status: degradationStatus(params.context, params.missingRuntimeTruthSources, params.degradedRuntimeTruthSources, "execution_truth"),
      detail_status: executionReasons.length > 0 ? "degraded" : "available",
      degradation_reasons: executionReasons,
      freshness: freshnessFromIso(generatedAt, 30_000),
      blocking: params.context === "ops" && (params.degradedRuntimeTruthSources.includes("execution_truth") || params.missingRuntimeTruthSources.includes("execution_truth")),
      repair_hint: executionReasons.length > 0 ? "verify_execution_telemetry_reality_gap_and_mt5_health" : null,
    },
    {
      name: "auth_probe",
      status: params.context !== "ops" ? "skipped" : params.authProbe.status === "pass" ? "available" : params.authProbe.status === "not_authorized" ? "not_authorized" : params.authProbe.status === "schema_not_verified" ? "schema_not_verified" : params.authProbe.status === "not_run" ? "missing" : "degraded",
      detail_status: params.authProbe.method === "service_to_service" && params.authProbe.status === "pass"
        ? "internal_payload_verified"
        : params.authProbe.status,
      degradation_reasons: authReasons,
      freshness: freshnessFromIso(null, null),
      blocking: params.context === "ops" && params.authProbe.status !== "pass",
      repair_hint: params.authProbe.status === "pass" ? null : "run_authenticated_operator_probe_or_internal_service_probe",
    },
  ];

  return {
    schema_version: "runtime-source-degradation-map/v1",
    sources,
  };
}

export async function buildControlledLiveRampGateReport(input: ControlledLiveRampGateBuildInput): Promise<ControlledLiveRampGateReport> {
  const context = input.context;
  const sinceDays = Math.max(1, toNumber(input.sinceDays, 30));
  const currentCleanCycles = Math.max(0, toNumber(input.currentCleanCycles, 0));
  const publicUrl = String(input.publicUrl || "").trim();
  const authProbeUrl = String(input.authProbeUrl || "").trim();
  const authMode = input.authMode === "service" || input.authMode === "cookie" ? input.authMode : "auto";
  const authCookie = String(input.authCookie || "").trim();
  const authToken = String(input.authToken || "").trim();

  const lifecycleReport = input.lifecycleReport || await loadLifecycleReportFromRuntime(sinceDays);
  const terminalDecisionStateDiagnostic = asRecord(lifecycleReport.terminal_decision_state_diagnostic);
  const executionGapDiagnostic = asRecord(lifecycleReport.execution_gap_diagnostic);
  const lifecyclePublishBlocked = Boolean(lifecycleReport.publish_blocked);
  const lifecycleBlockReasons = asStringArray(lifecycleReport.block_reasons);
  const runtimeTruth = await resolveRuntimeTruth(context, input.runtimeTruth);
  const runtimeTruthGate = runtimeTruth.gate;
  const replayGate = buildReplayGate(input.replayArtifact);
  const gatewayPublicHealth = await resolveGatewayPublicHealth(context, publicUrl);
  const publicProbe = await resolvePublicProbe(context, publicUrl);
  const authProbe = await resolveAuthProbe(context, authProbeUrl, authMode, authCookie, authToken);

  const reviewRequired = asRecord(terminalDecisionStateDiagnostic.review_required);
  const reviewRequiredTotal = toNumber(reviewRequired.total, toNumber(terminalDecisionStateDiagnostic.review_required_total, 0));
  const reviewRequiredItems = Array.isArray(reviewRequired.items) ? reviewRequired.items.map((item) => asRecord(item)) : [];
  const historicalApprovalNotRecordedTotal = reviewRequiredItems.filter((item) => String(item.candidate_state || "").trim() === "approval_not_recorded").length;
  const stableReviewRequiredTotal = input.reviewRequiredBaseline === null || input.reviewRequiredBaseline === undefined
    ? null
    : reviewRequiredTotal <= Math.max(0, toNumber(input.reviewRequiredBaseline, 0));

  const stage = resolveControlledLiveRampStage(currentCleanCycles);
  const activeDebt = asRecord(terminalDecisionStateDiagnostic.active_debt);
  const activeDebtTotal = [
    toNumber(activeDebt.hardening_not_reached, 0),
    toNumber(activeDebt.hardening_rejected_without_reason, 0),
    toNumber(activeDebt.approved_without_route, 0),
    toNumber(activeDebt.routed_without_execution_event, 0),
    toNumber(activeDebt.execution_without_outcome, 0),
  ].reduce((sum, value) => sum + value, 0);
  const settlementTruthResolution = await resolveSettlementTruthDiagnostic(context, runtimeTruth.snapshot);
  const settlementTruth = settlementTruthResolution.settlementTruth;
  const settlementSourceContextDiff = buildSettlementSourceContextDiff(context, runtimeTruth.snapshot, settlementTruth, settlementTruthResolution.directProbe);
  const opsRunnerContext = buildOpsRunnerContext(context, settlementSourceContextDiff);
  const runtimeTruthSourceDiagnostics = buildRuntimeTruthSourceDiagnostics(context, runtimeTruth.snapshot, runtimeTruthGate, settlementTruth);
  // Backend authority: when the execution-router observation is online and the
  // matrix degradation is purely capture-derived, the runtime-truth matrix must
  // not be treated as degraded for the gate verdict.
  const backendAuthoritativeCaptureOnly = runtimeTruthSourceDiagnostics.observation_source === "execution_router"
    && runtimeTruthSourceDiagnostics.ui_capture_degraded_sources.includes("runtime_truth_matrix");
  const runtimeTruthMatrix = buildRuntimeTruthMatrixDiagnostic(
    context,
    runtimeTruthGate,
    runtimeTruthSourceDiagnostics.missing_runtime_truth_sources,
    backendAuthoritativeCaptureOnly,
  );
  const runtimeSourceDegradationMap = buildRuntimeSourceDegradationMap({
    context,
    runtimeTruth: runtimeTruth.snapshot,
    runtimeTruthGate,
    runtimeTruthMatrix,
    settlementTruth,
    authProbe,
    missingRuntimeTruthSources: runtimeTruthSourceDiagnostics.missing_runtime_truth_sources,
    degradedRuntimeTruthSources: runtimeTruthSourceDiagnostics.degraded_runtime_truth_sources,
  });
  const busHealth = await buildBusHealthDiagnostic(context, runtimeTruth.snapshot, runtimeTruthGate);
  const legacyWatchdogReconciliation = buildLegacyWatchdogReconciliation(context, busHealth);
  const killSwitch = buildKillSwitchDiagnostics(
    context,
    runtimeTruth.snapshot,
    runtimeTruthGate,
    runtimeTruthSourceDiagnostics.missing_runtime_truth_sources,
    runtimeTruthSourceDiagnostics.degraded_runtime_truth_sources,
    lifecyclePublishBlocked,
    activeDebtTotal,
    executionGapDiagnostic,
    publicProbe,
    replayGate,
    busHealth.verified,
  );
  if (context === "ops" && legacyWatchdogReconciliation.blocks_reset && !killSwitch.reset_blockers.includes("legacy_watchdog_reconciliation_required")) {
    killSwitch.reset_eligible = false;
    killSwitch.reset_blockers = [...killSwitch.reset_blockers, "legacy_watchdog_reconciliation_required"];
  }

  const blockReasons = [
    ...lifecycleBlockReasons,
    ...(context === "ops" && killSwitch.active ? ["kill_switch_active"] : []),
    ...(context === "ops" && runtimeTruthGate.verdict === "BLOCKED" ? runtimeTruthGate.blockers.map((reason) => `runtime_truth:${reason}`) : []),
    ...(context === "ops" && gatewayPublicHealth.available && gatewayPublicHealth.healthy === false ? [`gateway_public_health:${gatewayPublicHealth.summary}`] : []),
    ...(context === "ops" && legacyWatchdogReconciliation.blocks_reset ? [`legacy_watchdog_reconciliation:${legacyWatchdogReconciliation.decision}`] : []),
  ];

  const opsVerdictUnavailableReasons = context === "ops"
    ? dedupe([
      !lifecycleReport ? "lifecycle_publish_gate_unavailable" : null,
      !hasKeys(terminalDecisionStateDiagnostic) ? "terminal_decision_state_diagnostic_unavailable" : null,
      !hasKeys(executionGapDiagnostic) ? "execution_gap_diagnostic_unavailable" : null,
      !replayGate.available ? "replay_certification_gate_unavailable" : null,
      !runtimeTruthGate.available ? "runtime_truth_matrix_unavailable" : null,
      runtimeTruthGate.verdict === "UNAVAILABLE" ? "runtime_truth_unavailable" : null,
      runtimeTruthGate.verdict === "BLOCKED" && runtimeTruthGate.blockers.some((reason) => reason.includes("BLOCKED_BY_DATA")) ? "runtime_truth_partial" : null,
      runtimeTruthGate.verdict === "BLOCKED" && runtimeTruthGate.blockers.some((reason) => reason.includes("BLOCKED_BY_DATA") || reason.includes("NO_DATA_PARTIAL")) ? "control_plane_data_partial" : null,
      runtimeTruthSourceDiagnostics.missing_runtime_truth_sources.length > 0 ? "runtime_truth_sources_missing" : null,
      runtimeTruthSourceDiagnostics.degraded_runtime_truth_sources.length > 0 ? "runtime_truth_sources_degraded" : null,
      settlementTruth.blocking ? "settlement_truth_unavailable" : null,
      !opsRunnerContext.valid ? "ops_runner_context_invalid" : null,
      !settlementSourceContextDiff.ops_context_allowed ? "ops_control_plane_host_local_context" : null,
      runtimeTruthMatrix.status === "missing" ? "runtime_truth_matrix_missing" : null,
      runtimeTruthMatrix.status === "degraded" ? "runtime_truth_matrix_degraded" : null,
      killSwitch.active ? "kill_switch_active" : null,
      publicProbe.status !== "pass" ? "public_gateway_probe_unavailable" : null,
      authProbe.status === "not_run" ? "auth_probe_not_run" : null,
      authProbe.status === "not_authorized" ? "auth_probe_not_authorized" : null,
      authProbe.status === "schema_not_verified" ? "auth_probe_schema_not_verified" : null,
      authProbe.status === "fail" ? "auth_probe_failed" : null,
    ])
    : ["not_applicable_in_ci"];
  const opsVerdictAvailable = context === "ops" && opsVerdictUnavailableReasons.length === 0;
  const observabilityBlockReasons = context === "ops" && !opsVerdictAvailable
    ? opsVerdictUnavailableReasons.map((reason) => `observability:${reason}`)
    : [];
  const effectiveBlockReasons = dedupe([...blockReasons, ...observabilityBlockReasons]);

  const yellowFlags = [
    ...(runtimeTruthGate.available && runtimeTruthGate.verdict === "DEGRADED"
      ? runtimeTruthGate.degraded_reasons.map((reason) => `runtime_truth_degraded:${reason}`)
      : []),
    ...(reviewRequiredTotal > 0 ? [`review_required_total_${reviewRequiredTotal}`] : []),
    ...(historicalApprovalNotRecordedTotal > 0 ? [`historical_approval_not_recorded_total_${historicalApprovalNotRecordedTotal}`] : []),
    ...(replayGate.available && replayGate.ready === false
      ? [`replay_certified_outcomes_${replayGate.certified_total ?? 0}_of_${replayGate.required_total ?? 0}`]
      : []),
    ...(context === "ops" && !gatewayPublicHealth.available ? ["gateway_public_health_unavailable"] : []),
    ...(context === "ops" && authProbe.status === "not_run" ? ["auth_probe_not_run"] : []),
    ...(context === "ops" && authProbe.status === "not_authorized" ? [`auth_probe_not_authorized:${authProbe.observed || authProbe.summary}`] : []),
    ...(context === "ops" && authProbe.status === "schema_not_verified" ? [`auth_probe_schema_not_verified:${authProbe.missing_fields.join(",") || "unknown"}`] : []),
    ...(context === "ops" && authProbe.status === "fail" ? [`auth_probe_failed:${authProbe.observed || authProbe.summary}`] : []),
    ...(context === "ops" && !opsRunnerContext.valid ? [`ops_runner_context_invalid:${opsRunnerContext.repair_hint || "unknown"}`] : []),
    ...(context === "ops" && !settlementSourceContextDiff.ops_context_allowed ? ["ops_control_plane_host_local_context"] : []),
    ...(context === "ci" ? ["runtime_truth_skipped_in_ci", "gateway_public_health_skipped_in_ci"] : []),
    ...(stableReviewRequiredTotal === false ? ["review_required_total_increased_vs_baseline"] : []),
    ...(activeDebtTotal > 0 ? [`active_debt_total_${activeDebtTotal}`] : []),
  ];

  const allowed = effectiveBlockReasons.length === 0 && (context !== "ops" || opsVerdictAvailable);

  return {
    schema_version: "controlled-live-ramp-gate/v2.0",
    generated_at_iso: input.generatedAtIso || new Date().toISOString(),
    context,
    controlled_live_ramp_gate: {
      mode: allowed ? stage.mode : context === "ops" && !opsVerdictAvailable ? "blocked_by_observability" : "halted",
      allowed,
      ops_verdict_available: opsVerdictAvailable,
      ops_verdict_unavailable_reasons: opsVerdictUnavailableReasons,
      max_notional_multiplier: allowed ? stage.maxNotionalMultiplier : 0,
      promotion_target: allowed ? stage.promotionTarget : "micro_live",
      required_clean_cycles: allowed ? stage.requiredCleanCycles : Math.max(stage.requiredCleanCycles, 3),
      current_clean_cycles: currentCleanCycles,
      missing_runtime_truth_sources: runtimeTruthSourceDiagnostics.missing_runtime_truth_sources,
      degraded_runtime_truth_sources: runtimeTruthSourceDiagnostics.degraded_runtime_truth_sources,
      observation_source: runtimeTruthSourceDiagnostics.observation_source,
      ui_capture_status: runtimeTruthSourceDiagnostics.ui_capture_status,
      ui_capture_blocks_live: runtimeTruthSourceDiagnostics.ui_capture_blocks_live,
      ui_capture_degraded_sources: runtimeTruthSourceDiagnostics.ui_capture_degraded_sources,
      backend_bus_seq: runtimeTruthSourceDiagnostics.backend_bus_seq,
      backend_flags: runtimeTruthSourceDiagnostics.backend_flags,
      kill_switch: killSwitch,
      block_reasons: effectiveBlockReasons,
      yellow_flags: yellowFlags,
    },
    lifecycle_publish_gate: {
      publish_blocked: lifecyclePublishBlocked,
      block_reasons: lifecycleBlockReasons,
    },
    terminal_decision_state_diagnostic: terminalDecisionStateDiagnostic,
    execution_gap_diagnostic: executionGapDiagnostic,
    runtime_truth_gate: runtimeTruthGate,
    replay_certification_gate: replayGate,
    gateway_public_health: gatewayPublicHealth,
    public_probe: publicProbe,
    auth_probe: authProbe,
    settlement_truth: settlementTruth,
    settlement_source_context_diff: settlementSourceContextDiff,
    ops_runner_context: opsRunnerContext,
    bus_health: busHealth,
    legacy_watchdog_reconciliation: legacyWatchdogReconciliation,
    runtime_truth_matrix: runtimeTruthMatrix,
    runtime_source_degradation_map: runtimeSourceDegradationMap,
    new_cycle_cleanliness: {
      available: true,
      clean_cycles: currentCleanCycles,
      required_for_next_promotion: stage.requiredCleanCycles,
      stable_review_required_total: stableReviewRequiredTotal,
      summary: currentCleanCycles >= stage.requiredCleanCycles
        ? `clean cycle target met for ${stage.promotionTarget}`
        : `${currentCleanCycles}/${stage.requiredCleanCycles} clean cycles for ${stage.promotionTarget}`,
    },
  };
}
