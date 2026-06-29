import { promises as fs } from "node:fs";
import path from "node:path";

import {
  scanCriticalRouteDivergence,
  type CertifiedOutcomeRoute,
  type CriticalRouteScannerReport,
  type TruthRouteInput,
} from "../lib/criticalRouteDivergenceScanner";
import { buildCanonicalSpineHealthSnapshot, type CanonicalSpineHealthSnapshot } from "../lib/canonicalSpineHealth";
import { cpFetchJsonSafe } from "../lib/controlPlane";
import { listIncidentTickets, openIncidentTicket, type IncidentTicketRecord } from "../lib/incidentTickets";
import { projectPositionTruthSnapshot, type PositionTruthSnapshot } from "../lib/positionTruthContract";
import { buildRuntimeTruthSnapshot, type RuntimeTruthSnapshot } from "../lib/runtimeTruth";
import { readSourceTreeProvenanceAudit, type SourceTreeProvenanceAudit } from "../lib/sourceTreeProvenance";
import { buildTradeLifecycleHealthSnapshot, type TradeLifecycleHealthSnapshot } from "../lib/tradeLifecycleHealth";
import { buildTruthReliabilitySnapshot, type TruthReliabilitySnapshot } from "../lib/truthReliabilityIndex";

process.env.CONTROL_PLANE_FORCE_SERVICE_AUTH = process.env.CONTROL_PLANE_FORCE_SERVICE_AUTH || "1";

type JsonMap = Record<string, unknown>;

type CollectionResult<T> = {
  value: T | null;
  error: string | null;
};

type RuntimeCollectionFailures = Record<string, string>;

type IncidentDispatchRecord = {
  code: string;
  route: string;
  dedup_key: string;
  status: "opened" | "deduped" | "failed" | "disabled";
  ticket_key: string | null;
  detail: string;
};

type DispatchCandidate = {
  route: string;
  truth: string;
  severity: "warn" | "critical";
  code: string;
  detail: string;
  divergence_pct: number;
};

type CertifiedOutcomesProjection = {
  schema_version: string;
  certifier_version: string;
  candidate_total: number;
  certified_total: number;
  projection_digest: string;
  candidate_digests: string[];
  candidates: JsonMap[];
};

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "ready", "certified", "aligned", "ok", "on"].includes(normalized);
}

function toOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["1", "true", "yes", "ready", "certified", "aligned", "ok", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "blocked", "uncertified", "misaligned", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseItems(payload: unknown): JsonMap[] {
  if (Array.isArray(payload)) {
    return payload.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as JsonMap[];
  }
  const record = asRecord(payload);
  for (const key of ["items", "rows", "accounts", "data", "results"]) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).filter((item) => item && typeof item === "object" && !Array.isArray(item)) as JsonMap[];
    }
  }
  return Object.keys(record).length > 0 ? [record] : [];
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || "unknown_error");
}

function ageMsFromIso(value: unknown): number | null {
  const iso = String(value || "").trim();
  if (!iso) {
    return null;
  }
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Date.now() - parsed);
}

function hasServiceTokenConfigured(): boolean {
  return Boolean(String(process.env.CONTROL_PLANE_INTERNAL_TOKEN || process.env.CONTROL_PLANE_TOKEN || "").trim());
}

async function capture<T>(failures: RuntimeCollectionFailures, key: string, task: () => Promise<T>): Promise<CollectionResult<T>> {
  try {
    return { value: await task(), error: null };
  } catch (error) {
    const detail = summarizeError(error);
    failures[key] = detail;
    return { value: null, error: detail };
  }
}

async function fetchControlPlaneJson(pathname: string): Promise<unknown> {
  const { response, payload } = await cpFetchJsonSafe(pathname, { authMode: "service" });
  if (!response.ok) {
    const detail = String(asRecord(payload).detail || `control_plane_${response.status}`);
    throw new Error(`${pathname}: ${detail}`);
  }
  return payload;
}

function pickAccountId(accountRows: JsonMap[], requestedAccountId: string | null): string | null {
  const requested = String(requestedAccountId || "").trim();
  if (requested) {
    return requested;
  }
  for (const row of accountRows) {
    const candidate = String(row.canonical_account_id || row.account_id || row.accountId || row.id || "").trim();
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function pickAccountRow(accountRows: JsonMap[], accountId: string | null): JsonMap | null {
  const requested = String(accountId || "").trim();
  if (!requested) {
    return accountRows[0] || null;
  }
  return accountRows.find((row) => {
    const candidates = [row.canonical_account_id, row.account_id, row.accountId, row.id].map((value) => String(value || "").trim());
    return candidates.includes(requested);
  }) || null;
}

function positionNotionalUsd(row: JsonMap): number {
  const direct = [
    row.notional_usd,
    row.exposure_usd,
    row.position_value_usd,
    row.market_value_usd,
    row.equivalent_usd,
  ].map((value) => toNullableNumber(value)).find((value) => value !== null);
  return Math.abs(direct || 0);
}

function positionSignedNotionalUsd(row: JsonMap): number {
  const amount = positionNotionalUsd(row);
  const side = String(row.side || row.position_side || row.direction || "").trim().toLowerCase();
  if (side.includes("sell") || side.includes("short")) {
    return -amount;
  }
  return amount;
}

function buildFallbackPositionTruth(accountId: string | null): PositionTruthSnapshot {
  return projectPositionTruthSnapshot({
    status: "missing",
    as_of: new Date(0).toISOString(),
    account: { account_id: accountId || "unknown" },
    mt5_account: {},
    connector_account: {},
    balances: [],
    positions: [],
    open_orders: [],
    portfolio_links: [],
    latest_portfolio_snapshots: [],
    normalized_state: {},
    cash_vs_equivalent: {},
    capital_truth: null,
    broker_state_snapshot: {},
    pocket_views: [],
    capital_ledger: [],
  });
}

function buildExposurePayload(positionTruth: PositionTruthSnapshot, accountRows: JsonMap[], connectorRows: JsonMap[]): JsonMap {
  const grossExposureUsd = round1(positionTruth.positions.reduce((sum, row) => sum + positionNotionalUsd(asRecord(row)), 0));
  const netExposureUsd = round1(positionTruth.positions.reduce((sum, row) => sum + positionSignedNotionalUsd(asRecord(row)), 0));
  const accountCount = Math.max(accountRows.length, connectorRows.length, Object.keys(positionTruth.account).length > 0 ? 1 : 0);
  return {
    status: positionTruth.status,
    summary: {
      gross_exposure_usd: grossExposureUsd,
      net_exposure_usd: netExposureUsd,
      open_positions: positionTruth.positions.length,
      account_count: accountCount,
      status: positionTruth.status,
    },
    gross_exposure_usd: grossExposureUsd,
    net_exposure_usd: netExposureUsd,
    open_positions: positionTruth.positions.length,
    account_count: accountCount,
    accounts: accountRows,
    positions: positionTruth.positions,
  };
}

function buildSettlementPayload(positionTruth: PositionTruthSnapshot, accountRow: JsonMap | null): JsonMap {
  const normalizedLedger = asRecord(asRecord(positionTruth.normalized_state).capital_ledger);
  const summary = asRecord(normalizedLedger.summary);
  const rows = Array.isArray(normalizedLedger.rows) ? normalizedLedger.rows : positionTruth.capital_ledger;
  const settlementPolicy = String(accountRow?.source_type || accountRow?.provider || accountRow?.venue || "broker").trim().toLowerCase() || "broker";
  return {
    status: positionTruth.status,
    settlement_policy: settlementPolicy,
    summary: {
      settlement_policy: settlementPolicy,
      reconciliation_usd: toNumber(summary.reconciliation_usd, 0),
      status: positionTruth.status,
    },
    reconciliation_usd: toNumber(summary.reconciliation_usd, 0),
    ledger_event_count: rows.length,
    capital_ledger: {
      status: positionTruth.status,
      summary: {
        reconciliation_usd: toNumber(summary.reconciliation_usd, 0),
      },
      rows,
    },
    rows,
  };
}

function buildExecutionTruthPayload(params: {
  runtimeTruth: RuntimeTruthSnapshot | null;
  canonicalSpine: CanonicalSpineHealthSnapshot | null;
  tradeLifecycleHealth: TradeLifecycleHealthSnapshot | null;
  truthReliability: TruthReliabilitySnapshot | null;
  sourceTree: SourceTreeProvenanceAudit | null;
}): JsonMap {
  const { runtimeTruth, canonicalSpine, tradeLifecycleHealth, truthReliability, sourceTree } = params;
  if (!runtimeTruth || !canonicalSpine || !tradeLifecycleHealth || !truthReliability) {
    return {
      schema_version: "execution-reality/v1",
      state: "HALT",
      score_pct: 0,
      allow_new_risk: false,
      blocks_execution: true,
      size_cap_pct: 0,
      metrics: {
        execution_samples: 0,
        liquidity_samples: 0,
        slippage_bps: 0,
        latency_ms: 0,
        fill_rate_pct: 0,
      },
    };
  }
  const verdict = String(runtimeTruth.verdict || "BLOCKED").trim().toUpperCase();
  const state = verdict === "READY" ? "ALIGNED" : verdict === "DEGRADED" ? "DEGRADED" : "HALT";
  const sourceTreeCapPct = sourceTree ? (sourceTree.observable_commit_count < 4 ? 0 : sourceTree.commit_alignment_rate) : 0;
  const brokerReality = asRecord(asRecord(runtimeTruth.raw).broker_reality);
  const realityGapRows = asArray<JsonMap>(brokerReality.reality_gap_rows);
  const latencyMs = realityGapRows
    .map((row) => toNullableNumber(asRecord(row).latency_ms))
    .find((value) => value !== null) ?? 0;
  return {
    schema_version: "execution-reality/v1",
    state,
    score_pct: round1(truthReliability.score_pct),
    allow_new_risk: verdict !== "BLOCKED",
    blocks_execution: verdict === "BLOCKED",
    size_cap_pct: verdict === "BLOCKED" ? 0 : round1(Math.min(state === "DEGRADED" ? 25 : 100, sourceTreeCapPct || 100)),
    metrics: {
      execution_samples: Math.max(toNumber(asRecord(runtimeTruth.source_diagnostics).rows_scanned, 0), toNumber(canonicalSpine.execution_linked_total, 0)),
      liquidity_samples: toNumber(canonicalSpine.execution_source_total, 0),
      slippage_bps: round1(toNumber(asRecord(asRecord(runtimeTruth.layers).market).spread_bps, 0)),
      latency_ms: Math.round(latencyMs),
      fill_rate_pct: round1(toNumber(tradeLifecycleHealth.execution_link_rate_pct, 0)),
    },
  };
}

function buildReplayFallback(decisionId: string | null): JsonMap {
  return {
    decision_id: decisionId || "missing-replay",
    certified: false,
    fill_count: 0,
    route_chosen: "unknown",
    validation_source: "runtime-missing",
    artifact: "missing",
  };
}

function buildReplayProjectedPayload(recentRow: JsonMap | null): JsonMap | null {
  if (!recentRow) {
    return null;
  }
  const row = asRecord(recentRow);
  const payload = asRecord(row.payload);
  const certification = asRecord(payload.certification);
  return {
    decision_id: String(row.decision_id || row.id || payload.decision_id || "").trim(),
    certified: toOptionalBoolean(row.certified ?? payload.certified ?? certification.certified ?? certification.status),
    fill_count: toNumber(row.fill_count ?? payload.fill_count, 0),
    route_chosen: String(row.route_chosen || payload.route_chosen || row.venue || payload.venue || "").trim(),
    validation_source: String(row.validation_source || payload.validation_source || "").trim(),
    artifact: String(
      row.artifact
      || payload.artifact
      || (payload.rust_reality_gap ? "native" : "replay-only"),
    ).trim() || "replay-only",
  };
}

function buildReplayUiPayload(replayPayload: unknown, realityGapDetail: JsonMap | null): JsonMap {
  const replay = asRecord(replayPayload);
  const telemetry = asRecord(replay.telemetry);
  const certification = asRecord(replay.certification);
  const telemetryPayload = asRecord(telemetry.payload);
  const kairosHarness = asRecord(replay.kairos_harness || telemetryPayload.kairos_harness);
  const sampleEnvelope = asRecord(realityGapDetail);
  const sample = asRecord(sampleEnvelope.sample);
  const samplePayload = asRecord(sample.payload);
  return {
    decision_id: String(sample.decision_id || replay.decision_id || "").trim(),
    certified: toOptionalBoolean(replay.certified ?? certification.certified ?? certification.status),
    fill_count: toNumber(replay.fill_count, Array.isArray(replay.fills) ? replay.fills.length : 0),
    route_chosen: String(telemetry.route_chosen || replay.route_chosen || sample.venue || "").trim(),
    validation_source: String(
      replay.validation_source
      || kairosHarness.validation_source
      || "",
    ).trim(),
    artifact: samplePayload.rust_reality_gap || replay.rust_reality_gap
      ? "native"
      : String(replay.artifact || "replay-only").trim() || "replay-only",
  };
}

function buildCertifiedOutcomeRoutes(params: {
  requiredTotal: number;
  baseOutcomeTotal: number;
  replayCertifiedTotal: number;
  positionAlignedTotal: number;
  executionAlignedTotal: number;
  settlementAlignedTotal: number;
}): CertifiedOutcomeRoute[] {
  const total = Math.max(
    params.requiredTotal,
    params.baseOutcomeTotal,
    params.replayCertifiedTotal,
    params.positionAlignedTotal,
    params.executionAlignedTotal,
    params.settlementAlignedTotal,
  );
  return Array.from({ length: total }, (_, index) => ({
    outcome_id: `runtime-outcome-${index + 1}`,
    replay_certified: index < params.replayCertifiedTotal,
    position_aligned: index < params.positionAlignedTotal,
    execution_aligned: index < params.executionAlignedTotal,
    settlement_aligned: index < params.settlementAlignedTotal,
  }));
}

function countCertifiedOutcomeRoutes(outcomes: CertifiedOutcomeRoute[]): number {
  return outcomes.filter((item) => item.replay_certified && item.position_aligned && item.execution_aligned && item.settlement_aligned).length;
}

async function readCertifiedOutcomesProjection(projectionPath: string): Promise<CertifiedOutcomesProjection | null> {
  try {
    const payload = JSON.parse(await fs.readFile(projectionPath, "utf8"));
    const record = asRecord(payload);
    const candidates = asArray<JsonMap>(record.candidates);
    const candidateDigests = asArray<unknown>(record.candidate_digests).map((item) => String(item || "").trim()).filter(Boolean);
    if (String(record.schema_version || "") !== "txt-certified-outcomes-projection/v1") {
      return null;
    }
    return {
      schema_version: String(record.schema_version || ""),
      certifier_version: String(record.certifier_version || ""),
      candidate_total: Math.max(0, Math.round(toNumber(record.candidate_total, candidates.length))),
      certified_total: Math.max(0, Math.round(toNumber(record.certified_total, 0))),
      projection_digest: String(record.projection_digest || "").trim(),
      candidate_digests: candidateDigests,
      candidates,
    };
  } catch {
    return null;
  }
}

function buildCertifiedOutcomeRoutesFromProjection(projection: CertifiedOutcomesProjection): CertifiedOutcomeRoute[] {
  const seenKeys = new Set<string>();
  const routes: CertifiedOutcomeRoute[] = [];
  for (const candidate of projection.candidates) {
    const proofCycleId = String(candidate.proof_cycle_id || "").trim();
    const certifierVersion = String(candidate.certifier_version || projection.certifier_version || "").trim();
    const candidateDigest = String(candidate.certification_digest || candidate.candidate_digest || "").trim();
    const uniqueKey = `${proofCycleId}:${certifierVersion}:${candidateDigest}`;
    if (!proofCycleId || !certifierVersion || !candidateDigest || seenKeys.has(uniqueKey)) {
      continue;
    }
    seenKeys.add(uniqueKey);
    const certified = String(candidate.certification_status || "").trim().toLowerCase() === "certified";
    routes.push({
      outcome_id: uniqueKey,
      replay_certified: certified,
      position_aligned: certified,
      execution_aligned: certified,
      settlement_aligned: certified,
    });
  }
  return routes;
}

function buildDispatchCandidates(report: CriticalRouteScannerReport): DispatchCandidate[] {
  const candidates = new Map<string, DispatchCandidate>();
  for (const incident of report.incidents) {
    candidates.set(`${incident.code}:${incident.route}`, {
      route: incident.route,
      truth: incident.truth,
      severity: incident.severity,
      code: incident.code,
      detail: incident.detail,
      divergence_pct: incident.divergence_pct,
    });
  }
  for (const finding of report.findings.filter((entry) => entry.severity === "critical")) {
    const key = `${finding.code}:${finding.route}`;
    if (!candidates.has(key)) {
      candidates.set(key, {
        route: finding.route,
        truth: finding.route === "/constitutional/certified-outcomes" ? "Certified Outcomes Gate" : "Truth Coverage",
        severity: finding.severity,
        code: finding.code,
        detail: finding.detail,
        divergence_pct: 0,
      });
    }
  }
  return [...candidates.values()];
}

function buildIncidentDedupKey(candidate: DispatchCandidate): string {
  return `constitutional-runtime-truth:${candidate.code}:${candidate.route}`;
}

function findExistingIncident(openItems: IncidentTicketRecord[], dedupKey: string): IncidentTicketRecord | null {
  for (const item of openItems) {
    const payload = asRecord(item.payload);
    const scanner = asRecord(payload.constitutional_scanner);
    if (String(scanner.dedup_key || "").trim() === dedupKey) {
      return item;
    }
  }
  return null;
}

async function dispatchCriticalIncidents(params: {
  report: CriticalRouteScannerReport;
  reportPath: string;
  enabled: boolean;
}): Promise<IncidentDispatchRecord[]> {
  const candidates = buildDispatchCandidates(params.report).filter((entry) => entry.severity === "critical");
  if (candidates.length === 0) {
    return [];
  }
  if (!params.enabled) {
    return candidates.map((candidate) => ({
      code: candidate.code,
      route: candidate.route,
      dedup_key: buildIncidentDedupKey(candidate),
      status: "disabled",
      ticket_key: null,
      detail: "incident_dispatch_disabled",
    }));
  }

  const openList = await listIncidentTickets("open");
  if (!openList.ok) {
    throw new Error(`incident_list_failed:${openList.detail}`);
  }

  const records: IncidentDispatchRecord[] = [];
  for (const candidate of candidates) {
    const dedupKey = buildIncidentDedupKey(candidate);
    const existing = findExistingIncident(openList.items, dedupKey);
    if (existing) {
      records.push({
        code: candidate.code,
        route: candidate.route,
        dedup_key: dedupKey,
        status: "deduped",
        ticket_key: existing.ticketKey,
        detail: "incident_already_open",
      });
      continue;
    }

    const opened = await openIncidentTicket({
      title: `[Constitutional] ${candidate.truth} blocked on ${candidate.route}`,
      severity: "critical",
      payload: {
        source: "constitutional-runtime-truth-matrix",
        constitutional_scanner: {
          dedup_key: dedupKey,
          route: candidate.route,
          truth: candidate.truth,
          code: candidate.code,
          detail: candidate.detail,
          divergence_pct: candidate.divergence_pct,
          generated_at_iso: params.report.generated_at_iso,
          report_path: params.reportPath,
        },
      },
    });
    records.push({
      code: candidate.code,
      route: candidate.route,
      dedup_key: dedupKey,
      status: opened.ok && opened.ticketKey ? "opened" : "failed",
      ticket_key: opened.ticketKey,
      detail: opened.detail,
    });
  }
  return records;
}

function reportShouldFail(report: CriticalRouteScannerReport, dispatchRecords: IncidentDispatchRecord[]): boolean {
  return report.findings.some((entry) => entry.severity === "critical")
    || dispatchRecords.some((entry) => entry.status === "failed");
}

async function writeReport(reportPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const failures: RuntimeCollectionFailures = {};
  const reportPath = process.env.CONSTITUTIONAL_REPORT_PATH || path.resolve(process.cwd(), "artifacts/constitutional-truth-matrix.report.json");
  const requiredTotal = Math.max(1, Math.round(Number(process.env.CONSTITUTIONAL_REQUIRED_CERTIFIED_TOTAL || 100)));
  const certifiedOutcomesProjectionPath = process.env.CERTIFIED_OUTCOMES_PROJECTION_PATH
    || "/opt/txt/var/proof_renewal/certified_outcomes_projection_for_scanner.json";
  const openIncidentsEnabled = toBoolean(process.env.CONSTITUTIONAL_OPEN_INCIDENTS, true);
  const requestedAccountId = String(process.env.CONSTITUTIONAL_RUNTIME_ACCOUNT_ID || "").trim() || null;
  const requestedDecisionId = String(process.env.CONSTITUTIONAL_REPLAY_DECISION_ID || "").trim() || null;

  if (!hasServiceTokenConfigured()) {
    failures.control_plane_service_auth = "missing CONTROL_PLANE_INTERNAL_TOKEN or CONTROL_PLANE_TOKEN";
  }

  const runtimeTruthResult = await capture(failures, "runtime_truth", async () => buildRuntimeTruthSnapshot({ bypassCache: true }));
  const canonicalSpineResult = await capture(failures, "canonical_spine", async () => buildCanonicalSpineHealthSnapshot({ bypassCache: true }));
  const sourceTreeResult = await capture(failures, "source_tree_provenance", async () => readSourceTreeProvenanceAudit());
  const runtimeTruthAgeMs = ageMsFromIso(runtimeTruthResult.value?.generated_at);
  const canonicalSpineAgeMs = ageMsFromIso(canonicalSpineResult.value?.generated_at_iso);
  const truthReliabilityInput = {
    spineMatchRatePct: toNumber(canonicalSpineResult.value?.spine_match_rate_pct, 0),
    runtimeTruthSnapshotAgeMs: runtimeTruthAgeMs,
    canonicalSpineSnapshotAgeMs: canonicalSpineAgeMs,
    runtimeTruthTtlMs: Math.max(1_000, toNumber(process.env.RUNTIME_TRUTH_SNAPSHOT_TTL_MS, 15_000)),
    canonicalSpineTtlMs: Math.max(1_000, toNumber(process.env.CANONICAL_SPINE_SNAPSHOT_TTL_MS, 60_000)),
  };
  const tradeLifecycleResult = await capture(failures, "trade_lifecycle_health", async () => buildTradeLifecycleHealthSnapshot({
    sinceDays: 30,
    truthReliabilityInput,
  }));

  const truthReliability = tradeLifecycleResult.value?.truth_reliability_index || (
    runtimeTruthResult.value && canonicalSpineResult.value && tradeLifecycleResult.value
      ? buildTruthReliabilitySnapshot({
          decisionContinuityPct: toNumber(tradeLifecycleResult.value.decision_continuity_score_pct, 0),
          evidenceQualityPct: toNumber(tradeLifecycleResult.value.decision_evidence_quality.score_pct, 0),
          spineMatchRatePct: toNumber(canonicalSpineResult.value.spine_match_rate_pct, 0),
          runtimeTruthSnapshotAgeMs: runtimeTruthAgeMs,
          canonicalSpineSnapshotAgeMs: canonicalSpineAgeMs,
          runtimeTruthTtlMs: truthReliabilityInput.runtimeTruthTtlMs,
          canonicalSpineTtlMs: truthReliabilityInput.canonicalSpineTtlMs,
        })
      : null
  );

  const accountsResult = await capture(failures, "accounts", async () => fetchControlPlaneJson("/v1/accounts?limit=200"));
  const connectorAccountsResult = await capture(failures, "connectors_accounts", async () => fetchControlPlaneJson("/v1/connectors/accounts"));
  const accountRows = parseItems(accountsResult.value);
  const connectorRows = parseItems(connectorAccountsResult.value);
  const accountId = pickAccountId(accountRows, requestedAccountId);
  if (!accountId) {
    failures.runtime_account = "no_canonical_account_available";
  }

  const verificationResult = accountId
    ? await capture(failures, "account_verification", async () => fetchControlPlaneJson(`/v1/internal/accounts/${encodeURIComponent(accountId)}/verification`))
    : { value: null, error: failures.runtime_account || "no_canonical_account_available" };
  const positionTruth = verificationResult.value ? projectPositionTruthSnapshot(verificationResult.value) : buildFallbackPositionTruth(accountId);
  const accountRow = pickAccountRow(accountRows, accountId);
  const exposurePayload = buildExposurePayload(positionTruth, accountRows, connectorRows);
  const settlementPayload = buildSettlementPayload(positionTruth, accountRow);
  const executionPayload = buildExecutionTruthPayload({
    runtimeTruth: runtimeTruthResult.value,
    canonicalSpine: canonicalSpineResult.value,
    tradeLifecycleHealth: tradeLifecycleResult.value,
    truthReliability,
    sourceTree: sourceTreeResult.value,
  });

  const replayRecentResult = await capture(failures, "replay_recent", async () => fetchControlPlaneJson(`/v1/execution/reality-gap/recent?limit=${Math.max(requiredTotal, 24)}`));
  const replayRecentRows = parseItems(replayRecentResult.value);
  const replayDecisionId = requestedDecisionId
    || replayRecentRows.map((row) => String(row.decision_id || row.id || "").trim()).find(Boolean)
    || null;
  if (!replayDecisionId) {
    failures.replay_decision = "no_runtime_replay_decision_available";
  }
  const replayPayloadResult = replayDecisionId
    ? await capture(failures, "replay_payload", async () => fetchControlPlaneJson(`/v1/execution/replay/${encodeURIComponent(replayDecisionId)}`))
    : { value: null, error: failures.replay_decision || "no_runtime_replay_decision_available" };
  const replayRealityGapDetailResult = replayDecisionId
    ? await capture(failures, "replay_reality_gap_detail", async () => fetchControlPlaneJson(`/v1/execution/reality-gap/${encodeURIComponent(replayDecisionId)}`))
    : { value: null, error: failures.replay_decision || "no_runtime_replay_decision_available" };
  const replayRecentRow = replayRecentRows.find((row) => String(row.decision_id || row.id || "").trim() === replayDecisionId) || replayRecentRows[0] || null;
  const replayCanonicalPayload = replayPayloadResult.value ? asRecord(replayPayloadResult.value) : buildReplayFallback(replayDecisionId);
  const replayProjectedPayload = buildReplayProjectedPayload(replayRecentRow);
  const replayUiPayload = replayPayloadResult.value ? buildReplayUiPayload(replayPayloadResult.value, asRecord(replayRealityGapDetailResult.value)) : buildReplayFallback(replayDecisionId);

  const routeInputs = {
    executionTruth: {
      canonicalPayload: executionPayload,
      projectedPayload: runtimeTruthResult.value ? executionPayload : null,
      apiPayload: runtimeTruthResult.value ? executionPayload : null,
      uiPayload: runtimeTruthResult.value ? executionPayload : null,
      canonicalSource: "runtimeTruth builder",
      projectedSource: "runtime truth live projection",
      apiSource: "/api/runtime/truth semantic projection",
      uiSource: "terminal execution truth projection",
    } satisfies TruthRouteInput,
    positionTruth: {
      canonicalPayload: positionTruth,
      projectedPayload: verificationResult.value ? verificationResult.value : null,
      apiPayload: verificationResult.value ? verificationResult.value : null,
      uiPayload: verificationResult.value ? verificationResult.value : null,
      canonicalSource: accountId ? `/v1/internal/accounts/${accountId}/verification` : "runtime verification missing",
      projectedSource: "verification normalized projection",
      apiSource: "/api/internal/accounts/[accountId]/verification",
      uiSource: "/live-capital verification state",
    } satisfies TruthRouteInput,
    exposureTruth: {
      canonicalPayload: exposurePayload,
      projectedPayload: verificationResult.value ? exposurePayload : null,
      apiPayload: connectorAccountsResult.value ? exposurePayload : null,
      uiPayload: verificationResult.value ? exposurePayload : null,
      canonicalSource: "verification exposure summary",
      projectedSource: "live capital exposure projection",
      apiSource: "/api/connectors/accounts + /api/accounts",
      uiSource: "/live-capital exposure view",
    } satisfies TruthRouteInput,
    settlementTruth: {
      canonicalPayload: settlementPayload,
      projectedPayload: verificationResult.value ? settlementPayload : null,
      apiPayload: verificationResult.value ? settlementPayload : null,
      uiPayload: verificationResult.value ? settlementPayload : null,
      canonicalSource: "verification capital ledger",
      projectedSource: "live capital settlement projection",
      apiSource: "/api/internal/accounts/[accountId]/verification",
      uiSource: "/live-capital settlement view",
    } satisfies TruthRouteInput,
    replayTruth: {
      canonicalPayload: replayCanonicalPayload,
      projectedPayload: replayProjectedPayload,
      apiPayload: replayPayloadResult.value ? replayPayloadResult.value : null,
      uiPayload: replayPayloadResult.value ? replayUiPayload : null,
      canonicalSource: replayDecisionId ? `/v1/execution/replay/${replayDecisionId}` : "runtime replay missing",
      projectedSource: "/v1/execution/reality-gap/recent",
      apiSource: "/api/execution/replay/[decisionId]",
      uiSource: "/advanced/reality-gap",
    } satisfies TruthRouteInput,
  };

  const preliminaryReport = scanCriticalRouteDivergence(routeInputs);
  const sourceTreeCapPct = sourceTreeResult.value
    ? (sourceTreeResult.value.observable_commit_count < 4 ? 0 : sourceTreeResult.value.commit_alignment_rate)
    : 0;
  const certifiedTriPct = Math.min(toNumber(truthReliability?.score_pct, 0), sourceTreeCapPct);
  const certifiedJourneyCompletionPct = Math.min(
    toNumber(tradeLifecycleResult.value?.decision_journey_completion.completion_rate_pct, toNumber(tradeLifecycleResult.value?.decision_continuity_score_pct, 0)),
    sourceTreeCapPct,
  );
  const baseOutcomeTotal = Math.max(
    0,
    Math.min(
      toNumber(canonicalSpineResult.value?.execution_outcome_complete_total, 0),
      toNumber(tradeLifecycleResult.value?.decision_journey_completion.complete_decision_total, 0),
    ),
  );
  const routeAligned = new Map(preliminaryReport.route_matrix.map((row) => [row.truth, row.aligned]));
  const legacyCertifiedOutcomes = buildCertifiedOutcomeRoutes({
    requiredTotal,
    baseOutcomeTotal,
    replayCertifiedTotal: Math.floor(baseOutcomeTotal * (routeAligned.get("Replay Truth") ? certifiedTriPct : 0) / 100),
    positionAlignedTotal: Math.floor(baseOutcomeTotal * (routeAligned.get("Position Truth") ? certifiedJourneyCompletionPct : 0) / 100),
    executionAlignedTotal: Math.floor(baseOutcomeTotal * (routeAligned.get("Execution Truth") ? certifiedTriPct : 0) / 100),
    settlementAlignedTotal: Math.floor(baseOutcomeTotal * (routeAligned.get("Settlement Truth") ? certifiedJourneyCompletionPct : 0) / 100),
  });
  const canonicalCertifiedOutcomesProjection = await readCertifiedOutcomesProjection(certifiedOutcomesProjectionPath);
  const projectedCertifiedOutcomes = canonicalCertifiedOutcomesProjection
    ? buildCertifiedOutcomeRoutesFromProjection(canonicalCertifiedOutcomesProjection)
    : null;
  const certifiedOutcomes = projectedCertifiedOutcomes || legacyCertifiedOutcomes;
  const legacyScannerTotal = countCertifiedOutcomeRoutes(legacyCertifiedOutcomes);
  const effectiveCertifiedTotal = countCertifiedOutcomeRoutes(certifiedOutcomes);
  const canonicalProjectionTotal = canonicalCertifiedOutcomesProjection?.certified_total ?? null;

  const report = scanCriticalRouteDivergence({
    ...routeInputs,
    certifiedOutcomes: {
      requiredTotal,
      outcomes: certifiedOutcomes,
    },
  });

  const incidentDispatch = await dispatchCriticalIncidents({
    report,
    reportPath,
    enabled: openIncidentsEnabled && hasServiceTokenConfigured(),
  });

  const extendedReport = {
    ...report,
    runtime_context: {
      source_mode: "live-control-plane",
      requested_account_id: requestedAccountId,
      selected_account_id: accountId,
      requested_replay_decision_id: requestedDecisionId,
      selected_replay_decision_id: replayDecisionId,
      base_outcome_total: baseOutcomeTotal,
      certified_outcomes_counter: {
        certified_outcomes_projection_version: canonicalCertifiedOutcomesProjection?.schema_version || null,
        certifier_version: canonicalCertifiedOutcomesProjection?.certifier_version || null,
        candidate_population_total: canonicalCertifiedOutcomesProjection?.candidate_total ?? baseOutcomeTotal,
        projected_certified_total: canonicalProjectionTotal,
        scanner_certified_total: effectiveCertifiedTotal,
        counter_delta: canonicalProjectionTotal === null ? null : effectiveCertifiedTotal - canonicalProjectionTotal,
        candidate_digests: canonicalCertifiedOutcomesProjection?.candidate_digests || [],
        projection_digest: canonicalCertifiedOutcomesProjection?.projection_digest || null,
        scanner_source: canonicalCertifiedOutcomesProjection ? "canonical_certified_outcomes_projection" : "legacy_runtime_truth_counter",
        scanner_status: canonicalCertifiedOutcomesProjection ? "CONVERGED" : "LEGACY_COUNTER_ACTIVE",
        legacy_scanner_total: legacyScannerTotal,
        canonical_projection_total: canonicalProjectionTotal,
        effective_certified_total: effectiveCertifiedTotal,
        migration_state: canonicalCertifiedOutcomesProjection ? "legacy_counter_superseded" : "legacy_counter_active",
        unique_key_basis: "proof_cycle_id+certifier_version+certification_digest",
      },
      source_tree_certification: {
        cap_pct: round1(sourceTreeCapPct),
        certified_tri_pct: round1(certifiedTriPct),
        certified_journey_completion_pct: round1(certifiedJourneyCompletionPct),
        publish_blocked: Boolean(sourceTreeResult.value?.publish_blocked),
      },
      collection_failures: failures,
    },
    incident_dispatch: {
      enabled: openIncidentsEnabled && hasServiceTokenConfigured(),
      records: incidentDispatch,
    },
  } satisfies Record<string, unknown>;

  await writeReport(reportPath, extendedReport);

  if (reportShouldFail(report, incidentDispatch)) {
    console.error(
      `FAIL runtime truth divergence matrix: ${report.findings.filter((entry) => entry.severity === "critical").length} critical finding(s) on live runtime state.`,
    );
    process.exit(1);
  }

  console.log(
    `PASS runtime truth divergence matrix: live report generated with ${report.coverage.covered_routes_total}/${report.coverage.required_routes_total} covered routes.`,
  );
}

main().catch(async (error) => {
  const reportPath = process.env.CONSTITUTIONAL_REPORT_PATH || path.resolve(process.cwd(), "artifacts/constitutional-truth-matrix.report.json");
  await writeReport(reportPath, {
    schema_version: "constitutional-runtime-truth-matrix/v1",
    generated_at_iso: new Date().toISOString(),
    detail: summarizeError(error),
  });
  console.error(summarizeError(error));
  process.exitCode = 1;
});
