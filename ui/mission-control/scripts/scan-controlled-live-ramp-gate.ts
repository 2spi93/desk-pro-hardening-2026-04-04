import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildControlledLiveRampGateReport,
  normalizeControlledLiveRampGateContext,
  toNumber,
  type LifecyclePublishGateReport,
  type ReplayCertificationArtifact,
} from "../lib/controlledLiveRampGate";

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeReport(reportPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const context = normalizeControlledLiveRampGateContext(
    process.env.CONTROLLED_LIVE_GATE_CONTEXT || (process.env.GITHUB_ACTIONS ? "ci" : "ops"),
  );
  const defaultReportName = context === "ci"
    ? "controlled-live-ramp-gate.ci.report.json"
    : "controlled-live-ramp-gate.ops-probe.report.json";
  const reportPath = process.env.CONSTITUTIONAL_REPORT_PATH || path.resolve(rootDir, "artifacts", defaultReportName);
  const legacyReportPath = path.resolve(rootDir, "artifacts/controlled-live-ramp-gate.report.json");
  const lifecycleReportPath = process.env.LIFECYCLE_REPORT_PATH || path.resolve(rootDir, "artifacts/lifecycle-publish-gate.report.json");
  const replayReportPath = process.env.REPLAY_REPORT_PATH || path.resolve(rootDir, "artifacts/replay-certified-outcomes.report.json");
  const reviewRequiredBaseline = process.env.CONTROLLED_LIVE_GATE_REVIEW_REQUIRED_BASELINE;

  const report = await buildControlledLiveRampGateReport({
    context,
    sinceDays: Math.max(1, toNumber(process.env.LIFECYCLE_GATE_SINCE_DAYS, 30)),
    lifecycleReport: await readJsonFile<LifecyclePublishGateReport>(lifecycleReportPath),
    replayArtifact: await readJsonFile<ReplayCertificationArtifact>(replayReportPath),
    publicUrl: String(process.env.CONTROLLED_LIVE_GATE_PUBLIC_URL || "").trim(),
    authProbeUrl: String(process.env.CONTROLLED_LIVE_GATE_AUTH_URL || "").trim(),
    authMode: String(process.env.CONTROLLED_LIVE_GATE_AUTH_MODE || "").trim().toLowerCase() === "service"
      ? "service"
      : String(process.env.CONTROLLED_LIVE_GATE_AUTH_MODE || "").trim().toLowerCase() === "cookie"
        ? "cookie"
        : "auto",
    authCookie: String(process.env.CONTROLLED_LIVE_GATE_AUTH_COOKIE || "").trim(),
    authToken: String(process.env.CONTROLLED_LIVE_GATE_AUTH_TOKEN || "").trim(),
    currentCleanCycles: Math.max(0, toNumber(process.env.CONTROLLED_LIVE_GATE_CURRENT_CLEAN_CYCLES, 0)),
    reviewRequiredBaseline: reviewRequiredBaseline === undefined ? null : Math.max(0, toNumber(reviewRequiredBaseline, 0)),
  });

  await writeReport(reportPath, report as unknown as Record<string, unknown>);
  if (reportPath !== legacyReportPath) {
    await writeReport(legacyReportPath, report as unknown as Record<string, unknown>);
  }

  if (!report.controlled_live_ramp_gate.allowed) {
    console.error(`BLOCK controlled live ramp gate: ${report.controlled_live_ramp_gate.block_reasons.join(" | ") || "unknown_reason"}`);
    process.exit(1);
  }

  console.log(`PASS controlled live ramp gate: ${report.controlled_live_ramp_gate.mode} allowed at x${report.controlled_live_ramp_gate.max_notional_multiplier.toFixed(2)} notional`);
}

main().catch(async (error) => {
  const context = normalizeControlledLiveRampGateContext(process.env.CONTROLLED_LIVE_GATE_CONTEXT || (process.env.GITHUB_ACTIONS ? "ci" : "ops"));
  const defaultReportName = context === "ci"
    ? "controlled-live-ramp-gate.ci.report.json"
    : "controlled-live-ramp-gate.ops-probe.report.json";
  const reportPath = process.env.CONSTITUTIONAL_REPORT_PATH || path.resolve(process.cwd(), "artifacts", defaultReportName);
  const legacyReportPath = path.resolve(process.cwd(), "artifacts/controlled-live-ramp-gate.report.json");
  const payload = {
    schema_version: "controlled-live-ramp-gate/v2.0",
    generated_at_iso: new Date().toISOString(),
    context,
    controlled_live_ramp_gate: {
      mode: "halted",
      allowed: false,
      ops_verdict_available: false,
      ops_verdict_unavailable_reasons: ["scanner_error"],
      max_notional_multiplier: 0,
      promotion_target: "micro_live",
      required_clean_cycles: 3,
      current_clean_cycles: 0,
      missing_runtime_truth_sources: [],
      degraded_runtime_truth_sources: [],
      kill_switch: {
        active: null,
        reason: null,
        last_transition: null,
        reset_eligible: false,
        reset_blockers: ["scanner_error"],
      },
      block_reasons: [error instanceof Error ? error.message : String(error || "unknown_error")],
      yellow_flags: [],
    },
    auth_probe: {
      available: false,
      required: false,
      status: "not_run",
      url: null,
      method: "unauthenticated",
      expected: "200_json_with_controlled_live_ramp_gate",
      observed: null,
      summary: "scanner failed before auth probe",
      expected_schema: [
        "controlled_live_ramp_gate",
        "controlled_live_ramp_gate.controlled_live_ramp_gate",
        "controlled_live_ramp_gate.lifecycle_publish_gate",
        "controlled_live_ramp_gate.terminal_decision_state_diagnostic",
        "controlled_live_ramp_gate.execution_gap_diagnostic",
      ],
      missing_fields: [],
      schema_verified: false,
      token_exposed: false,
    },
    settlement_truth: {
      status: "missing",
      source: null,
      last_seen_at: null,
      expected_contract: "settlement-truth/v1",
      blocking: true,
      repair_hint: "scanner_failed_before_settlement_truth_diagnostic",
    },
    settlement_source_context_diff: {
      schema_version: "settlement-source-context-diff/v1",
      expected_url: "",
      resolved_url: null,
      http_status: null,
      schema_version_observed: null,
      status: null,
      context,
      source_context: "unknown",
      missing_source_reason: "scanner_failed_before_settlement_source_context_diff",
      ops_context_allowed: false,
      repair_hint: "scanner_failed_before_settlement_source_context_diff",
    },
    ops_runner_context: {
      schema_version: "ops-runner-context/v1",
      valid: false,
      network_context: "unknown",
      control_plane_url: String(process.env.CONTROLLED_LIVE_GATE_CONTROL_PLANE_URL || process.env.CONTROL_PLANE_URL || "").trim(),
      required_control_plane_url_present: Boolean(String(process.env.CONTROLLED_LIVE_GATE_CONTROL_PLANE_URL || "").trim()),
      host_local_allowed: false,
      runner_service: String(process.env.CONTROLLED_LIVE_GATE_RUNNER_SERVICE || "").trim() || null,
      repair_hint: "scanner_failed_before_ops_runner_context_diagnostic",
    },
    bus_health: {
      schema_version: "bus-health/v1",
      status: "unverified",
      verified: false,
      observer: "scanner",
      source_context: "unknown",
      checked_url: null,
      http_status: null,
      last_seen_at: null,
      last_event_at: null,
      event_lag_ms: null,
      publisher_status: "unknown",
      consumer_status: "unknown",
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
      repair_hint: "scanner_failed_before_bus_health_diagnostic",
    },
    legacy_watchdog_reconciliation: {
      schema_version: "legacy-watchdog-reconciliation/v2",
      stream: "txt.watchdog",
      expected_publisher: null,
      writer_process_detected: null,
      publisher_last_seen_at: null,
      redis_stream_status: "unknown",
      redis_groups: null,
      redis_last_generated_id: null,
      live_observation_status: "unknown",
      consumer_mode: "unknown",
      reconciliation_mode: "required",
      decision: "recover_legacy_publisher_or_formally_supersede",
      supersession: null,
      blocks_reset: true,
      repair_hint: "scanner_failed_before_legacy_watchdog_reconciliation",
    },
    runtime_truth_matrix: {
      status: "missing",
      coverage: {
        required: 0,
        available: 0,
        missing: [],
      },
      summary: "scanner failed before runtime truth matrix diagnostic",
    },
    runtime_source_degradation_map: {
      schema_version: "runtime-source-degradation-map/v1",
      sources: [
        {
          name: "scanner",
          status: "degraded",
          detail_status: "scanner_error",
          degradation_reasons: ["scanner_error"],
          freshness: {
            last_seen_at: null,
            freshness_ms: null,
            expected_max_staleness_ms: null,
            stale: null,
          },
          blocking: true,
          repair_hint: "inspect_controlled_live_ramp_gate_scanner_error",
        },
      ],
    },
  };
  await writeReport(reportPath, payload);
  if (reportPath !== legacyReportPath) {
    await writeReport(legacyReportPath, payload);
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error || "unknown_error"));
  process.exitCode = 1;
});
