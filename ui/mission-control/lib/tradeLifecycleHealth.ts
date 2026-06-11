import { readApprovalDecisionJournalEntries, type ApprovalDecisionJournalEntry } from "./approvalDecisionJournal";
import { readAllocationDecisionJournalEntries, type AllocationDecisionJournalEntry } from "./allocationDecisionJournal";
import { readAllocationWriterAuditEntries, type AllocationWriterAuditEntry, type AllocationWriterAuditErrorCode } from "./allocationWriterAuditJournal";
import { readExecutionFactJournalEntries, type ExecutionFactJournalEntry } from "./executionFactJournal";
import {
  backfillApprovalDecisionJournalFromCanonicalSource,
  backfillExecutionFactJournalFromCanonicalSource,
} from "./mt5LiveApprovalCanonicalSource";
import { readOpportunityCostJournalEntries, type OpportunityCostJournalEntry } from "./opportunityCostJournal";
import { buildTruthReliabilitySnapshot, type TruthReliabilitySnapshot } from "./truthReliabilityIndex";

type CausalityConfidence = "NATIVE" | "BACKFILLED" | "INFERRED";

type LifecycleAccumulator = {
  lifecycle_key: string;
  trade_lifecycle_id: string | null;
  decision_id: string | null;
  confidence: CausalityConfidence;
  first_observed_at_ms: number | null;
  last_observed_at_ms: number | null;
  allocation_count: number;
  approval_count: number;
  execution_count: number;
  opportunity_count: number;
  has_allocation: boolean;
  has_approval: boolean;
  has_hardening: boolean;
  has_execution: boolean;
  has_outcome: boolean;
  has_attribution: boolean;
  has_opportunity: boolean;
  allocation_confidence: CausalityConfidence | null;
  approval_confidence: CausalityConfidence | null;
  hardening_confidence: CausalityConfidence | null;
  execution_confidence: CausalityConfidence | null;
  outcome_confidence: CausalityConfidence | null;
  attribution_confidence: CausalityConfidence | null;
  opportunity_confidence: CausalityConfidence | null;
  allocation_first_seen_at_ms: number | null;
  approval_first_seen_at_ms: number | null;
  hardening_first_seen_at_ms: number | null;
  execution_first_seen_at_ms: number | null;
  outcome_first_seen_at_ms: number | null;
  attribution_first_seen_at_ms: number | null;
  opportunity_first_seen_at_ms: number | null;
};

type TradeLifecycleHealthLinkConfidenceSummary = {
  native: number;
  backfilled: number;
  inferred: number;
};

type ProjectionSourceDiagnostics = {
  rows_scanned: number;
  rows_returned: number;
};

export type TradeLifecycleHealthSchemaVersion = "trade-lifecycle-health/v1";

export const TRADE_LIFECYCLE_HEALTH_SCHEMA_VERSION: TradeLifecycleHealthSchemaVersion = "trade-lifecycle-health/v1";

type DecisionEvidenceQualityStageKey =
  | "allocation"
  | "approval"
  | "hardening"
  | "execution"
  | "outcome"
  | "attribution"
  | "opportunity";

export type DecisionEvidenceQualityStageSnapshot = {
  stage_key: DecisionEvidenceQualityStageKey;
  label: string;
  native: number;
  backfilled: number;
  inferred: number;
  missing: number;
  score_pct: number;
};

export type DecisionEvidenceQualitySnapshot = {
  score_pct: number;
  native: number;
  backfilled: number;
  inferred: number;
  missing: number;
  by_stage: DecisionEvidenceQualityStageSnapshot[];
};

export type DecisionJourneyCompletionSnapshot = {
  created_decision_total: number;
  complete_decision_total: number;
  incomplete_decision_total: number;
  completion_rate_pct: number;
};

export type DecisionFirstMissingStageKey =
  | "allocation"
  | "approval"
  | "hardening"
  | "execution"
  | "outcome"
  | "attribution"
  | "opportunity";

export type DecisionGapReductionStageSnapshot = {
  stage_key: DecisionFirstMissingStageKey;
  label: string;
  gap_label: string;
  blocked_decision_total: number;
  share_pct: number;
  exemplar_decisions: Array<{
    decision_id: string;
    observed_fragments: number;
  }>;
};

export type DecisionGapReductionSnapshot = {
  incomplete_decision_total: number;
  by_stage: DecisionGapReductionStageSnapshot[];
};

export type DecisionGapLedgerEntry = {
  gap_id: string;
  decision_id: string;
  trade_lifecycle_id: string | null;
  first_missing_stage: DecisionFirstMissingStageKey | null;
  gap_label: string | null;
  status: "open" | "resolved";
  opened_at_iso: string | null;
  resolved_at_iso: string | null;
  resolution_time_hours: number | null;
  open_age_hours: number | null;
  observed_fragments: number;
  root_cause_code: string | null;
  root_cause: string | null;
  remediation: string | null;
};

export type DecisionGapBacklogAgeBucketSnapshot = {
  bucket_key: "0_7d" | "8_30d" | "31_90d" | "90d_plus";
  label: string;
  open_gap_total: number;
  share_pct: number;
};

export type DecisionGapRootCauseSnapshot = {
  root_cause_code: string;
  label: string;
  open_gap_total: number;
  share_pct: number;
};

export type DecisionGapCardinalitySnapshot = {
  gap_occurrence_total: number;
  unique_decision_total: number;
  unique_trade_lifecycle_total: number;
  unique_root_cause_total: number;
  by_root_cause: DecisionGapRootCauseSnapshot[];
};

export type DecisionGapResolutionSnapshot = {
  created_decision_total: number;
  open_gap_total: number;
  resolved_gap_total: number;
  gap_resolution_rate_pct: number;
  mean_time_to_continuity_hours: number | null;
  dominant_open_gap_stage_key: DecisionFirstMissingStageKey | null;
  dominant_open_gap_label: string | null;
  dominant_open_gap_total: number;
  dominant_open_gap_share_pct: number;
  backlog_age_buckets: DecisionGapBacklogAgeBucketSnapshot[];
  oldest_open_gap: DecisionGapLedgerEntry | null;
  dominant_gap_cardinality: DecisionGapCardinalitySnapshot | null;
  dominant_gap_top_decisions: DecisionGapLedgerEntry[];
  recently_resolved_gaps: DecisionGapLedgerEntry[];
  gap_ledger: DecisionGapLedgerEntry[];
};

export type AllocationWriterFailureCategoryKey =
  | "missing_decision_id"
  | "missing_candidate_id"
  | "approval_not_created"
  | "approval_created_but_not_linked"
  | "hardening_block_before_write"
  | "execution_fact_not_created"
  | "outcome_not_created"
  | "attribution_not_created"
  | "opportunity_not_created"
  | "unknown";

export type AllocationWriterStageKey =
  | "allocation"
  | "approval"
  | "hardening"
  | "execution"
  | "outcome"
  | "attribution"
  | "opportunity";

export type AllocationWriterResult = "ok" | "degraded" | "failed";

export type AllocationWriterCoverageSnapshot = {
  allocation_created_total: number | null;
  allocation_persisted_total: number | null;
  allocation_failed_total: number | null;
  allocation_written_total: number;
  allocation_write_rate_pct: number | null;
  created_signal_instrumented: boolean;
  with_decision_id_total: number;
  with_candidate_id_total: number;
  with_trade_lifecycle_id_total: number;
  with_approval_id_total: number;
  decision_id_coverage_pct: number;
  candidate_id_coverage_pct: number;
  trade_lifecycle_id_coverage_pct: number;
  approval_id_seed_rate_pct: number;
};

export type AllocationWriterIdentityPropagationSnapshot = {
  decision_id_total: number;
  candidate_id_total: number;
  trade_lifecycle_id_total: number;
  approval_id_total: number;
  execution_id_total: number;
  outcome_id_total: number;
  identity_propagation_rate_pct: number;
};

export type AllocationWriterPropagationSnapshot = {
  allocation_written_total: number;
  approval_created_total: number;
  execution_fact_total: number;
  downstream_fact_total: number;
  allocation_to_approval_rate_pct: number;
  allocation_to_execution_rate_pct: number;
  allocation_to_any_downstream_rate_pct: number;
};

export type AllocationWriterLatencySnapshot = {
  measured_allocation_total: number;
  measured_to: "first_downstream_fact";
  mean_hours: number | null;
  p50_hours: number | null;
  p95_hours: number | null;
  p99_hours: number | null;
};

export type AllocationWriterFailureCategorySnapshot = {
  category_key: AllocationWriterFailureCategoryKey;
  label: string;
  total: number;
  share_pct: number;
  instrumented: boolean;
};

export type AllocationWriterFailureTaxonomySnapshot = {
  inferred_unknown_total: number;
  by_category: AllocationWriterFailureCategorySnapshot[];
};

export type AllocationWriterClosureEvidenceSnapshot = {
  identified_root_cause_total: number;
  corrected_root_cause_total: number;
  root_cause_closure_rate_pct: number;
  open_gap_total: number;
  closed_gap_total: number;
  gap_closure_rate_pct: number;
  native_failed_allocation_total: number;
  native_closed_allocation_total: number;
  native_closure_rate_pct: number;
  top_cause_key: AllocationWriterFailureCategoryKey | null;
  top_cause_label: string | null;
  top_fix: string | null;
};

export type AllocationWriterProvenanceEntry = {
  allocation_id: string;
  decision_id: string | null;
  writer_version: string;
  writer_timestamp: string;
  writer_result: AllocationWriterResult;
  first_downstream_stage: AllocationWriterStageKey | null;
  first_failure_stage: AllocationWriterStageKey | null;
  failure_reason: AllocationWriterFailureCategoryKey | null;
};

export type AllocationWriterNativeErrorSnapshot = {
  error_code: AllocationWriterAuditErrorCode;
  label: string;
  total: number;
  share_pct: number;
};

export type AllocationWriterStateMachineSnapshot = {
  allocation_created_total: number;
  allocation_persisted_total: number;
  approval_created_total: number;
  approval_linked_total: number;
  hardening_reached_total: number;
  execution_created_total: number;
  outcome_created_total: number;
  attribution_created_total: number;
  opportunity_created_total: number;
  allocation_closed_total: number;
  allocation_open_total: number;
  allocation_closure_rate_pct: number;
};

export type AllocationWriterClosureSnapshot = {
  dominant_root_cause_code: string | null;
  dominant_root_cause_label: string | null;
  writer_coverage: AllocationWriterCoverageSnapshot;
  state_machine: AllocationWriterStateMachineSnapshot;
  identity_propagation: AllocationWriterIdentityPropagationSnapshot;
  writer_propagation: AllocationWriterPropagationSnapshot;
  writer_latency: AllocationWriterLatencySnapshot;
  writer_failure_taxonomy: AllocationWriterFailureTaxonomySnapshot;
  closure_evidence: AllocationWriterClosureEvidenceSnapshot;
  writer_native_errors: AllocationWriterNativeErrorSnapshot[];
  writer_provenance: AllocationWriterProvenanceEntry[];
};

export type DecisionGovernanceProgramKey =
  | "allocation_writer_closure"
  | "decision_journey_completion"
  | "evidence_conversion"
  | "governed_scaling";

export type DecisionGovernanceFreezeKey =
  | "alpha_v2"
  | "llm_trader"
  | "memory_engine"
  | "strategy_expansion"
  | "new_signals"
  | "new_predictors";

export type DecisionGovernanceFreezeControl = {
  key: DecisionGovernanceFreezeKey;
  label: string;
  frozen: boolean;
  reason: string;
};

export type DecisionGovernanceSnapshot = {
  system_name: "Decision Governance System";
  active_program_key: DecisionGovernanceProgramKey;
  active_program_label: string;
  active_program_reason: string;
  north_star: {
    primary_kpi_key: "decision_journey_completion_rate_pct";
    secondary_kpi_key: "native_evidence_coverage_pct";
    tertiary_kpi_key: "root_cause_concentration_pct";
    tri_role: "indicator";
  };
  decision_journey_completion_rate_pct: number;
  native_evidence_coverage_pct: number;
  root_cause_concentration_pct: number;
  root_cause_closure_rate_pct: number;
  scaling_blocked: boolean;
  allocation_writer_program: {
    active: boolean;
    dominant_root_cause_code: string | null;
    dominant_root_cause_label: string | null;
    open_gap_total: number;
    current_occurrence_total: number;
    next_occurrence_target_total: number;
    allocation_created_total: number | null;
    allocation_persisted_total: number | null;
    allocation_failed_total: number | null;
    identity_propagation_rate_pct: number;
    writer_native_error_totals: Record<AllocationWriterAuditErrorCode, number>;
  };
  journey_program: {
    eligible: boolean;
    created_decision_total: number;
    complete_decision_total: number;
    incomplete_decision_total: number;
    completion_rate_pct: number;
  };
  evidence_program: {
    eligible: boolean;
    native: number;
    backfilled: number;
    inferred: number;
    missing: number;
    native_coverage_pct: number;
  };
  freeze_controls: DecisionGovernanceFreezeControl[];
};

export type DecisionContinuityState = CausalityConfidence | "MISSING";

export type DecisionContinuityLinkSnapshot = {
  link_key: string;
  label: string;
  native: number;
  backfilled: number;
  inferred: number;
  missing: number;
  continuity_score_pct: number;
};

export type DecisionFrictionDecisionRow = {
  decision_id: string;
  trade_lifecycle_id: string | null;
  gate_name: string;
  blocked_count: number;
  unique_correlation_keys: number;
  pending_count: number;
  scored_count: number;
  predicted_alpha_bps_total: number;
  predicted_alpha_bps_avg: number;
  opportunity_cost_bps_total: number;
  missed_alpha_bps_total: number;
  capital_impact_usd_total: number;
  last_created_at_iso: string | null;
};

export type DecisionFrictionGateRow = {
  gate_name: string;
  blocked_count: number;
  unique_decision_count: number;
  repeated_decision_count: number;
  predicted_alpha_bps_total: number;
  opportunity_cost_bps_total: number;
  missed_alpha_bps_total: number;
  capital_impact_usd_total: number;
  capital_impact_per_decision: number;
};

export type DecisionFrictionWatchlistGateRow = {
  gate_name: string;
  blocked_total: number;
  unique_decision_total: number;
  repeated_decision_total: number;
  blocked_share_pct: number;
};

export type DecisionFrictionAnalyticsSnapshot = {
  generated_at_iso: string;
  window_days: number;
  blocked_total: number;
  unique_decision_total: number;
  repeated_decision_total: number;
  repeated_blocked_total: number;
  repeated_blocked_share_pct: number;
  opportunity_cost_bps_total: number;
  missed_alpha_bps_total: number;
  capital_impact_usd_total: number;
  capital_impact_per_decision: number;
  capital_impact_coverage_pct: number;
  capital_basis_available_rows: number;
  capital_basis_missing_rows: number;
  dominant_gate_name: string | null;
  dominant_gate_blocked_total: number;
  dominant_gate_share_pct: number;
  dominant_cost_gate_name: string | null;
  dominant_cost_gate_capital_impact_usd: number;
  dominant_decision_id: string | null;
  dominant_decision_gate_name: string | null;
  dominant_decision_blocked_total: number;
  dominant_decision_share_pct: number;
  dominant_cost_decision_id: string | null;
  dominant_cost_decision_gate_name: string | null;
  dominant_cost_decision_opportunity_cost_bps: number;
  dominant_cost_decision_missed_alpha_bps: number;
  dominant_cost_decision_capital_impact_usd: number;
  watchlist_gates: DecisionFrictionWatchlistGateRow[];
  top_decisions: DecisionFrictionDecisionRow[];
  top_gates: DecisionFrictionGateRow[];
  top_cost_decisions: DecisionFrictionDecisionRow[];
  top_cost_gates: DecisionFrictionGateRow[];
};

export type ExecutionGapDiagnosticFamilyKey =
  | "never_routed"
  | "routed_but_not_persisted"
  | "persisted_elsewhere_not_linked"
  | "unknown";

export type ExecutionGapDiagnosticDecisionRow = {
  decision_id: string;
  trade_lifecycle_id: string | null;
  first_missing_stage: DecisionFirstMissingStageKey | null;
  hardening_state: string | null;
  approval_id: string | null;
  route_intent_id: string | null;
  execution_order_id: string | null;
  execution_event_id: string | null;
  outcome_id: string | null;
  writer_source: string | null;
  last_transition: string | null;
  missing_transition: string | null;
  writer_failure_reason: string | null;
  writer_family_key: ExecutionGapDiagnosticFamilyKey | null;
  writer_family_label: string | null;
};

export type ExecutionGapDiagnosticFamilySnapshot = {
  family_key: ExecutionGapDiagnosticFamilyKey;
  label: string;
  decision_total: number;
  share_pct: number;
  example_decision_ids: string[];
};

export type ExecutionGapDiagnosticFieldKey =
  | "hardening_state"
  | "approval_id"
  | "route_intent_id"
  | "execution_order_id"
  | "execution_event_id"
  | "outcome_id"
  | "writer_source"
  | "last_transition";

export type ExecutionGapDiagnosticFieldCoverageSnapshot = {
  field_key: ExecutionGapDiagnosticFieldKey;
  complete_present_total: number;
  blocked_present_total: number;
  complete_present_rate_pct: number;
  blocked_present_rate_pct: number;
  coverage_gap_pct: number;
};

export type ExecutionGapDiagnosticSnapshot = {
  comparison_goal: "execution_writer_divergence";
  complete_definition: "execution_and_outcome_present";
  blocked_definition: "hardening_present_execution_missing";
  complete_decision_total: number;
  blocked_decision_total: number;
  dominant_divergence_field: ExecutionGapDiagnosticFieldKey | null;
  field_coverage: ExecutionGapDiagnosticFieldCoverageSnapshot[];
  blocked_family_breakdown: ExecutionGapDiagnosticFamilySnapshot[];
  complete_decisions: ExecutionGapDiagnosticDecisionRow[];
  blocked_decisions: ExecutionGapDiagnosticDecisionRow[];
};

export type TerminalDecisionClosedStateSnapshot = {
  cancelled: number;
  stale_cancelled: number;
  rejected: number;
  hardening_rejected: number;
  expired: number;
};

export type TerminalDecisionActiveDebtSnapshot = {
  hardening_not_reached: number;
  hardening_rejected_without_reason: number;
  approved_without_route: number;
  routed_without_execution_event: number;
  execution_without_outcome: number;
};

export type TerminalDecisionReviewCandidateStateKey =
  | "allocation_not_recorded"
  | "approval_not_recorded"
  | "completed_pending_attribution"
  | "completed_pending_opportunity"
  | "decision_id_missing"
  | "unclassified";

export type TerminalDecisionReviewRequiredItem = {
  decision_id: string | null;
  reason: string;
  candidate_state: TerminalDecisionReviewCandidateStateKey;
  missing_evidence: string[];
  first_missing_stage: DecisionFirstMissingStageKey | null;
  blocks_publish: boolean;
};

export type TerminalDecisionReviewRequiredSnapshot = {
  total: number;
  blocking_total: number;
  items: TerminalDecisionReviewRequiredItem[];
};

export type TerminalDecisionStateDiagnosticSnapshot = {
  total: number;
  completed_journey_total: number;
  terminal_closed: TerminalDecisionClosedStateSnapshot;
  active_debt: TerminalDecisionActiveDebtSnapshot;
  active_debt_reasons: string[];
  review_required_total: number;
  review_required: TerminalDecisionReviewRequiredSnapshot;
  publish_blocked: boolean;
  publish_block_reasons: string[];
};

export type TradeLifecycleHealthSnapshot = {
  schema_version: TradeLifecycleHealthSchemaVersion;
  generated_at_iso: string;
  window_days: number;
  source_diagnostics: ProjectionSourceDiagnostics;
  lifecycle_total: number;
  decision_journey_completion: DecisionJourneyCompletionSnapshot;
  decision_gap_reduction: DecisionGapReductionSnapshot;
  decision_gap_resolution: DecisionGapResolutionSnapshot;
  allocation_writer_closure: AllocationWriterClosureSnapshot;
  execution_gap_diagnostic?: ExecutionGapDiagnosticSnapshot;
  terminal_decision_state_diagnostic?: TerminalDecisionStateDiagnosticSnapshot;
  decision_governance?: DecisionGovernanceSnapshot;
  link_coverage_score_pct: number;
  decision_continuity_score_pct: number;
  decision_evidence_quality: DecisionEvidenceQualitySnapshot;
  cross_object_lifecycle_total: number;
  allocation_link_rate_pct: number;
  approval_link_rate_pct: number;
  hardening_link_rate_pct: number;
  execution_link_rate_pct: number;
  outcome_link_rate_pct: number;
  attribution_link_rate_pct: number;
  opportunity_link_rate_pct: number;
  allocation_linked_total: number;
  approval_linked_total: number;
  hardening_linked_total: number;
  execution_linked_total: number;
  outcome_linked_total: number;
  attribution_linked_total: number;
  opportunity_linked_total: number;
  causality_confidence: TradeLifecycleHealthLinkConfidenceSummary;
  link_confidence: {
    allocation: TradeLifecycleHealthLinkConfidenceSummary;
    approval: TradeLifecycleHealthLinkConfidenceSummary;
    hardening: TradeLifecycleHealthLinkConfidenceSummary;
    execution: TradeLifecycleHealthLinkConfidenceSummary;
    outcome: TradeLifecycleHealthLinkConfidenceSummary;
    attribution: TradeLifecycleHealthLinkConfidenceSummary;
    opportunity: TradeLifecycleHealthLinkConfidenceSummary;
  };
  decision_continuity_links: DecisionContinuityLinkSnapshot[];
  top_decision_friction: DecisionFrictionDecisionRow[];
  top_friction_by_gate: DecisionFrictionGateRow[];
  decision_friction: DecisionFrictionAnalyticsSnapshot;
  tri_score: number;
  tri_status: TruthReliabilitySnapshot["status"];
  tri_cap: number | null;
  tri_continuity: number;
  tri_evidence: number;
  tri_spine_match: number;
  tri_freshness: number;
  truth_reliability_index: TruthReliabilitySnapshot;
};

export function assertTradeLifecycleHealthSnapshot(snapshot: TradeLifecycleHealthSnapshot): TradeLifecycleHealthSnapshot {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("TradeLifecycleHealth snapshot unavailable (projection timed out or failed)");
  }
  const diagnostics = snapshot.source_diagnostics || { rows_scanned: 0, rows_returned: 0 };
  const numericFields = [
    snapshot.window_days,
    snapshot.lifecycle_total,
    snapshot.link_coverage_score_pct,
    snapshot.decision_continuity_score_pct,
    snapshot.cross_object_lifecycle_total,
    snapshot.tri_score,
    snapshot.tri_continuity,
    snapshot.tri_evidence,
    snapshot.tri_spine_match,
    snapshot.tri_freshness,
    diagnostics.rows_scanned,
    diagnostics.rows_returned,
  ];
  if (snapshot.schema_version !== TRADE_LIFECYCLE_HEALTH_SCHEMA_VERSION) {
    throw new Error(`TradeLifecycleHealth schema mismatch: ${String(snapshot.schema_version || "missing")}`);
  }
  if (!Number.isFinite(Date.parse(String(snapshot.generated_at_iso || "")))) {
    throw new Error("TradeLifecycleHealth generated_at_iso invalid");
  }
  if (numericFields.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) {
    throw new Error("TradeLifecycleHealth numeric metrics invalid");
  }
  if (!Array.isArray(snapshot.decision_continuity_links) || !Array.isArray(snapshot.top_decision_friction)) {
    throw new Error("TradeLifecycleHealth arrays invalid");
  }
  return snapshot;
}

export type TradeLifecycleHealthSnapshotOptions = {
  sinceDays?: number;
  truthReliabilityInput?: {
    spineMatchRatePct: number;
    runtimeTruthSnapshotAgeMs: number | null;
    canonicalSpineSnapshotAgeMs: number | null;
    runtimeTruthTtlMs: number;
    canonicalSpineTtlMs: number;
  };
};

const DECISION_GAP_STAGE_DEFINITIONS: Array<{
  stage_key: DecisionFirstMissingStageKey;
  label: string;
  gap_label: string;
  root_cause: string;
  remediation: string;
}> = [
  {
    stage_key: "allocation",
    label: "Allocation",
    gap_label: "Creation -> Allocation",
    root_cause: "Allocation evidence missing after decision creation.",
    remediation: "Emit or backfill allocation journal evidence before downstream stages consume the decision.",
  },
  {
    stage_key: "approval",
    label: "Approval",
    gap_label: "Allocation -> Approval",
    root_cause: "Approval evidence missing after allocation.",
    remediation: "Instrument approval facts and preserve allocation-to-approval identifiers through the handoff.",
  },
  {
    stage_key: "hardening",
    label: "Hardening",
    gap_label: "Approval -> Hardening",
    root_cause: "Hardening payload missing after approval.",
    remediation: "Persist hardening context on approved decisions before execution is allowed to proceed.",
  },
  {
    stage_key: "execution",
    label: "Execution",
    gap_label: "Hardening -> Execution",
    root_cause: "Execution fact missing after a hardened approval.",
    remediation: "Close the approval-to-execution write path and guarantee execution facts for each approved decision.",
  },
  {
    stage_key: "outcome",
    label: "Outcome",
    gap_label: "Execution -> Outcome",
    root_cause: "Outcome evidence missing after execution.",
    remediation: "Publish fill and outcome facts with stable lifecycle identifiers as soon as execution completes.",
  },
  {
    stage_key: "attribution",
    label: "Attribution",
    gap_label: "Outcome -> Attribution",
    root_cause: "Attribution evidence missing after outcome capture.",
    remediation: "Run attribution computation on completed outcomes and persist the resulting evidence in the execution fact journal.",
  },
  {
    stage_key: "opportunity",
    label: "Opportunity",
    gap_label: "Attribution -> Opportunity",
    root_cause: "Opportunity evidence missing after attribution.",
    remediation: "Append opportunity cost evidence once attribution is computed so the decision journey closes end-to-end.",
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asPercent(numerator: number, denominator: number): number {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;
}

function average(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return 0;
  }
  return Number((filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(1));
}

function percentile(values: number[], ratio: number): number | null {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (filtered.length === 0) {
    return null;
  }
  const index = Math.min(filtered.length - 1, Math.max(0, Math.ceil(filtered.length * ratio) - 1));
  return Number(filtered[index].toFixed(1));
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(value: number | null): string | null {
  return value !== null ? new Date(value).toISOString() : null;
}

function toHours(valueMs: number | null): number | null {
  if (valueMs === null || valueMs < 0) {
    return null;
  }
  return Number((valueMs / 3_600_000).toFixed(1));
}

function toNonEmptyString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized.length > 0 ? normalized : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = toNonEmptyString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function pickLatestEntry<T>(entries: T[], getTimestampMs: (entry: T) => number | null): T | null {
  let latestEntry: T | null = null;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const timestampMs = getTimestampMs(entry) ?? Number.NEGATIVE_INFINITY;
    if (!latestEntry || timestampMs >= latestTimestampMs) {
      latestEntry = entry;
      latestTimestampMs = timestampMs;
    }
  }
  return latestEntry;
}

const OPPORTUNITY_CAPITAL_BASIS_KEYS = [
  "matched_fact_notional_usd",
  "filled_notional_usd",
  "target_notional_usd",
  "requested_notional_usd",
  "estimated_notional_usd",
  "executed_notional_usd",
  "effective_notional_usd",
  "notional_usd",
] as const;

function findNestedNumericValue(value: unknown, candidateKeys: readonly string[], depth = 0): number | null {
  if (depth > 3) {
    return null;
  }
  const record = asRecord(value);
  for (const key of candidateKeys) {
    const numeric = toNumberOrNull(record[key]);
    if (numeric !== null && Math.abs(numeric) > 1e-9) {
      return Math.abs(numeric);
    }
  }
  for (const nestedValue of Object.values(record)) {
    const nestedNumeric = findNestedNumericValue(nestedValue, candidateKeys, depth + 1);
    if (nestedNumeric !== null) {
      return nestedNumeric;
    }
  }
  return null;
}

function resolveOpportunityCapitalBasisUsd(entry: OpportunityCostJournalEntry): number | null {
  return findNestedNumericValue(entry.approval_context, OPPORTUNITY_CAPITAL_BASIS_KEYS)
    ?? findNestedNumericValue(entry.market_context, OPPORTUNITY_CAPITAL_BASIS_KEYS);
}

function computeOpportunityCapitalImpactUsd(entry: OpportunityCostJournalEntry): number {
  const capitalBasisUsd = resolveOpportunityCapitalBasisUsd(entry);
  const missedAlphaBps = toNumberOrNull(entry.opportunity_attribution.missed_alpha_bps)
    ?? Math.max(toNumberOrNull(entry.ex_post_opportunity_cost_bps) || 0, 0);
  if (capitalBasisUsd === null || missedAlphaBps <= 0) {
    return 0;
  }
  return (capitalBasisUsd * missedAlphaBps) / 10_000;
}

function computeCapitalImpactPerDecision(capitalImpactUsdTotal: number, uniqueDecisionCount: number): number {
  if (uniqueDecisionCount <= 0) {
    return 0;
  }
  return Number((capitalImpactUsdTotal / uniqueDecisionCount).toFixed(2));
}

function hasExecutionOutcomePayload(entry: ExecutionFactJournalEntry): boolean {
  return entry.outcome_id !== null
    || entry.decision_outcome !== null
    || toNumberOrNull(entry.alpha_attribution.pnl_usd) !== null
    || toNumberOrNull(entry.avg_fill_price) !== null
    || toNumberOrNull(entry.filled_notional_usd) !== null
    || entry.filled_at_iso !== null;
}

function isAttributionComputed(entry: ExecutionFactJournalEntry): boolean {
  return entry.alpha_attribution.status === "computed"
    && toNumberOrNull(entry.alpha_attribution.regime_contribution_usd) !== null
    && toNumberOrNull(entry.alpha_attribution.signal_contribution_usd) !== null
    && toNumberOrNull(entry.alpha_attribution.execution_contribution_usd) !== null;
}

function normalizeCausalityConfidence(value: unknown, hasTradeLifecycleId: boolean): CausalityConfidence {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "NATIVE" || normalized === "BACKFILLED" || normalized === "INFERRED") {
    return normalized;
  }
  return hasTradeLifecycleId ? "NATIVE" : "INFERRED";
}

function preferredConfidence(current: CausalityConfidence, next: CausalityConfidence): CausalityConfidence {
  const rank: Record<CausalityConfidence, number> = {
    NATIVE: 3,
    BACKFILLED: 2,
    INFERRED: 1,
  };
  return rank[next] > rank[current] ? next : current;
}

function initializeConfidenceSummary(): TradeLifecycleHealthLinkConfidenceSummary {
  return { native: 0, backfilled: 0, inferred: 0 };
}

function incrementConfidence(summary: TradeLifecycleHealthLinkConfidenceSummary, confidence: CausalityConfidence | null): void {
  if (!confidence) {
    return;
  }
  if (confidence === "NATIVE") {
    summary.native += 1;
    return;
  }
  if (confidence === "BACKFILLED") {
    summary.backfilled += 1;
    return;
  }
  summary.inferred += 1;
}

function continuityStateWeight(state: DecisionContinuityState): number {
  if (state === "NATIVE") {
    return 100;
  }
  if (state === "BACKFILLED") {
    return 70;
  }
  if (state === "INFERRED") {
    return 40;
  }
  return 0;
}

function weakestConfidence(left: CausalityConfidence, right: CausalityConfidence): CausalityConfidence {
  const rank: Record<CausalityConfidence, number> = {
    NATIVE: 3,
    BACKFILLED: 2,
    INFERRED: 1,
  };
  return rank[left] <= rank[right] ? left : right;
}

function resolveDecisionContinuityState(
  sourcePresent: boolean,
  sourceConfidence: CausalityConfidence | null,
  targetPresent: boolean,
  targetConfidence: CausalityConfidence | null,
): DecisionContinuityState {
  if (!sourcePresent || !targetPresent || !sourceConfidence || !targetConfidence) {
    return "MISSING";
  }
  return weakestConfidence(sourceConfidence, targetConfidence);
}

function buildDecisionContinuityLinks(lifecycles: LifecycleAccumulator[]): DecisionContinuityLinkSnapshot[] {
  const linkDefinitions = [
    {
      link_key: "allocation_to_approval",
      label: "Allocation -> Approval",
      sourcePresent: (entry: LifecycleAccumulator) => entry.has_allocation,
      sourceConfidence: (entry: LifecycleAccumulator) => entry.allocation_confidence,
      targetPresent: (entry: LifecycleAccumulator) => entry.has_approval,
      targetConfidence: (entry: LifecycleAccumulator) => entry.approval_confidence,
    },
    {
      link_key: "approval_to_hardening",
      label: "Approval -> Hardening",
      sourcePresent: (entry: LifecycleAccumulator) => entry.has_approval,
      sourceConfidence: (entry: LifecycleAccumulator) => entry.approval_confidence,
      targetPresent: (entry: LifecycleAccumulator) => entry.has_hardening,
      targetConfidence: (entry: LifecycleAccumulator) => entry.hardening_confidence,
    },
    {
      link_key: "approval_to_execution",
      label: "Approval -> Execution",
      sourcePresent: (entry: LifecycleAccumulator) => entry.has_approval,
      sourceConfidence: (entry: LifecycleAccumulator) => entry.approval_confidence,
      targetPresent: (entry: LifecycleAccumulator) => entry.has_execution,
      targetConfidence: (entry: LifecycleAccumulator) => entry.execution_confidence,
    },
    {
      link_key: "execution_to_outcome",
      label: "Execution -> Outcome",
      sourcePresent: (entry: LifecycleAccumulator) => entry.has_execution,
      sourceConfidence: (entry: LifecycleAccumulator) => entry.execution_confidence,
      targetPresent: (entry: LifecycleAccumulator) => entry.has_outcome,
      targetConfidence: (entry: LifecycleAccumulator) => entry.outcome_confidence,
    },
    {
      link_key: "outcome_to_attribution",
      label: "Outcome -> Attribution",
      sourcePresent: (entry: LifecycleAccumulator) => entry.has_outcome,
      sourceConfidence: (entry: LifecycleAccumulator) => entry.outcome_confidence,
      targetPresent: (entry: LifecycleAccumulator) => entry.has_attribution,
      targetConfidence: (entry: LifecycleAccumulator) => entry.attribution_confidence,
    },
    {
      link_key: "attribution_to_opportunity",
      label: "Attribution -> Opportunity",
      sourcePresent: (entry: LifecycleAccumulator) => entry.has_attribution,
      sourceConfidence: (entry: LifecycleAccumulator) => entry.attribution_confidence,
      targetPresent: (entry: LifecycleAccumulator) => entry.has_opportunity,
      targetConfidence: (entry: LifecycleAccumulator) => entry.opportunity_confidence,
    },
  ];

  return linkDefinitions.map((definition) => {
    let native = 0;
    let backfilled = 0;
    let inferred = 0;
    let missing = 0;
    for (const lifecycle of lifecycles) {
      const state = resolveDecisionContinuityState(
        definition.sourcePresent(lifecycle),
        definition.sourceConfidence(lifecycle),
        definition.targetPresent(lifecycle),
        definition.targetConfidence(lifecycle),
      );
      if (state === "NATIVE") {
        native += 1;
      } else if (state === "BACKFILLED") {
        backfilled += 1;
      } else if (state === "INFERRED") {
        inferred += 1;
      } else {
        missing += 1;
      }
    }
    const total = native + backfilled + inferred + missing;
    const weightedScore = total > 0
      ? ((native * continuityStateWeight("NATIVE"))
        + (backfilled * continuityStateWeight("BACKFILLED"))
        + (inferred * continuityStateWeight("INFERRED"))) / total
      : 0;
    return {
      link_key: definition.link_key,
      label: definition.label,
      native,
      backfilled,
      inferred,
      missing,
      continuity_score_pct: Number(weightedScore.toFixed(1)),
    };
  });
}

function evidenceQualityWeight(confidence: CausalityConfidence | null): number {
  if (confidence === "NATIVE") {
    return 100;
  }
  if (confidence === "BACKFILLED") {
    return 75;
  }
  if (confidence === "INFERRED") {
    return 50;
  }
  return 0;
}

function buildDecisionEvidenceQualitySnapshot(lifecycles: LifecycleAccumulator[]): DecisionEvidenceQualitySnapshot {
  const stageDefinitions: Array<{
    stage_key: DecisionEvidenceQualityStageKey;
    label: string;
    present: (entry: LifecycleAccumulator) => boolean;
    confidence: (entry: LifecycleAccumulator) => CausalityConfidence | null;
  }> = [
    {
      stage_key: "allocation",
      label: "Allocation",
      present: (entry) => entry.has_allocation,
      confidence: (entry) => entry.allocation_confidence,
    },
    {
      stage_key: "approval",
      label: "Approval",
      present: (entry) => entry.has_approval,
      confidence: (entry) => entry.approval_confidence,
    },
    {
      stage_key: "hardening",
      label: "Hardening",
      present: (entry) => entry.has_hardening,
      confidence: (entry) => entry.hardening_confidence,
    },
    {
      stage_key: "execution",
      label: "Execution",
      present: (entry) => entry.has_execution,
      confidence: (entry) => entry.execution_confidence,
    },
    {
      stage_key: "outcome",
      label: "Outcome",
      present: (entry) => entry.has_outcome,
      confidence: (entry) => entry.outcome_confidence,
    },
    {
      stage_key: "attribution",
      label: "Attribution",
      present: (entry) => entry.has_attribution,
      confidence: (entry) => entry.attribution_confidence,
    },
    {
      stage_key: "opportunity",
      label: "Opportunity",
      present: (entry) => entry.has_opportunity,
      confidence: (entry) => entry.opportunity_confidence,
    },
  ];

  let native = 0;
  let backfilled = 0;
  let inferred = 0;
  let missing = 0;

  const byStage = stageDefinitions.map((definition) => {
    let stageNative = 0;
    let stageBackfilled = 0;
    let stageInferred = 0;
    let stageMissing = 0;

    for (const lifecycle of lifecycles) {
      const confidence = definition.present(lifecycle) ? definition.confidence(lifecycle) : null;
      if (confidence === "NATIVE") {
        stageNative += 1;
        native += 1;
        continue;
      }
      if (confidence === "BACKFILLED") {
        stageBackfilled += 1;
        backfilled += 1;
        continue;
      }
      if (confidence === "INFERRED") {
        stageInferred += 1;
        inferred += 1;
        continue;
      }
      stageMissing += 1;
      missing += 1;
    }

    const stageTotal = stageNative + stageBackfilled + stageInferred + stageMissing;
    const stageWeightedScore = (stageNative * 100) + (stageBackfilled * 75) + (stageInferred * 50);

    return {
      stage_key: definition.stage_key,
      label: definition.label,
      native: stageNative,
      backfilled: stageBackfilled,
      inferred: stageInferred,
      missing: stageMissing,
      score_pct: stageTotal > 0 ? Number((stageWeightedScore / stageTotal).toFixed(1)) : 0,
    };
  });

  const total = native + backfilled + inferred + missing;
  const weightedScore = (native * 100) + (backfilled * 75) + (inferred * 50);

  return {
    score_pct: total > 0 ? Number((weightedScore / total).toFixed(1)) : 0,
    native,
    backfilled,
    inferred,
    missing,
    by_stage: byStage,
  };
}

function isCreatedDecisionLifecycle(entry: LifecycleAccumulator): boolean {
  return entry.has_allocation
    || entry.has_approval
    || entry.has_hardening
    || entry.has_execution
    || entry.has_outcome
    || entry.has_attribution;
}

function isCompleteDecisionLifecycle(entry: LifecycleAccumulator): boolean {
  return entry.has_allocation
    && entry.has_approval
    && entry.has_hardening
    && entry.has_execution
    && entry.has_outcome
    && entry.has_attribution
    && entry.has_opportunity;
}

function observedFragments(entry: LifecycleAccumulator): number {
  const total = entry.allocation_count
    + entry.approval_count
    + entry.execution_count
    + entry.opportunity_count
    + (entry.has_hardening ? 1 : 0)
    + (entry.has_outcome ? 1 : 0)
    + (entry.has_attribution ? 1 : 0);
  return Math.max(1, total);
}

function buildDecisionJourneyCompletionSnapshot(lifecycles: LifecycleAccumulator[]): DecisionJourneyCompletionSnapshot {
  const createdDecisionTotal = lifecycles.filter((entry) => isCreatedDecisionLifecycle(entry)).length;
  const completeDecisionTotal = lifecycles.filter((entry) => isCreatedDecisionLifecycle(entry) && isCompleteDecisionLifecycle(entry)).length;
  const incompleteDecisionTotal = Math.max(0, createdDecisionTotal - completeDecisionTotal);

  return {
    created_decision_total: createdDecisionTotal,
    complete_decision_total: completeDecisionTotal,
    incomplete_decision_total: incompleteDecisionTotal,
    completion_rate_pct: asPercent(completeDecisionTotal, createdDecisionTotal),
  };
}

function resolveFirstMissingStage(entry: LifecycleAccumulator): DecisionFirstMissingStageKey | null {
  if (!entry.has_allocation) {
    return "allocation";
  }
  if (!entry.has_approval) {
    return "approval";
  }
  if (!entry.has_hardening) {
    return "hardening";
  }
  if (!entry.has_execution) {
    return "execution";
  }
  if (!entry.has_outcome) {
    return "outcome";
  }
  if (!entry.has_attribution) {
    return "attribution";
  }
  if (!entry.has_opportunity) {
    return "opportunity";
  }
  return null;
}

function resolveDecisionGapDefinition(stageKey: DecisionFirstMissingStageKey | null): (typeof DECISION_GAP_STAGE_DEFINITIONS)[number] | null {
  if (!stageKey) {
    return null;
  }
  return DECISION_GAP_STAGE_DEFINITIONS.find((stage) => stage.stage_key === stageKey) || null;
}

function hasStage(entry: LifecycleAccumulator, stageKey: DecisionFirstMissingStageKey): boolean {
  if (stageKey === "allocation") {
    return entry.has_allocation;
  }
  if (stageKey === "approval") {
    return entry.has_approval;
  }
  if (stageKey === "hardening") {
    return entry.has_hardening;
  }
  if (stageKey === "execution") {
    return entry.has_execution;
  }
  if (stageKey === "outcome") {
    return entry.has_outcome;
  }
  if (stageKey === "attribution") {
    return entry.has_attribution;
  }
  return entry.has_opportunity;
}

function hasLaterStagePresence(entry: LifecycleAccumulator, stageKey: DecisionFirstMissingStageKey): boolean {
  const stageIndex = DECISION_GAP_STAGE_DEFINITIONS.findIndex((stage) => stage.stage_key === stageKey);
  if (stageIndex < 0) {
    return false;
  }
  return DECISION_GAP_STAGE_DEFINITIONS.slice(stageIndex + 1).some((stage) => hasStage(entry, stage.stage_key));
}

function resolveGapRootCause(entry: LifecycleAccumulator, stageKey: DecisionFirstMissingStageKey | null): {
  code: string | null;
  label: string | null;
  remediation: string | null;
} {
  const stageDefinition = resolveDecisionGapDefinition(stageKey);
  if (!stageDefinition || !stageKey) {
    return { code: null, label: null, remediation: null };
  }
  if (hasLaterStagePresence(entry, stageKey)) {
    return {
      code: `${stageKey}_writer_gap_downstream_present`,
      label: `${stageDefinition.label} evidence missing while downstream stages are already present.`,
      remediation: `Backfill ${stageDefinition.label.toLowerCase()} evidence from downstream identifiers and repair the writer that should emit ${stageDefinition.label.toLowerCase()} stage proof.`,
    };
  }
  if (entry.confidence === "INFERRED") {
    return {
      code: `${stageKey}_inferred_only`,
      label: `${stageDefinition.label} evidence never became native and still depends on inferred continuity.`,
      remediation: `Promote ${stageDefinition.label.toLowerCase()} from inferred reconstruction to backfilled or native evidence on the primary write path.`,
    };
  }
  return {
    code: `${stageKey}_not_emitted`,
    label: stageDefinition.root_cause,
    remediation: stageDefinition.remediation,
  };
}

function getStageFirstSeenAtMs(entry: LifecycleAccumulator, stageKey: DecisionFirstMissingStageKey): number | null {
  if (stageKey === "allocation") {
    return entry.allocation_first_seen_at_ms;
  }
  if (stageKey === "approval") {
    return entry.approval_first_seen_at_ms;
  }
  if (stageKey === "hardening") {
    return entry.hardening_first_seen_at_ms;
  }
  if (stageKey === "execution") {
    return entry.execution_first_seen_at_ms;
  }
  if (stageKey === "outcome") {
    return entry.outcome_first_seen_at_ms;
  }
  if (stageKey === "attribution") {
    return entry.attribution_first_seen_at_ms;
  }
  return entry.opportunity_first_seen_at_ms;
}

function resolveContinuityResolvedAtMs(entry: LifecycleAccumulator): number | null {
  if (!isCompleteDecisionLifecycle(entry)) {
    return null;
  }
  const stageTimes = DECISION_GAP_STAGE_DEFINITIONS
    .map((stage) => getStageFirstSeenAtMs(entry, stage.stage_key))
    .filter((value): value is number => value !== null);
  if (stageTimes.length === 0) {
    return entry.last_observed_at_ms;
  }
  return Math.max(...stageTimes);
}

function resolveOpeningMissingStage(entry: LifecycleAccumulator): DecisionFirstMissingStageKey | null {
  const openedAtMs = entry.first_observed_at_ms;
  if (openedAtMs === null) {
    return resolveFirstMissingStage(entry);
  }
  for (const stage of DECISION_GAP_STAGE_DEFINITIONS) {
    const firstSeenAtMs = getStageFirstSeenAtMs(entry, stage.stage_key);
    if (firstSeenAtMs === null || firstSeenAtMs > openedAtMs) {
      return stage.stage_key;
    }
  }
  return null;
}

function buildDecisionGapResolutionSnapshot(lifecycles: LifecycleAccumulator[]): DecisionGapResolutionSnapshot {
  const createdDecisionLifecycles = lifecycles.filter((entry) => isCreatedDecisionLifecycle(entry));
  const openGapEntries: DecisionGapLedgerEntry[] = [];
  const resolvedGapEntries: DecisionGapLedgerEntry[] = [];
  const resolutionDurationsHours: number[] = [];
  const nowMs = Date.now();

  for (const lifecycle of createdDecisionLifecycles) {
    const decisionId = String(lifecycle.decision_id || "").trim();
    if (!decisionId) {
      continue;
    }
    const resolved = isCompleteDecisionLifecycle(lifecycle);
    const firstMissingStage = resolved ? resolveOpeningMissingStage(lifecycle) : resolveFirstMissingStage(lifecycle);
    const gapDefinition = resolveDecisionGapDefinition(firstMissingStage);
    const rootCause = resolveGapRootCause(lifecycle, firstMissingStage);
    const openedAtMs = lifecycle.first_observed_at_ms;
    const resolvedAtMs = resolveContinuityResolvedAtMs(lifecycle);
    const resolutionTimeHours = openedAtMs !== null && resolvedAtMs !== null
      ? toHours(resolvedAtMs - openedAtMs)
      : null;
    if (resolutionTimeHours !== null) {
      resolutionDurationsHours.push(resolutionTimeHours);
    }
    const ledgerEntry: DecisionGapLedgerEntry = {
      gap_id: [decisionId, firstMissingStage || "resolved", toIsoOrNull(openedAtMs) || "unknown"].join(":"),
      decision_id: decisionId,
      trade_lifecycle_id: lifecycle.trade_lifecycle_id,
      first_missing_stage: firstMissingStage,
      gap_label: gapDefinition?.gap_label || null,
      status: resolved ? "resolved" : "open",
      opened_at_iso: toIsoOrNull(openedAtMs),
      resolved_at_iso: toIsoOrNull(resolvedAtMs),
      resolution_time_hours: resolutionTimeHours,
      open_age_hours: !resolved && openedAtMs !== null ? toHours(nowMs - openedAtMs) : null,
      observed_fragments: observedFragments(lifecycle),
      root_cause_code: rootCause.code,
      root_cause: rootCause.label || gapDefinition?.root_cause || null,
      remediation: rootCause.remediation || gapDefinition?.remediation || null,
    };
    if (resolved) {
      resolvedGapEntries.push(ledgerEntry);
    } else {
      openGapEntries.push(ledgerEntry);
    }
  }

  const dominantOpenGapCandidate = DECISION_GAP_STAGE_DEFINITIONS
    .map((stage) => ({
      stage_key: stage.stage_key,
      gap_label: stage.gap_label,
      blocked_total: openGapEntries.filter((entry) => entry.first_missing_stage === stage.stage_key).length,
    }))
    .sort((left, right) => right.blocked_total - left.blocked_total)[0] || null;
  const dominantOpenGap = dominantOpenGapCandidate && dominantOpenGapCandidate.blocked_total > 0
    ? dominantOpenGapCandidate
    : null;

  const backlogAgeBuckets: DecisionGapBacklogAgeBucketSnapshot[] = [
    { bucket_key: "0_7d", label: "0-7 jours", open_gap_total: 0, share_pct: 0 },
    { bucket_key: "8_30d", label: "8-30 jours", open_gap_total: 0, share_pct: 0 },
    { bucket_key: "31_90d", label: "31-90 jours", open_gap_total: 0, share_pct: 0 },
    { bucket_key: "90d_plus", label: "90+ jours", open_gap_total: 0, share_pct: 0 },
  ];

  for (const entry of openGapEntries) {
    const ageHours = Number(entry.open_age_hours || 0);
    if (ageHours <= 0) {
      continue;
    }
    if (ageHours <= 24 * 7) {
      backlogAgeBuckets[0].open_gap_total += 1;
      continue;
    }
    if (ageHours <= 24 * 30) {
      backlogAgeBuckets[1].open_gap_total += 1;
      continue;
    }
    if (ageHours <= 24 * 90) {
      backlogAgeBuckets[2].open_gap_total += 1;
      continue;
    }
    backlogAgeBuckets[3].open_gap_total += 1;
  }

  const backlogAgeBucketsWithShare = backlogAgeBuckets.map((bucket) => ({
    ...bucket,
    share_pct: asPercent(bucket.open_gap_total, openGapEntries.length),
  }));

  const oldestOpenGap = openGapEntries.reduce<DecisionGapLedgerEntry | null>((oldest, entry) => {
    if (!oldest) {
      return entry;
    }
    return Number(entry.open_age_hours || 0) > Number(oldest.open_age_hours || 0) ? entry : oldest;
  }, null);

  const dominantOpenGapEntries = openGapEntries.filter((entry) => entry.first_missing_stage === dominantOpenGap?.stage_key);
  const dominantRootCauseCountsAll = [...dominantOpenGapEntries.reduce((acc, entry) => {
    const rootCauseCode = String(entry.root_cause_code || "unknown").trim() || "unknown";
    const current = acc.get(rootCauseCode) || {
      root_cause_code: rootCauseCode,
      label: String(entry.root_cause || "unknown").trim() || "unknown",
      open_gap_total: 0,
    };
    current.open_gap_total += 1;
    acc.set(rootCauseCode, current);
    return acc;
  }, new Map<string, { root_cause_code: string; label: string; open_gap_total: number }>()).values()]
    .map((entry) => ({
      root_cause_code: entry.root_cause_code,
      label: entry.label,
      open_gap_total: entry.open_gap_total,
      share_pct: asPercent(entry.open_gap_total, dominantOpenGapEntries.length),
    }))
    .sort((left, right) => right.open_gap_total - left.open_gap_total);

  const dominantRootCauseCounts = dominantRootCauseCountsAll
    .sort((left, right) => right.open_gap_total - left.open_gap_total)
    .slice(0, 5);

  const dominantGapCardinality: DecisionGapCardinalitySnapshot | null = dominantOpenGap
    ? {
        gap_occurrence_total: dominantOpenGapEntries.length,
        unique_decision_total: new Set(dominantOpenGapEntries.map((entry) => entry.decision_id)).size,
        unique_trade_lifecycle_total: new Set(dominantOpenGapEntries.map((entry) => entry.trade_lifecycle_id).filter((value): value is string => typeof value === "string" && value.length > 0)).size,
        unique_root_cause_total: new Set(dominantRootCauseCountsAll.map((entry) => entry.root_cause_code)).size,
        by_root_cause: dominantRootCauseCounts,
      }
    : null;

  const dominantGapTopDecisions = openGapEntries
    .filter((entry) => entry.first_missing_stage === dominantOpenGap?.stage_key)
    .sort((left, right) => {
      if (right.observed_fragments !== left.observed_fragments) {
        return right.observed_fragments - left.observed_fragments;
      }
      const leftOpenedAtMs = parseIsoMs(left.opened_at_iso);
      const rightOpenedAtMs = parseIsoMs(right.opened_at_iso);
      if (leftOpenedAtMs !== null && rightOpenedAtMs !== null && leftOpenedAtMs !== rightOpenedAtMs) {
        return leftOpenedAtMs - rightOpenedAtMs;
      }
      return left.decision_id.localeCompare(right.decision_id);
    })
    .slice(0, 10);

  const recentlyResolvedGaps = resolvedGapEntries
    .filter((entry) => entry.resolved_at_iso !== null)
    .sort((left, right) => {
      const leftResolvedAtMs = parseIsoMs(left.resolved_at_iso);
      const rightResolvedAtMs = parseIsoMs(right.resolved_at_iso);
      if (leftResolvedAtMs !== null && rightResolvedAtMs !== null && leftResolvedAtMs !== rightResolvedAtMs) {
        return rightResolvedAtMs - leftResolvedAtMs;
      }
      return left.decision_id.localeCompare(right.decision_id);
    })
    .slice(0, 10);

  const gapLedger = [...openGapEntries, ...resolvedGapEntries].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "open" ? -1 : 1;
    }
    if (left.status === "open") {
      if (right.observed_fragments !== left.observed_fragments) {
        return right.observed_fragments - left.observed_fragments;
      }
      const leftOpenedAtMs = parseIsoMs(left.opened_at_iso);
      const rightOpenedAtMs = parseIsoMs(right.opened_at_iso);
      if (leftOpenedAtMs !== null && rightOpenedAtMs !== null && leftOpenedAtMs !== rightOpenedAtMs) {
        return leftOpenedAtMs - rightOpenedAtMs;
      }
      return left.decision_id.localeCompare(right.decision_id);
    }
    const leftResolvedAtMs = parseIsoMs(left.resolved_at_iso);
    const rightResolvedAtMs = parseIsoMs(right.resolved_at_iso);
    if (leftResolvedAtMs !== null && rightResolvedAtMs !== null && leftResolvedAtMs !== rightResolvedAtMs) {
      return rightResolvedAtMs - leftResolvedAtMs;
    }
    return left.decision_id.localeCompare(right.decision_id);
  });

  return {
    created_decision_total: createdDecisionLifecycles.length,
    open_gap_total: openGapEntries.length,
    resolved_gap_total: resolvedGapEntries.length,
    gap_resolution_rate_pct: asPercent(resolvedGapEntries.length, createdDecisionLifecycles.length),
    mean_time_to_continuity_hours: resolutionDurationsHours.length > 0 ? average(resolutionDurationsHours) : null,
    dominant_open_gap_stage_key: dominantOpenGap?.stage_key || null,
    dominant_open_gap_label: dominantOpenGap?.gap_label || null,
    dominant_open_gap_total: dominantOpenGap?.blocked_total || 0,
    dominant_open_gap_share_pct: dominantOpenGap ? asPercent(dominantOpenGap.blocked_total, openGapEntries.length) : 0,
    backlog_age_buckets: backlogAgeBucketsWithShare,
    oldest_open_gap: oldestOpenGap,
    dominant_gap_cardinality: dominantGapCardinality,
    dominant_gap_top_decisions: dominantGapTopDecisions,
    recently_resolved_gaps: recentlyResolvedGaps,
    gap_ledger: gapLedger,
  };
}

function resolveApprovalRouteIntentId(entry: ApprovalDecisionJournalEntry | null): string | null {
  if (!entry) {
    return null;
  }
  const orderPayload = asRecord(entry.order_payload);
  const orderIntent = asRecord(orderPayload.order_intent);
  const metadata = asRecord(orderPayload.metadata);
  return firstNonEmptyString(
    orderPayload.intent_id,
    orderIntent.intent_id,
    metadata.intent_id,
  );
}

function resolveHardeningState(entry: ApprovalDecisionJournalEntry | null): string | null {
  if (!entry) {
    return null;
  }
  const hardening = asRecord(entry.hardening);
  const explicitState = firstNonEmptyString(
    hardening.status,
    hardening.state,
    hardening.result,
    hardening.phase,
    hardening.go_live_state,
    hardening.decision,
  );
  if (explicitState) {
    return explicitState;
  }
  const booleanSignals = [
    hardening.passed,
    hardening.approved,
    hardening.ready,
    hardening.go_live_ready,
    hardening.all_checks_passed,
    hardening.all_passed,
    hardening.is_ready,
  ];
  if (booleanSignals.includes(true)) {
    return "passed";
  }
  if (booleanSignals.includes(false)) {
    return "blocked";
  }
  if (Object.keys(hardening).length > 0) {
    return "present";
  }
  return firstNonEmptyString(entry.approval_status);
}

function formatWriterTransition(entry: AllocationWriterAuditEntry | null): string | null {
  if (!entry) {
    return null;
  }
  const previousStage = toNonEmptyString(entry.previous_stage);
  const nextStage = toNonEmptyString(entry.next_stage);
  const transition = previousStage && nextStage
    ? `${previousStage} -> ${nextStage}`
    : nextStage || previousStage;
  if (!transition) {
    return null;
  }
  return entry.transition_success === false ? `${transition} (failed)` : transition;
}

function resolveMissingTransition(stageKey: DecisionFirstMissingStageKey | null): string | null {
  if (stageKey === "approval") {
    return "PERSISTED -> APPROVAL_CREATED";
  }
  if (stageKey === "hardening") {
    return "APPROVAL_LINKED -> HARDENING_REACHED";
  }
  if (stageKey === "execution") {
    return "HARDENING_REACHED -> EXECUTION_CREATED";
  }
  if (stageKey === "outcome") {
    return "EXECUTION_CREATED -> OUTCOME_CREATED";
  }
  if (stageKey === "attribution") {
    return "OUTCOME_CREATED -> ATTRIBUTION_CREATED";
  }
  if (stageKey === "opportunity") {
    return "ATTRIBUTION_CREATED -> OPPORTUNITY_CREATED";
  }
  return null;
}

function resolveExecutionGapFamily(params: {
  routeIntentId: string | null;
  executionOrderId: string | null;
  executionEventId: string | null;
  outcomeId: string | null;
  latestTransition: AllocationWriterAuditEntry | null;
}): { key: ExecutionGapDiagnosticFamilyKey; label: string } {
  const hasRouteIntent = Boolean(params.routeIntentId);
  const transitionSucceeded = params.latestTransition?.transition_success !== false;
  const attemptedExecutionTransition = params.latestTransition?.next_stage === "EXECUTION_CREATED";
  const persistedExecutionEvidence = Boolean(
    params.executionOrderId
    || params.executionEventId
    || params.outcomeId
    || (attemptedExecutionTransition && transitionSucceeded)
    || params.latestTransition?.next_stage === "OUTCOME_CREATED"
    || params.latestTransition?.next_stage === "ATTRIBUTION_CREATED"
    || params.latestTransition?.next_stage === "OPPORTUNITY_CREATED",
  );

  if (persistedExecutionEvidence) {
    return {
      key: "persisted_elsewhere_not_linked",
      label: "Execution persistée ailleurs mais non liée au lifecycle canonique.",
    };
  }
  if (hasRouteIntent || attemptedExecutionTransition) {
    return {
      key: "routed_but_not_persisted",
      label: "Décision routée ou intent créée, mais persistance d'exécution absente.",
    };
  }
  return {
    key: "never_routed",
    label: "Décision durcie, mais jamais routée jusqu'à une intent d'exécution.",
  };
}

function buildExecutionGapDiagnosticDecisionRow(params: {
  lifecycle: LifecycleAccumulator;
  allocations: AllocationDecisionJournalEntry[];
  approvals: ApprovalDecisionJournalEntry[];
  executionFacts: ExecutionFactJournalEntry[];
  opportunities: OpportunityCostJournalEntry[];
  writerEvents: AllocationWriterAuditEntry[];
}): ExecutionGapDiagnosticDecisionRow | null {
  const decisionId = toNonEmptyString(params.lifecycle.decision_id);
  if (!decisionId) {
    return null;
  }

  const latestAllocation = pickLatestEntry(params.allocations, (entry) => parseIsoMs(entry.created_at_iso));
  const latestApproval = pickLatestEntry(params.approvals, (entry) => parseIsoMs(entry.created_at_iso));
  const latestExecution = pickLatestEntry(params.executionFacts, (entry) => parseIsoMs(entry.created_at_iso));
  const latestOpportunity = pickLatestEntry(params.opportunities, (entry) => parseIsoMs(entry.created_at_iso));
  const latestWriterEvent = pickLatestEntry(params.writerEvents, (entry) => parseIsoMs(entry.writer_timestamp_iso) ?? parseIsoMs(entry.created_at_iso));
  const latestTransition = pickLatestEntry(
    params.writerEvents.filter((entry) => String(entry.entry_kind || "writer_audit") === "stage_transition"),
    (entry) => parseIsoMs(entry.writer_timestamp_iso) ?? parseIsoMs(entry.created_at_iso),
  );

  const executionMarketContext = asRecord(latestExecution?.market_context);
  const executionApprovalContext = asRecord(latestExecution?.approval_context);
  const firstMissingStage = resolveFirstMissingStage(params.lifecycle);
  const approvalId = firstNonEmptyString(
    latestApproval?.approval_id,
    latestExecution?.approval_id,
    latestOpportunity?.approval_id,
    latestAllocation?.approval_id,
  );
  const routeIntentId = firstNonEmptyString(
    latestExecution?.intent_id,
    latestOpportunity?.intent_id,
    resolveApprovalRouteIntentId(latestApproval),
  );
  const executionOrderId = firstNonEmptyString(
    latestExecution?.order_id,
    latestExecution?.execution_id,
    latestOpportunity?.execution_id,
    latestAllocation?.execution_id,
    latestApproval?.execution_id,
  );
  const executionEventId = firstNonEmptyString(latestExecution?.fact_id);
  const outcomeId = firstNonEmptyString(
    latestExecution?.outcome_id,
    latestOpportunity?.outcome_id,
    latestAllocation?.outcome_id,
    latestApproval?.outcome_id,
  );
  const family = firstMissingStage === "execution"
    ? resolveExecutionGapFamily({
        routeIntentId,
        executionOrderId,
        executionEventId,
        outcomeId,
        latestTransition,
      })
    : { key: "unknown" as const, label: "n/a" };

  return {
    decision_id: decisionId,
    trade_lifecycle_id: params.lifecycle.trade_lifecycle_id,
    first_missing_stage: firstMissingStage,
    hardening_state: resolveHardeningState(latestApproval),
    approval_id: approvalId,
    route_intent_id: routeIntentId,
    execution_order_id: executionOrderId,
    execution_event_id: executionEventId,
    outcome_id: outcomeId,
    writer_source: firstNonEmptyString(
      latestTransition?.writer_version,
      latestWriterEvent?.writer_version,
      executionMarketContext.source,
      executionApprovalContext.source,
      latestApproval?.source_event_category,
      latestAllocation?.allocator_version,
    ),
    last_transition: formatWriterTransition(latestTransition),
    missing_transition: resolveMissingTransition(firstMissingStage),
    writer_failure_reason: firstNonEmptyString(
      latestTransition?.failure_reason,
      latestWriterEvent?.writer_error_detail,
      latestWriterEvent?.writer_error_code,
    ),
    writer_family_key: firstMissingStage === "execution" ? family.key : null,
    writer_family_label: firstMissingStage === "execution" ? family.label : null,
  };
}

function buildExecutionGapDiagnosticSnapshot(
  lifecycles: LifecycleAccumulator[],
  allocations: AllocationDecisionJournalEntry[],
  approvals: ApprovalDecisionJournalEntry[],
  executionFacts: ExecutionFactJournalEntry[],
  opportunities: OpportunityCostJournalEntry[],
  auditEntries: AllocationWriterAuditEntry[],
  decisionGapResolution: DecisionGapResolutionSnapshot,
): ExecutionGapDiagnosticSnapshot {
  const lifecycleByDecisionId = lifecycles.reduce((acc, lifecycle) => {
    const decisionId = toNonEmptyString(lifecycle.decision_id);
    if (decisionId) {
      acc.set(decisionId, lifecycle);
    }
    return acc;
  }, new Map<string, LifecycleAccumulator>());

  const allocationsByDecisionId = allocations.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, AllocationDecisionJournalEntry[]>());

  const approvalsByDecisionId = approvals.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, ApprovalDecisionJournalEntry[]>());

  const executionFactsByDecisionId = executionFacts.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, ExecutionFactJournalEntry[]>());

  const opportunitiesByDecisionId = opportunities.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, OpportunityCostJournalEntry[]>());

  const writerEventsByDecisionId = auditEntries.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, AllocationWriterAuditEntry[]>());

  const completeDecisionIds = lifecycles
    .filter((entry) => entry.has_execution && entry.has_outcome)
    .sort((left, right) => {
      if (observedFragments(right) !== observedFragments(left)) {
        return observedFragments(right) - observedFragments(left);
      }
      const leftObservedAtMs = left.last_observed_at_ms ?? 0;
      const rightObservedAtMs = right.last_observed_at_ms ?? 0;
      if (rightObservedAtMs !== leftObservedAtMs) {
        return rightObservedAtMs - leftObservedAtMs;
      }
      return String(left.decision_id || "").localeCompare(String(right.decision_id || ""));
    })
    .map((entry) => toNonEmptyString(entry.decision_id))
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  const blockedDecisionIds = decisionGapResolution.gap_ledger
    .filter((entry) => entry.status === "open" && entry.first_missing_stage === "execution")
    .map((entry) => toNonEmptyString(entry.decision_id))
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  const buildRow = (decisionId: string): ExecutionGapDiagnosticDecisionRow | null => {
    const lifecycle = lifecycleByDecisionId.get(decisionId);
    if (!lifecycle) {
      return null;
    }
    return buildExecutionGapDiagnosticDecisionRow({
      lifecycle,
      allocations: allocationsByDecisionId.get(decisionId) || [],
      approvals: approvalsByDecisionId.get(decisionId) || [],
      executionFacts: executionFactsByDecisionId.get(decisionId) || [],
      opportunities: opportunitiesByDecisionId.get(decisionId) || [],
      writerEvents: writerEventsByDecisionId.get(decisionId) || [],
    });
  };

  const completeDecisions = completeDecisionIds
    .map(buildRow)
    .filter((entry): entry is ExecutionGapDiagnosticDecisionRow => entry !== null);
  const blockedDecisions = blockedDecisionIds
    .map(buildRow)
    .filter((entry): entry is ExecutionGapDiagnosticDecisionRow => entry !== null);

  const familySeed: Array<{ key: ExecutionGapDiagnosticFamilyKey; label: string }> = [
    { key: "never_routed", label: "Décision jamais routée" },
    { key: "routed_but_not_persisted", label: "Routée mais non persistée" },
    { key: "persisted_elsewhere_not_linked", label: "Persistée ailleurs mais non liée" },
    { key: "unknown", label: "Inconnu" },
  ];

  const blockedFamilyBreakdown = familySeed
    .map((family) => {
      const matchingRows = blockedDecisions.filter((entry) => entry.writer_family_key === family.key);
      return {
        family_key: family.key,
        label: family.label,
        decision_total: matchingRows.length,
        share_pct: asPercent(matchingRows.length, blockedDecisions.length),
        example_decision_ids: matchingRows.slice(0, 5).map((entry) => entry.decision_id),
      };
    })
    .filter((entry) => entry.decision_total > 0)
    .sort((left, right) => right.decision_total - left.decision_total);

  const coverageDefinitions: Array<{
    field_key: ExecutionGapDiagnosticFieldKey;
    read: (entry: ExecutionGapDiagnosticDecisionRow) => string | null;
  }> = [
    { field_key: "hardening_state", read: (entry) => entry.hardening_state },
    { field_key: "approval_id", read: (entry) => entry.approval_id },
    { field_key: "route_intent_id", read: (entry) => entry.route_intent_id },
    { field_key: "execution_order_id", read: (entry) => entry.execution_order_id },
    { field_key: "execution_event_id", read: (entry) => entry.execution_event_id },
    { field_key: "outcome_id", read: (entry) => entry.outcome_id },
    { field_key: "writer_source", read: (entry) => entry.writer_source },
    { field_key: "last_transition", read: (entry) => entry.last_transition },
  ];

  const fieldCoverage = coverageDefinitions
    .map((definition) => {
      const completePresentTotal = completeDecisions.filter((entry) => Boolean(definition.read(entry))).length;
      const blockedPresentTotal = blockedDecisions.filter((entry) => Boolean(definition.read(entry))).length;
      const completePresentRatePct = asPercent(completePresentTotal, completeDecisions.length);
      const blockedPresentRatePct = asPercent(blockedPresentTotal, blockedDecisions.length);
      return {
        field_key: definition.field_key,
        complete_present_total: completePresentTotal,
        blocked_present_total: blockedPresentTotal,
        complete_present_rate_pct: completePresentRatePct,
        blocked_present_rate_pct: blockedPresentRatePct,
        coverage_gap_pct: Number((completePresentRatePct - blockedPresentRatePct).toFixed(1)),
      };
    })
    .sort((left, right) => {
      if (right.coverage_gap_pct !== left.coverage_gap_pct) {
        return right.coverage_gap_pct - left.coverage_gap_pct;
      }
      return left.field_key.localeCompare(right.field_key);
    });

  return {
    comparison_goal: "execution_writer_divergence",
    complete_definition: "execution_and_outcome_present",
    blocked_definition: "hardening_present_execution_missing",
    complete_decision_total: completeDecisions.length,
    blocked_decision_total: blockedDecisions.length,
    dominant_divergence_field: fieldCoverage[0]?.field_key || null,
    field_coverage: fieldCoverage,
    blocked_family_breakdown: blockedFamilyBreakdown,
    complete_decisions: completeDecisions,
    blocked_decisions: blockedDecisions,
  };
}

function resolveApprovalTerminalReason(entry: ApprovalDecisionJournalEntry | null): string | null {
  if (!entry) {
    return null;
  }
  const hardening = asRecord(entry.hardening);
  return firstNonEmptyString(
    entry.rejection_reason,
    entry.rejection_code,
    hardening.reason,
    hardening.failure_reason,
    hardening.block_reason,
    hardening.message,
    hardening.detail,
  );
}

function resolveTerminalDecisionClosedState(entry: ApprovalDecisionJournalEntry | null): keyof TerminalDecisionClosedStateSnapshot | null {
  if (!entry) {
    return null;
  }
  const sourceEventCategory = String(entry.source_event_category || "").trim();
  const approvalStatus = String(entry.approval_status || "").trim().toLowerCase();
  const hardeningState = String(resolveHardeningState(entry) || "").trim().toLowerCase();

  if (sourceEventCategory === "mt5_live_order_stale_approval_cancelled" || approvalStatus.includes("stale")) {
    return "stale_cancelled";
  }
  if (approvalStatus.includes("cancel")) {
    return "cancelled";
  }
  if (approvalStatus.includes("expir")) {
    return "expired";
  }

  const hardeningRejected = hardeningState.includes("reject")
    || hardeningState.includes("block")
    || hardeningState.includes("denied")
    || hardeningState.includes("fail");
  const rejected = sourceEventCategory === "mt5_live_order_rejected_after_second_approval"
    || approvalStatus.includes("reject")
    || approvalStatus.includes("denied");

  if (rejected && hardeningRejected && resolveApprovalTerminalReason(entry)) {
    return "hardening_rejected";
  }
  if (rejected) {
    return "rejected";
  }
  return null;
}

function buildTerminalActiveDebtReasons(activeDebt: TerminalDecisionActiveDebtSnapshot): string[] {
  const definitions: Array<{ key: keyof TerminalDecisionActiveDebtSnapshot; label: string }> = [
    { key: "hardening_not_reached", label: "hardening_not_reached" },
    { key: "hardening_rejected_without_reason", label: "hardening_rejected_without_reason" },
    { key: "approved_without_route", label: "approved_without_route" },
    { key: "routed_without_execution_event", label: "routed_without_execution_event" },
    { key: "execution_without_outcome", label: "execution_without_outcome" },
  ];
  return definitions
    .filter((definition) => activeDebt[definition.key] > 0)
    .map((definition) => `${definition.label}:${activeDebt[definition.key]}`);
}

function buildTerminalDecisionReviewRequiredItem(params: {
  decisionId: string | null;
  lifecycle: LifecycleAccumulator;
  diagnosticRow: ExecutionGapDiagnosticDecisionRow | null;
}): TerminalDecisionReviewRequiredItem {
  const firstMissingStage = params.diagnosticRow?.first_missing_stage || resolveFirstMissingStage(params.lifecycle);

  if (!params.decisionId) {
    return {
      decision_id: null,
      reason: "Lifecycle created without a stable decision_id; classification cannot be made deterministic.",
      candidate_state: "decision_id_missing",
      missing_evidence: ["decision_id"],
      first_missing_stage: firstMissingStage,
      blocks_publish: false,
    };
  }

  if (firstMissingStage === "allocation") {
    return {
      decision_id: params.decisionId,
      reason: "Decision exists without native allocation evidence; this is a continuity-quality gap, not active execution debt.",
      candidate_state: "allocation_not_recorded",
      missing_evidence: ["allocation_id", "trade_lifecycle_id"],
      first_missing_stage: firstMissingStage,
      blocks_publish: false,
    };
  }

  if (firstMissingStage === "approval") {
    return {
      decision_id: params.decisionId,
      reason: "Allocation exists but approval evidence was not recorded on the canonical lifecycle path.",
      candidate_state: "approval_not_recorded",
      missing_evidence: ["approval_id", "approval_status"],
      first_missing_stage: firstMissingStage,
      blocks_publish: false,
    };
  }

  if (firstMissingStage === "attribution") {
    return {
      decision_id: params.decisionId,
      reason: "Execution and outcome exist; only attribution evidence is still pending.",
      candidate_state: "completed_pending_attribution",
      missing_evidence: ["attribution"],
      first_missing_stage: firstMissingStage,
      blocks_publish: false,
    };
  }

  if (firstMissingStage === "opportunity") {
    return {
      decision_id: params.decisionId,
      reason: "Execution, outcome, and attribution exist; only opportunity-cost evidence is still pending.",
      candidate_state: "completed_pending_opportunity",
      missing_evidence: ["opportunity"],
      first_missing_stage: firstMissingStage,
      blocks_publish: false,
    };
  }

  return {
    decision_id: params.decisionId,
    reason: "Residual lifecycle state needs operator review because it does not match an active-debt or terminal-closed family yet.",
    candidate_state: "unclassified",
    missing_evidence: [firstMissingStage || "unknown"],
    first_missing_stage: firstMissingStage,
    blocks_publish: false,
  };
}

function buildTerminalDecisionStateDiagnosticSnapshot(
  lifecycles: LifecycleAccumulator[],
  allocations: AllocationDecisionJournalEntry[],
  approvals: ApprovalDecisionJournalEntry[],
  executionFacts: ExecutionFactJournalEntry[],
  opportunities: OpportunityCostJournalEntry[],
  auditEntries: AllocationWriterAuditEntry[],
): TerminalDecisionStateDiagnosticSnapshot {
  const createdDecisionLifecycles = lifecycles.filter((entry) => isCreatedDecisionLifecycle(entry));
  const allocationsByDecisionId = allocations.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, AllocationDecisionJournalEntry[]>());
  const approvalsByDecisionId = approvals.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, ApprovalDecisionJournalEntry[]>());
  const executionFactsByDecisionId = executionFacts.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, ExecutionFactJournalEntry[]>());
  const opportunitiesByDecisionId = opportunities.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, OpportunityCostJournalEntry[]>());
  const writerEventsByDecisionId = auditEntries.reduce((acc, entry) => {
    const decisionId = toNonEmptyString(entry.decision_id);
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, AllocationWriterAuditEntry[]>());

  const terminalClosed: TerminalDecisionClosedStateSnapshot = {
    cancelled: 0,
    stale_cancelled: 0,
    rejected: 0,
    hardening_rejected: 0,
    expired: 0,
  };
  const activeDebt: TerminalDecisionActiveDebtSnapshot = {
    hardening_not_reached: 0,
    hardening_rejected_without_reason: 0,
    approved_without_route: 0,
    routed_without_execution_event: 0,
    execution_without_outcome: 0,
  };
  const reviewRequiredItems: TerminalDecisionReviewRequiredItem[] = [];
  let completedJourneyTotal = 0;

  for (const lifecycle of createdDecisionLifecycles) {
    const decisionId = toNonEmptyString(lifecycle.decision_id);
    if (!decisionId) {
      continue;
    }
    if (lifecycle.has_execution && lifecycle.has_outcome) {
      completedJourneyTotal += 1;
      continue;
    }

    const decisionApprovals = approvalsByDecisionId.get(decisionId) || [];
    const latestApproval = pickLatestEntry(decisionApprovals, (entry) => parseIsoMs(entry.created_at_iso));
    const terminalClosedState = resolveTerminalDecisionClosedState(latestApproval);
    if (terminalClosedState) {
      terminalClosed[terminalClosedState] += 1;
      continue;
    }

    const hardeningState = String(resolveHardeningState(latestApproval) || "").trim().toLowerCase();
    const hardeningRejected = hardeningState.includes("reject")
      || hardeningState.includes("block")
      || hardeningState.includes("denied")
      || hardeningState.includes("fail");
    if (hardeningRejected && !resolveApprovalTerminalReason(latestApproval)) {
      activeDebt.hardening_rejected_without_reason += 1;
      continue;
    }

    const diagnosticRow = buildExecutionGapDiagnosticDecisionRow({
      lifecycle,
      allocations: allocationsByDecisionId.get(decisionId) || [],
      approvals: decisionApprovals,
      executionFacts: executionFactsByDecisionId.get(decisionId) || [],
      opportunities: opportunitiesByDecisionId.get(decisionId) || [],
      writerEvents: writerEventsByDecisionId.get(decisionId) || [],
    });
    const firstMissingStage = diagnosticRow?.first_missing_stage || resolveFirstMissingStage(lifecycle);

    if (firstMissingStage === "hardening") {
      activeDebt.hardening_not_reached += 1;
      continue;
    }
    if (firstMissingStage === "execution") {
      const hasRoutingEvidence = Boolean(
        diagnosticRow?.route_intent_id
        || diagnosticRow?.execution_order_id
        || String(diagnosticRow?.last_transition || "").includes("EXECUTION_CREATED"),
      );
      if (hasRoutingEvidence) {
        activeDebt.routed_without_execution_event += 1;
      } else {
        activeDebt.approved_without_route += 1;
      }
      continue;
    }
    if (firstMissingStage === "outcome") {
      activeDebt.execution_without_outcome += 1;
      continue;
    }
    reviewRequiredItems.push(buildTerminalDecisionReviewRequiredItem({
      decisionId,
      lifecycle,
      diagnosticRow,
    }));
  }

  const activeDebtTotal = Object.values(activeDebt).reduce((sum, value) => sum + value, 0);
  const activeDebtReasons = buildTerminalActiveDebtReasons(activeDebt);
  const reviewBlockingItems = reviewRequiredItems.filter((item) => item.blocks_publish);
  const publishBlockReasons = [
    ...activeDebtReasons,
    ...reviewBlockingItems.map((item) => `${item.candidate_state}:${item.decision_id || "unknown"}`),
  ];

  return {
    total: createdDecisionLifecycles.length,
    completed_journey_total: completedJourneyTotal,
    terminal_closed: terminalClosed,
    active_debt: activeDebt,
    active_debt_reasons: activeDebtReasons,
    review_required_total: reviewRequiredItems.length,
    review_required: {
      total: reviewRequiredItems.length,
      blocking_total: reviewBlockingItems.length,
      items: reviewRequiredItems,
    },
    publish_blocked: activeDebtTotal > 0 || reviewBlockingItems.length > 0,
    publish_block_reasons: publishBlockReasons,
  };
}

function matchesAllocationApproval(allocation: AllocationDecisionJournalEntry, approval: ApprovalDecisionJournalEntry): boolean {
  if (allocation.approval_id && approval.approval_id === allocation.approval_id) {
    return true;
  }
  if (approval.allocation_id && approval.allocation_id === allocation.allocation_id) {
    return true;
  }
  if (allocation.decision_id && approval.decision_id && approval.decision_id === allocation.decision_id) {
    return true;
  }
  if (allocation.trade_lifecycle_id && approval.trade_lifecycle_id && approval.trade_lifecycle_id === allocation.trade_lifecycle_id) {
    return true;
  }
  return false;
}

function matchesAllocationExecution(allocation: AllocationDecisionJournalEntry, execution: ExecutionFactJournalEntry): boolean {
  if (allocation.execution_id && execution.execution_id === allocation.execution_id) {
    return true;
  }
  if (allocation.approval_id && execution.approval_id && execution.approval_id === allocation.approval_id) {
    return true;
  }
  if (allocation.decision_id && execution.decision_id === allocation.decision_id) {
    return true;
  }
  if (allocation.trade_lifecycle_id && execution.trade_lifecycle_id && execution.trade_lifecycle_id === allocation.trade_lifecycle_id) {
    return true;
  }
  return false;
}

function matchesAllocationOpportunity(allocation: AllocationDecisionJournalEntry, opportunity: OpportunityCostJournalEntry): boolean {
  if (allocation.outcome_id && opportunity.outcome_id && opportunity.outcome_id === allocation.outcome_id) {
    return true;
  }
  if (allocation.approval_id && opportunity.approval_id && opportunity.approval_id === allocation.approval_id) {
    return true;
  }
  if (allocation.decision_id && opportunity.decision_id && opportunity.decision_id === allocation.decision_id) {
    return true;
  }
  if (allocation.trade_lifecycle_id && opportunity.trade_lifecycle_id && opportunity.trade_lifecycle_id === allocation.trade_lifecycle_id) {
    return true;
  }
  return false;
}

function resolveAllocationWriterFailureRemediation(categoryKey: AllocationWriterFailureCategoryKey | null): string | null {
  if (categoryKey === "missing_decision_id") {
    return "Emit decision_id on the allocation write path before append and reject writes that cannot carry a stable decision identity.";
  }
  if (categoryKey === "missing_candidate_id") {
    return "Emit candidate_id on the allocation write path before append so the writer can propagate a stable candidate identity downstream.";
  }
  if (categoryKey === "approval_not_created") {
    return "Repair allocation to approval creation so every persisted allocation seeds an approval object on the primary path.";
  }
  if (categoryKey === "approval_created_but_not_linked") {
    return "Repair approval identity propagation so approval records keep the originating allocation_id and decision_id link.";
  }
  if (categoryKey === "hardening_block_before_write") {
    return "Persist hardening proof before execution so approval closure cannot bypass the hardening stage.";
  }
  if (categoryKey === "execution_fact_not_created") {
    return "Repair execution fact emission immediately after approval so the lifecycle cannot stall before execution evidence exists.";
  }
  if (categoryKey === "outcome_not_created") {
    return "Emit outcome evidence as soon as execution completes so the lifecycle can close beyond execution.";
  }
  if (categoryKey === "attribution_not_created") {
    return "Restore attribution emission on the outcome path so alpha evidence no longer stops after outcome creation.";
  }
  if (categoryKey === "opportunity_not_created") {
    return "Restore opportunity evidence creation after attribution so the final downstream stage closes natively.";
  }
  if (categoryKey === "unknown") {
    return "Inspect writer provenance and add native closure evidence before treating the symptom as closed.";
  }
  return null;
}

const ALLOCATION_WRITER_ROOT_CAUSE_CODE = "allocation_writer_gap_downstream_present";

function computeNativeEvidenceCoveragePct(snapshot: DecisionEvidenceQualitySnapshot): number {
  return asPercent(snapshot.native, snapshot.native + snapshot.backfilled + snapshot.inferred + snapshot.missing);
}

function resolveAllocationWriterNextOccurrenceTarget(currentTotal: number): number {
  if (currentTotal > 200) {
    return 200;
  }
  if (currentTotal > 100) {
    return 100;
  }
  if (currentTotal > 50) {
    return 50;
  }
  return 0;
}

function buildDecisionGovernanceSnapshot(
  decisionJourneyCompletion: DecisionJourneyCompletionSnapshot,
  decisionGapResolution: DecisionGapResolutionSnapshot,
  decisionEvidenceQuality: DecisionEvidenceQualitySnapshot,
  allocationWriterClosure: AllocationWriterClosureSnapshot,
): DecisionGovernanceSnapshot {
  const dominantRootCause = decisionGapResolution.dominant_gap_cardinality?.by_root_cause[0] || null;
  const allocationWriterRootCause = decisionGapResolution.dominant_gap_cardinality?.by_root_cause.find(
    (entry) => entry.root_cause_code === (allocationWriterClosure.dominant_root_cause_code || ALLOCATION_WRITER_ROOT_CAUSE_CODE),
  ) || null;
  const rootCauseConcentrationPct = Number((allocationWriterRootCause?.share_pct || dominantRootCause?.share_pct || 0).toFixed(1));
  const nativeEvidenceCoveragePct = computeNativeEvidenceCoveragePct(decisionEvidenceQuality);
  const rootCauseClosureRatePct = allocationWriterClosure.closure_evidence.root_cause_closure_rate_pct;
  const currentOccurrenceTotal = allocationWriterRootCause?.open_gap_total || allocationWriterClosure.closure_evidence.open_gap_total;
  const allocationWriterProgramActive = allocationWriterClosure.closure_evidence.open_gap_total > 0 && (
    allocationWriterClosure.dominant_root_cause_code === ALLOCATION_WRITER_ROOT_CAUSE_CODE
    || dominantRootCause?.root_cause_code === ALLOCATION_WRITER_ROOT_CAUSE_CODE
    || (allocationWriterClosure.writer_coverage.allocation_failed_total || 0) > 0
  );
  const journeyProgramEligible = !allocationWriterProgramActive;
  const evidenceProgramEligible = journeyProgramEligible && decisionJourneyCompletion.completion_rate_pct >= 60;
  const scalingBlocked = allocationWriterProgramActive
    || decisionJourneyCompletion.completion_rate_pct < 85
    || nativeEvidenceCoveragePct < 60
    || rootCauseClosureRatePct < 80
    || rootCauseConcentrationPct >= 25;
  const freezeReason = allocationWriterProgramActive
    ? "Allocation Writer root cause remains open; freeze scaling until Creation -> Allocation closes natively."
    : decisionJourneyCompletion.completion_rate_pct < 85
      ? "Decision journey completion remains below the minimum governed scaling threshold."
      : nativeEvidenceCoveragePct < 60
        ? "Native evidence coverage remains below the governed scaling threshold."
        : rootCauseClosureRatePct < 80
          ? "Root cause closure rate remains below the governed scaling threshold."
        : rootCauseConcentrationPct >= 25
          ? "Root cause concentration remains too high to unlock scaling safely."
          : "Governed scaling is allowed.";
  const freezeControls: DecisionGovernanceFreezeControl[] = [
    { key: "alpha_v2", label: "Alpha V2", frozen: scalingBlocked, reason: freezeReason },
    { key: "llm_trader", label: "LLM Trader", frozen: scalingBlocked, reason: freezeReason },
    { key: "memory_engine", label: "Memory Engine", frozen: scalingBlocked, reason: freezeReason },
    { key: "strategy_expansion", label: "Strategy Expansion", frozen: scalingBlocked, reason: freezeReason },
    { key: "new_signals", label: "New Signals", frozen: scalingBlocked, reason: freezeReason },
    { key: "new_predictors", label: "New Predictors", frozen: scalingBlocked, reason: freezeReason },
  ];
  const activeProgramKey: DecisionGovernanceProgramKey = allocationWriterProgramActive
    ? "allocation_writer_closure"
    : decisionJourneyCompletion.completion_rate_pct < 85
      ? "decision_journey_completion"
      : nativeEvidenceCoveragePct < 60
        ? "evidence_conversion"
        : "governed_scaling";
  const activeProgramLabel = activeProgramKey === "allocation_writer_closure"
    ? "P0 Allocation Writer Closure Program"
    : activeProgramKey === "decision_journey_completion"
      ? "P1 Decision Journey Completion"
      : activeProgramKey === "evidence_conversion"
        ? "P2 Evidence Conversion Program"
        : "Governed Scaling";
  const activeProgramReason = activeProgramKey === "allocation_writer_closure"
    ? `${String(allocationWriterClosure.dominant_root_cause_label || allocationWriterRootCause?.label || ALLOCATION_WRITER_ROOT_CAUSE_CODE)} remains the dominant runtime breach (${currentOccurrenceTotal} open occurrences, ${rootCauseConcentrationPct.toFixed(1)}% concentration).`
    : activeProgramKey === "decision_journey_completion"
      ? `Journey completion remains the primary KPI at ${decisionJourneyCompletion.completion_rate_pct.toFixed(1)}%.`
      : activeProgramKey === "evidence_conversion"
        ? `Native evidence coverage remains below threshold at ${nativeEvidenceCoveragePct.toFixed(1)}%.`
        : "Journey completion, evidence coverage, and root cause concentration are within governed scaling thresholds.";

  return {
    system_name: "Decision Governance System",
    active_program_key: activeProgramKey,
    active_program_label: activeProgramLabel,
    active_program_reason: activeProgramReason,
    north_star: {
      primary_kpi_key: "decision_journey_completion_rate_pct",
      secondary_kpi_key: "native_evidence_coverage_pct",
      tertiary_kpi_key: "root_cause_concentration_pct",
      tri_role: "indicator",
    },
    decision_journey_completion_rate_pct: decisionJourneyCompletion.completion_rate_pct,
    native_evidence_coverage_pct: nativeEvidenceCoveragePct,
    root_cause_concentration_pct: rootCauseConcentrationPct,
    root_cause_closure_rate_pct: rootCauseClosureRatePct,
    scaling_blocked: scalingBlocked,
    allocation_writer_program: {
      active: allocationWriterProgramActive,
      dominant_root_cause_code: allocationWriterClosure.dominant_root_cause_code,
      dominant_root_cause_label: allocationWriterClosure.dominant_root_cause_label,
      open_gap_total: allocationWriterClosure.closure_evidence.open_gap_total,
      current_occurrence_total: currentOccurrenceTotal,
      next_occurrence_target_total: resolveAllocationWriterNextOccurrenceTarget(currentOccurrenceTotal),
      allocation_created_total: allocationWriterClosure.writer_coverage.allocation_created_total,
      allocation_persisted_total: allocationWriterClosure.writer_coverage.allocation_persisted_total,
      allocation_failed_total: allocationWriterClosure.writer_coverage.allocation_failed_total,
      identity_propagation_rate_pct: allocationWriterClosure.identity_propagation.identity_propagation_rate_pct,
      writer_native_error_totals: {
        none: allocationWriterClosure.writer_native_errors.find((entry) => entry.error_code === "none")?.total || 0,
        writer_timeout: allocationWriterClosure.writer_native_errors.find((entry) => entry.error_code === "writer_timeout")?.total || 0,
        writer_append_failure: allocationWriterClosure.writer_native_errors.find((entry) => entry.error_code === "writer_append_failure")?.total || 0,
        writer_journal_error: allocationWriterClosure.writer_native_errors.find((entry) => entry.error_code === "writer_journal_error")?.total || 0,
        writer_identity_error: allocationWriterClosure.writer_native_errors.find((entry) => entry.error_code === "writer_identity_error")?.total || 0,
        writer_validation_error: allocationWriterClosure.writer_native_errors.find((entry) => entry.error_code === "writer_validation_error")?.total || 0,
      },
    },
    journey_program: {
      eligible: journeyProgramEligible,
      created_decision_total: decisionJourneyCompletion.created_decision_total,
      complete_decision_total: decisionJourneyCompletion.complete_decision_total,
      incomplete_decision_total: decisionJourneyCompletion.incomplete_decision_total,
      completion_rate_pct: decisionJourneyCompletion.completion_rate_pct,
    },
    evidence_program: {
      eligible: evidenceProgramEligible,
      native: decisionEvidenceQuality.native,
      backfilled: decisionEvidenceQuality.backfilled,
      inferred: decisionEvidenceQuality.inferred,
      missing: decisionEvidenceQuality.missing,
      native_coverage_pct: nativeEvidenceCoveragePct,
    },
    freeze_controls: freezeControls,
  };
}

function buildAllocationWriterClosureSnapshot(
  allocations: AllocationDecisionJournalEntry[],
  approvals: ApprovalDecisionJournalEntry[],
  executionFacts: ExecutionFactJournalEntry[],
  opportunities: OpportunityCostJournalEntry[],
  auditEntries: AllocationWriterAuditEntry[],
  decisionGapResolution: DecisionGapResolutionSnapshot,
): AllocationWriterClosureSnapshot {
  const writerAuditEntries = auditEntries.filter((entry) => String(entry.entry_kind || "writer_audit") !== "stage_transition");
  const latestAuditByAllocationId = writerAuditEntries.reduce((acc, entry) => {
    const allocationId = String(entry.allocation_id || "").trim();
    if (!allocationId) {
      return acc;
    }
    const current = acc.get(allocationId);
    const entryMs = parseIsoMs(entry.created_at_iso) ?? 0;
    const currentMs = current ? parseIsoMs(current.created_at_iso) ?? 0 : 0;
    if (!current || entryMs >= currentMs) {
      acc.set(allocationId, entry);
    }
    return acc;
  }, new Map<string, AllocationWriterAuditEntry>());
  const nativeCreatedTotal = writerAuditEntries.filter((entry) => entry.writer_result === "created").length;
  const nativePersistedTotal = writerAuditEntries.filter((entry) => entry.writer_result === "persisted").length;
  const nativeFailedTotal = writerAuditEntries.filter((entry) => entry.writer_result === "failed").length;
  const writtenTotal = allocations.length;
  const allocationsWithDecisionId = allocations.filter((entry) => String(entry.decision_id || "").trim().length > 0).length;
  const allocationsWithCandidateId = allocations.filter((entry) => String(entry.candidate_id || "").trim().length > 0).length;
  const allocationsWithTradeLifecycleId = allocations.filter((entry) => String(entry.trade_lifecycle_id || "").trim().length > 0).length;
  const allocationsWithApprovalId = allocations.filter((entry) => String(entry.approval_id || "").trim().length > 0).length;

  const decisionIdCounts = allocations.reduce((acc, entry) => {
    const decisionId = String(entry.decision_id || "").trim();
    if (!decisionId) {
      return acc;
    }
    acc.set(decisionId, (acc.get(decisionId) || 0) + 1);
    return acc;
  }, new Map<string, number>());

  const duplicateDecisionTotal = [...decisionIdCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const multiWriteDecisionIds = new Set([...decisionIdCounts.entries()].filter(([, count]) => count > 1).map(([decisionId]) => decisionId));

  const approvalsByDecisionId = approvals.reduce((acc, entry) => {
    const decisionId = String(entry.decision_id || "").trim();
    if (!decisionId) {
      return acc;
    }
    const current = acc.get(decisionId) || [];
    current.push(entry);
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, ApprovalDecisionJournalEntry[]>());

  const approvalsByLifecycleId = approvals.reduce((acc, entry) => {
    const lifecycleId = String(entry.trade_lifecycle_id || "").trim();
    if (!lifecycleId) {
      return acc;
    }
    const current = acc.get(lifecycleId) || [];
    current.push(entry);
    acc.set(lifecycleId, current);
    return acc;
  }, new Map<string, ApprovalDecisionJournalEntry[]>());

  const evaluations = allocations.map((allocation) => {
    const allocationCreatedAtMs = parseIsoMs(allocation.created_at_iso);
    const approvalMatches = approvals.filter((entry) => matchesAllocationApproval(allocation, entry));
    const executionMatches = executionFacts.filter((entry) => matchesAllocationExecution(allocation, entry));
    const opportunityMatches = opportunities.filter((entry) => matchesAllocationOpportunity(allocation, entry));
    const hardeningMatches = approvalMatches.filter((entry) => hasHardeningContext(entry));
    const outcomeMatches = executionMatches.filter((entry) => hasExecutionOutcomePayload(entry));
    const attributionMatches = executionMatches.filter((entry) => isAttributionComputed(entry));
    const downstreamTimes = [
      ...approvalMatches.map((entry) => parseIsoMs(entry.created_at_iso)),
      ...hardeningMatches.map((entry) => parseIsoMs(entry.created_at_iso)),
      ...executionMatches.map((entry) => parseIsoMs(entry.created_at_iso)),
      ...outcomeMatches.map((entry) => parseIsoMs(entry.filled_at_iso) ?? parseIsoMs(entry.created_at_iso)),
      ...attributionMatches.map((entry) => parseIsoMs(entry.created_at_iso)),
      ...opportunityMatches.map((entry) => parseIsoMs(entry.created_at_iso)),
    ].filter((value): value is number => value !== null && allocationCreatedAtMs !== null && value >= allocationCreatedAtMs);
    const earliestDownstreamAtMs = downstreamTimes.length > 0 ? Math.min(...downstreamTimes) : null;
    const decisionId = String(allocation.decision_id || "").trim();
    const candidateId = String(allocation.candidate_id || "").trim();
    const lifecycleId = String(allocation.trade_lifecycle_id || "").trim();
    const hasStableIds = decisionId.length > 0 && lifecycleId.length > 0;
    const ambiguousApprovals = [
      ...(decisionId.length > 0 ? approvalsByDecisionId.get(decisionId) || [] : []),
      ...(lifecycleId.length > 0 ? approvalsByLifecycleId.get(lifecycleId) || [] : []),
    ];
    const approvalCreatedButNotLinked = approvalMatches.length === 0 && ambiguousApprovals.length > 0;
    const identityMismatch = approvalCreatedButNotLinked || approvalMatches.some((entry) => String(entry.allocation_id || "").trim().length > 0 && entry.allocation_id !== allocation.allocation_id);
    let firstDownstreamStage: AllocationWriterStageKey | null = null;
    const stageFirstSeen = [
      { stage: "approval" as const, atMs: approvalMatches.length > 0 ? Math.min(...approvalMatches.map((entry) => parseIsoMs(entry.created_at_iso)).filter((value): value is number => value !== null)) : null },
      { stage: "hardening" as const, atMs: hardeningMatches.length > 0 ? Math.min(...hardeningMatches.map((entry) => parseIsoMs(entry.created_at_iso)).filter((value): value is number => value !== null)) : null },
      { stage: "execution" as const, atMs: executionMatches.length > 0 ? Math.min(...executionMatches.map((entry) => parseIsoMs(entry.created_at_iso)).filter((value): value is number => value !== null)) : null },
      { stage: "outcome" as const, atMs: outcomeMatches.length > 0 ? Math.min(...outcomeMatches.map((entry) => parseIsoMs(entry.filled_at_iso) ?? parseIsoMs(entry.created_at_iso)).filter((value): value is number => value !== null)) : null },
      { stage: "attribution" as const, atMs: attributionMatches.length > 0 ? Math.min(...attributionMatches.map((entry) => parseIsoMs(entry.created_at_iso)).filter((value): value is number => value !== null)) : null },
      { stage: "opportunity" as const, atMs: opportunityMatches.length > 0 ? Math.min(...opportunityMatches.map((entry) => parseIsoMs(entry.created_at_iso)).filter((value): value is number => value !== null)) : null },
    ].filter((entry) => entry.atMs !== null)
      .sort((left, right) => Number(left.atMs) - Number(right.atMs));
    if (stageFirstSeen.length > 0) {
      firstDownstreamStage = stageFirstSeen[0].stage;
    }
    let firstFailureStage: AllocationWriterStageKey | null = null;
    let failureReason: AllocationWriterFailureCategoryKey | null = null;
    if (!decisionId) {
      firstFailureStage = "allocation";
      failureReason = "missing_decision_id";
    } else if (!candidateId) {
      firstFailureStage = "allocation";
      failureReason = "missing_candidate_id";
    } else if (approvalCreatedButNotLinked) {
      firstFailureStage = "approval";
      failureReason = "approval_created_but_not_linked";
    } else if (approvalMatches.length === 0) {
      firstFailureStage = "approval";
      failureReason = "approval_not_created";
    } else if (hardeningMatches.length === 0) {
      firstFailureStage = "hardening";
      failureReason = "hardening_block_before_write";
    } else if (executionMatches.length === 0) {
      firstFailureStage = "execution";
      failureReason = "execution_fact_not_created";
    } else if (outcomeMatches.length === 0) {
      firstFailureStage = "outcome";
      failureReason = "outcome_not_created";
    } else if (attributionMatches.length === 0) {
      firstFailureStage = "attribution";
      failureReason = "attribution_not_created";
    } else if (opportunityMatches.length === 0) {
      firstFailureStage = "opportunity";
      failureReason = "opportunity_not_created";
    }
    const writerResult: AllocationWriterResult = failureReason === null ? "ok" : firstDownstreamStage !== null ? "degraded" : "failed";
    const latestAudit = latestAuditByAllocationId.get(allocation.allocation_id) || null;
    return {
      allocation,
      decisionId,
      candidateId,
      hasStableIds,
      approvalMatches,
      hardeningMatches,
      executionMatches,
      outcomeMatches,
      attributionMatches,
      opportunityMatches,
      hasAnyDownstream: approvalMatches.length > 0 || executionMatches.length > 0 || opportunityMatches.length > 0,
      multiWriteDecision: decisionId.length > 0 && multiWriteDecisionIds.has(decisionId),
      approvalCreatedButNotLinked,
      identityMismatch,
      firstDownstreamStage,
      firstFailureStage,
      failureReason,
      writerResult: latestAudit?.writer_result === "failed" ? "failed" : writerResult,
      latestAudit,
      latencyHours: allocationCreatedAtMs !== null && earliestDownstreamAtMs !== null ? toHours(earliestDownstreamAtMs - allocationCreatedAtMs) : null,
    };
  });

  const propagationToApprovalTotal = evaluations.filter((entry) => entry.approvalMatches.length > 0).length;
  const propagationToExecutionTotal = evaluations.filter((entry) => entry.executionMatches.length > 0).length;
  const propagationToAnyDownstreamTotal = evaluations.filter((entry) => entry.hasAnyDownstream).length;
  const latencyHours = evaluations
    .map((entry) => entry.latencyHours)
    .filter((value): value is number => value !== null);
  const missingDecisionIdTotal = evaluations.filter((entry) => entry.failureReason === "missing_decision_id").length;
  const missingCandidateIdTotal = evaluations.filter((entry) => entry.failureReason === "missing_candidate_id").length;
  const approvalNotCreatedTotal = evaluations.filter((entry) => entry.failureReason === "approval_not_created").length;
  const approvalCreatedButNotLinkedTotal = evaluations.filter((entry) => entry.failureReason === "approval_created_but_not_linked").length;
  const hardeningBlockTotal = evaluations.filter((entry) => entry.failureReason === "hardening_block_before_write").length;
  const executionFactNotCreatedTotal = evaluations.filter((entry) => entry.failureReason === "execution_fact_not_created").length;
  const outcomeNotCreatedTotal = evaluations.filter((entry) => entry.failureReason === "outcome_not_created").length;
  const attributionNotCreatedTotal = evaluations.filter((entry) => entry.failureReason === "attribution_not_created").length;
  const opportunityNotCreatedTotal = evaluations.filter((entry) => entry.failureReason === "opportunity_not_created").length;
  const unknownTotal = evaluations.filter((entry) => entry.failureReason === null && (entry.multiWriteDecision || entry.identityMismatch || !entry.hasAnyDownstream)).length;

  const taxonomySeed: Array<{ key: AllocationWriterFailureCategoryKey; label: string; total: number; instrumented: boolean }> = [
    { key: "missing_decision_id", label: "missing_decision_id", total: missingDecisionIdTotal, instrumented: true },
    { key: "missing_candidate_id", label: "missing_candidate_id", total: missingCandidateIdTotal, instrumented: true },
    { key: "approval_not_created", label: "approval_not_created", total: approvalNotCreatedTotal, instrumented: true },
    { key: "approval_created_but_not_linked", label: "approval_created_but_not_linked", total: approvalCreatedButNotLinkedTotal, instrumented: true },
    { key: "hardening_block_before_write", label: "hardening_block_before_write", total: hardeningBlockTotal, instrumented: true },
    { key: "execution_fact_not_created", label: "execution_fact_not_created", total: executionFactNotCreatedTotal, instrumented: true },
    { key: "outcome_not_created", label: "outcome_not_created", total: outcomeNotCreatedTotal, instrumented: true },
    { key: "attribution_not_created", label: "attribution_not_created", total: attributionNotCreatedTotal, instrumented: true },
    { key: "opportunity_not_created", label: "opportunity_not_created", total: opportunityNotCreatedTotal, instrumented: true },
    { key: "unknown", label: "unknown", total: unknownTotal, instrumented: true },
  ];
  const taxonomyTotal = taxonomySeed.reduce((sum, entry) => sum + entry.total, 0);
  const nativeErrorSeed: AllocationWriterAuditErrorCode[] = [
    "writer_timeout",
    "writer_append_failure",
    "writer_journal_error",
    "writer_identity_error",
    "writer_validation_error",
  ];
  const nativeErrorTotal = writerAuditEntries.filter((entry) => entry.writer_error_code !== "none").length;
  const dominantRootCause = decisionGapResolution.dominant_gap_cardinality?.by_root_cause[0] || null;
  const stateMachineCreatedTotal = nativeCreatedTotal > 0 ? nativeCreatedTotal : writtenTotal;
  const stateMachinePersistedTotal = nativePersistedTotal > 0 ? nativePersistedTotal : writtenTotal;
  const stateMachineApprovalCreatedTotal = evaluations.filter((entry) => entry.approvalMatches.length > 0).length;
  const stateMachineApprovalLinkedTotal = evaluations.filter((entry) => entry.approvalMatches.length > 0 && !entry.identityMismatch).length;
  const stateMachineHardeningReachedTotal = evaluations.filter((entry) => entry.hardeningMatches.length > 0).length;
  const stateMachineExecutionCreatedTotal = evaluations.filter((entry) => entry.executionMatches.length > 0).length;
  const stateMachineOutcomeCreatedTotal = evaluations.filter((entry) => entry.outcomeMatches.length > 0).length;
  const stateMachineAttributionCreatedTotal = evaluations.filter((entry) => entry.attributionMatches.length > 0).length;
  const stateMachineOpportunityCreatedTotal = evaluations.filter((entry) => entry.opportunityMatches.length > 0).length;
  const stateMachineClosedTotal = stateMachineOpportunityCreatedTotal;
  const stateMachineOpenTotal = Math.max(0, stateMachineCreatedTotal - stateMachineClosedTotal);
  const approvalIdTotal = evaluations.filter((entry) => entry.approvalMatches.some((match) => String(match.approval_id || "").trim().length > 0) || String(entry.allocation.approval_id || "").trim().length > 0).length;
  const executionIdTotal = evaluations.filter((entry) => entry.executionMatches.some((match) => String(match.execution_id || match.fact_id || "").trim().length > 0) || String(entry.allocation.execution_id || "").trim().length > 0).length;
  const outcomeIdTotal = evaluations.filter((entry) => entry.opportunityMatches.some((match) => String(match.outcome_id || match.entry_id || "").trim().length > 0) || entry.outcomeMatches.some((match) => String(match.outcome_id || "").trim().length > 0) || String(entry.allocation.outcome_id || "").trim().length > 0).length;
  const identityObservedTotal = allocationsWithDecisionId + allocationsWithCandidateId + allocationsWithTradeLifecycleId + approvalIdTotal + executionIdTotal + outcomeIdTotal;
  const topFailureCategory = [...taxonomySeed]
    .sort((left, right) => right.total - left.total)[0] || null;
  const allocationStageGapLedger = decisionGapResolution.gap_ledger.filter((entry) => entry.first_missing_stage === "allocation");
  const allocationStageGapRootCauses = [...allocationStageGapLedger.reduce((acc, entry) => {
    const rootCauseCode = String(entry.root_cause_code || "unknown").trim() || "unknown";
    const current = acc.get(rootCauseCode) || { open: 0, resolved: 0 };
    if (String(entry.status || "open") === "resolved") {
      current.resolved += 1;
    } else {
      current.open += 1;
    }
    acc.set(rootCauseCode, current);
    return acc;
  }, new Map<string, { open: number; resolved: number }>()).values()];
  const identifiedRootCauseTotal = allocationStageGapRootCauses.filter((entry) => entry.open + entry.resolved > 0).length;
  const correctedRootCauseTotal = allocationStageGapRootCauses.filter((entry) => entry.open === 0 && entry.resolved > 0).length;
  const allocationStageOpenGapTotal = allocationStageGapLedger.filter((entry) => String(entry.status || "open") !== "resolved").length;
  const allocationStageClosedGapTotal = allocationStageGapLedger.filter((entry) => String(entry.status || "open") === "resolved").length;
  const auditTimelineByAllocationId = writerAuditEntries.reduce((acc, entry) => {
    const allocationId = String(entry.allocation_id || "").trim();
    if (!allocationId) {
      return acc;
    }
    const current = acc.get(allocationId) || [];
    current.push(entry);
    acc.set(allocationId, current);
    return acc;
  }, new Map<string, AllocationWriterAuditEntry[]>());
  const nativeFailedAllocationIds = new Set<string>();
  const nativeClosedAllocationIds = new Set<string>();
  for (const [allocationId, timeline] of auditTimelineByAllocationId.entries()) {
    const ordered = [...timeline].sort((left, right) => {
      const leftMs = parseIsoMs(left.created_at_iso) ?? 0;
      const rightMs = parseIsoMs(right.created_at_iso) ?? 0;
      return leftMs - rightMs;
    });
    let seenFailure = false;
    for (const entry of ordered) {
      if (entry.writer_result === "failed") {
        seenFailure = true;
        nativeFailedAllocationIds.add(allocationId);
      }
      if (seenFailure && entry.writer_result === "persisted") {
        nativeClosedAllocationIds.add(allocationId);
      }
    }
  }

  return {
    dominant_root_cause_code: dominantRootCause?.root_cause_code || null,
    dominant_root_cause_label: dominantRootCause?.label || null,
    writer_coverage: {
      allocation_created_total: writerAuditEntries.length > 0 ? nativeCreatedTotal : null,
      allocation_persisted_total: writerAuditEntries.length > 0 ? nativePersistedTotal : null,
      allocation_failed_total: writerAuditEntries.length > 0 ? nativeFailedTotal : null,
      allocation_written_total: writtenTotal,
      allocation_write_rate_pct: nativeCreatedTotal > 0 ? asPercent(nativePersistedTotal, nativeCreatedTotal) : null,
      created_signal_instrumented: writerAuditEntries.length > 0,
      with_decision_id_total: allocationsWithDecisionId,
      with_candidate_id_total: allocationsWithCandidateId,
      with_trade_lifecycle_id_total: allocationsWithTradeLifecycleId,
      with_approval_id_total: allocationsWithApprovalId,
      decision_id_coverage_pct: asPercent(allocationsWithDecisionId, writtenTotal),
      candidate_id_coverage_pct: asPercent(allocationsWithCandidateId, writtenTotal),
      trade_lifecycle_id_coverage_pct: asPercent(allocationsWithTradeLifecycleId, writtenTotal),
      approval_id_seed_rate_pct: asPercent(allocationsWithApprovalId, writtenTotal),
    },
    state_machine: {
      allocation_created_total: stateMachineCreatedTotal,
      allocation_persisted_total: stateMachinePersistedTotal,
      approval_created_total: stateMachineApprovalCreatedTotal,
      approval_linked_total: stateMachineApprovalLinkedTotal,
      hardening_reached_total: stateMachineHardeningReachedTotal,
      execution_created_total: stateMachineExecutionCreatedTotal,
      outcome_created_total: stateMachineOutcomeCreatedTotal,
      attribution_created_total: stateMachineAttributionCreatedTotal,
      opportunity_created_total: stateMachineOpportunityCreatedTotal,
      allocation_closed_total: stateMachineClosedTotal,
      allocation_open_total: stateMachineOpenTotal,
      allocation_closure_rate_pct: asPercent(stateMachineClosedTotal, stateMachineCreatedTotal),
    },
    identity_propagation: {
      decision_id_total: allocationsWithDecisionId,
      candidate_id_total: allocationsWithCandidateId,
      trade_lifecycle_id_total: allocationsWithTradeLifecycleId,
      approval_id_total: approvalIdTotal,
      execution_id_total: executionIdTotal,
      outcome_id_total: outcomeIdTotal,
      identity_propagation_rate_pct: writtenTotal > 0 ? asPercent(identityObservedTotal, writtenTotal * 6) : 0,
    },
    writer_propagation: {
      allocation_written_total: writtenTotal,
      approval_created_total: propagationToApprovalTotal,
      execution_fact_total: propagationToExecutionTotal,
      downstream_fact_total: propagationToAnyDownstreamTotal,
      allocation_to_approval_rate_pct: asPercent(propagationToApprovalTotal, writtenTotal),
      allocation_to_execution_rate_pct: asPercent(propagationToExecutionTotal, writtenTotal),
      allocation_to_any_downstream_rate_pct: asPercent(propagationToAnyDownstreamTotal, writtenTotal),
    },
    writer_latency: {
      measured_allocation_total: latencyHours.length,
      measured_to: "first_downstream_fact",
      mean_hours: latencyHours.length > 0 ? average(latencyHours) : null,
      p50_hours: percentile(latencyHours, 0.5),
      p95_hours: percentile(latencyHours, 0.95),
      p99_hours: percentile(latencyHours, 0.99),
    },
    writer_failure_taxonomy: {
      inferred_unknown_total: unknownTotal,
      by_category: taxonomySeed.map((entry) => ({
        category_key: entry.key,
        label: entry.label,
        total: entry.total,
        share_pct: asPercent(entry.total, taxonomyTotal),
        instrumented: entry.instrumented,
      })),
    },
    closure_evidence: {
      identified_root_cause_total: identifiedRootCauseTotal,
      corrected_root_cause_total: correctedRootCauseTotal,
      root_cause_closure_rate_pct: asPercent(correctedRootCauseTotal, identifiedRootCauseTotal),
      open_gap_total: allocationStageOpenGapTotal,
      closed_gap_total: allocationStageClosedGapTotal,
      gap_closure_rate_pct: asPercent(allocationStageClosedGapTotal, allocationStageOpenGapTotal + allocationStageClosedGapTotal),
      native_failed_allocation_total: nativeFailedAllocationIds.size,
      native_closed_allocation_total: nativeClosedAllocationIds.size,
      native_closure_rate_pct: asPercent(nativeClosedAllocationIds.size, nativeFailedAllocationIds.size),
      top_cause_key: topFailureCategory?.key || null,
      top_cause_label: topFailureCategory?.label || null,
      top_fix: resolveAllocationWriterFailureRemediation(topFailureCategory?.key || null),
    },
    writer_native_errors: nativeErrorSeed.map((errorCode) => {
      const total = writerAuditEntries.filter((entry) => entry.writer_error_code === errorCode).length;
      return {
        error_code: errorCode,
        label: errorCode,
        total,
        share_pct: asPercent(total, nativeErrorTotal),
      };
    }),
    writer_provenance: evaluations
      .sort((left, right) => {
        if (left.writerResult !== right.writerResult) {
          return left.writerResult === "failed" ? -1 : right.writerResult === "failed" ? 1 : left.writerResult === "degraded" ? -1 : 1;
        }
        const leftCreatedAtMs = parseIsoMs(left.allocation.created_at_iso);
        const rightCreatedAtMs = parseIsoMs(right.allocation.created_at_iso);
        if (leftCreatedAtMs !== null && rightCreatedAtMs !== null && leftCreatedAtMs !== rightCreatedAtMs) {
          return rightCreatedAtMs - leftCreatedAtMs;
        }
        return left.allocation.allocation_id.localeCompare(right.allocation.allocation_id);
      })
      .slice(0, 20)
      .map((entry) => ({
        allocation_id: entry.allocation.allocation_id,
        decision_id: entry.allocation.decision_id,
        writer_version: entry.latestAudit?.writer_version || entry.allocation.allocator_version,
        writer_timestamp: entry.latestAudit?.writer_timestamp_iso || entry.allocation.created_at_iso,
        writer_result: entry.writerResult,
        first_downstream_stage: entry.firstDownstreamStage,
        first_failure_stage: entry.firstFailureStage,
        failure_reason: entry.failureReason,
      })),
  };
}

function buildDecisionGapReductionSnapshot(lifecycles: LifecycleAccumulator[]): DecisionGapReductionSnapshot {
  const incompleteCreatedLifecycles = lifecycles.filter((entry) => isCreatedDecisionLifecycle(entry) && !isCompleteDecisionLifecycle(entry));
  const counts = new Map<DecisionFirstMissingStageKey, number>(DECISION_GAP_STAGE_DEFINITIONS.map((stage) => [stage.stage_key, 0]));

  for (const lifecycle of incompleteCreatedLifecycles) {
    const firstMissingStage = resolveFirstMissingStage(lifecycle);
    if (!firstMissingStage) {
      continue;
    }
    counts.set(firstMissingStage, (counts.get(firstMissingStage) || 0) + 1);
  }

  return {
    incomplete_decision_total: incompleteCreatedLifecycles.length,
    by_stage: DECISION_GAP_STAGE_DEFINITIONS.map((stage) => {
      const blockedDecisionTotal = counts.get(stage.stage_key) || 0;
      return {
        stage_key: stage.stage_key,
        label: stage.label,
        gap_label: stage.gap_label,
        blocked_decision_total: blockedDecisionTotal,
        share_pct: asPercent(blockedDecisionTotal, incompleteCreatedLifecycles.length),
        exemplar_decisions: incompleteCreatedLifecycles
          .filter((entry) => resolveFirstMissingStage(entry) === stage.stage_key)
          .filter((entry): entry is LifecycleAccumulator & { decision_id: string } => typeof entry.decision_id === "string" && entry.decision_id.trim().length > 0)
          .sort((left, right) => {
            const fragmentDelta = observedFragments(right) - observedFragments(left);
            if (fragmentDelta !== 0) {
              return fragmentDelta;
            }
            return left.decision_id.localeCompare(right.decision_id);
          })
          .slice(0, 10)
          .map((entry) => ({
            decision_id: entry.decision_id,
            observed_fragments: observedFragments(entry),
          })),
      };
    }),
  };
}

function resolveLifecycleInfo(payload: {
  trade_lifecycle_id: string | null;
  decision_id: string | null;
  fallback_id: string;
  causality_confidence?: unknown;
}): {
  lifecycleKey: string;
  tradeLifecycleId: string | null;
  decisionId: string | null;
  confidence: CausalityConfidence;
} {
  const tradeLifecycleId = typeof payload.trade_lifecycle_id === "string" && payload.trade_lifecycle_id.trim().length > 0
    ? payload.trade_lifecycle_id.trim()
    : null;
  const decisionId = typeof payload.decision_id === "string" && payload.decision_id.trim().length > 0
    ? payload.decision_id.trim()
    : null;
  return {
    lifecycleKey: tradeLifecycleId || decisionId || payload.fallback_id,
    tradeLifecycleId,
    decisionId,
    confidence: normalizeCausalityConfidence(payload.causality_confidence, Boolean(tradeLifecycleId)),
  };
}

function getOrCreateAccumulator(store: Map<string, LifecycleAccumulator>, info: ReturnType<typeof resolveLifecycleInfo>): LifecycleAccumulator {
  const existing = store.get(info.lifecycleKey);
  if (existing) {
    existing.trade_lifecycle_id = existing.trade_lifecycle_id || info.tradeLifecycleId;
    existing.decision_id = existing.decision_id || info.decisionId;
    existing.confidence = preferredConfidence(existing.confidence, info.confidence);
    return existing;
  }
  const created: LifecycleAccumulator = {
    lifecycle_key: info.lifecycleKey,
    trade_lifecycle_id: info.tradeLifecycleId,
    decision_id: info.decisionId,
    confidence: info.confidence,
    first_observed_at_ms: null,
    last_observed_at_ms: null,
    allocation_count: 0,
    approval_count: 0,
    execution_count: 0,
    opportunity_count: 0,
    has_allocation: false,
    has_approval: false,
    has_hardening: false,
    has_execution: false,
    has_outcome: false,
    has_attribution: false,
    has_opportunity: false,
    allocation_confidence: null,
    approval_confidence: null,
    hardening_confidence: null,
    execution_confidence: null,
    outcome_confidence: null,
    attribution_confidence: null,
    opportunity_confidence: null,
    allocation_first_seen_at_ms: null,
    approval_first_seen_at_ms: null,
    hardening_first_seen_at_ms: null,
    execution_first_seen_at_ms: null,
    outcome_first_seen_at_ms: null,
    attribution_first_seen_at_ms: null,
    opportunity_first_seen_at_ms: null,
  };
  store.set(info.lifecycleKey, created);
  return created;
}

function markStage(
  accumulator: LifecycleAccumulator,
  stage: "allocation" | "approval" | "hardening" | "execution" | "outcome" | "attribution" | "opportunity",
  confidence: CausalityConfidence,
  observedAtMs: number | null,
): void {
  if (observedAtMs !== null) {
    accumulator.first_observed_at_ms = accumulator.first_observed_at_ms === null
      ? observedAtMs
      : Math.min(accumulator.first_observed_at_ms, observedAtMs);
    accumulator.last_observed_at_ms = accumulator.last_observed_at_ms === null
      ? observedAtMs
      : Math.max(accumulator.last_observed_at_ms, observedAtMs);
  }
  if (stage === "allocation") {
    accumulator.has_allocation = true;
    if (observedAtMs !== null && (accumulator.allocation_first_seen_at_ms === null || observedAtMs < accumulator.allocation_first_seen_at_ms)) {
      accumulator.allocation_first_seen_at_ms = observedAtMs;
    }
    accumulator.allocation_confidence = accumulator.allocation_confidence
      ? preferredConfidence(accumulator.allocation_confidence, confidence)
      : confidence;
    return;
  }
  if (stage === "approval") {
    accumulator.has_approval = true;
    if (observedAtMs !== null && (accumulator.approval_first_seen_at_ms === null || observedAtMs < accumulator.approval_first_seen_at_ms)) {
      accumulator.approval_first_seen_at_ms = observedAtMs;
    }
    accumulator.approval_confidence = accumulator.approval_confidence
      ? preferredConfidence(accumulator.approval_confidence, confidence)
      : confidence;
    return;
  }
  if (stage === "hardening") {
    accumulator.has_hardening = true;
    if (observedAtMs !== null && (accumulator.hardening_first_seen_at_ms === null || observedAtMs < accumulator.hardening_first_seen_at_ms)) {
      accumulator.hardening_first_seen_at_ms = observedAtMs;
    }
    accumulator.hardening_confidence = accumulator.hardening_confidence
      ? preferredConfidence(accumulator.hardening_confidence, confidence)
      : confidence;
    return;
  }
  if (stage === "execution") {
    accumulator.has_execution = true;
    if (observedAtMs !== null && (accumulator.execution_first_seen_at_ms === null || observedAtMs < accumulator.execution_first_seen_at_ms)) {
      accumulator.execution_first_seen_at_ms = observedAtMs;
    }
    accumulator.execution_confidence = accumulator.execution_confidence
      ? preferredConfidence(accumulator.execution_confidence, confidence)
      : confidence;
    return;
  }
  if (stage === "outcome") {
    accumulator.has_outcome = true;
    if (observedAtMs !== null && (accumulator.outcome_first_seen_at_ms === null || observedAtMs < accumulator.outcome_first_seen_at_ms)) {
      accumulator.outcome_first_seen_at_ms = observedAtMs;
    }
    accumulator.outcome_confidence = accumulator.outcome_confidence
      ? preferredConfidence(accumulator.outcome_confidence, confidence)
      : confidence;
    return;
  }
  if (stage === "attribution") {
    accumulator.has_attribution = true;
    if (observedAtMs !== null && (accumulator.attribution_first_seen_at_ms === null || observedAtMs < accumulator.attribution_first_seen_at_ms)) {
      accumulator.attribution_first_seen_at_ms = observedAtMs;
    }
    accumulator.attribution_confidence = accumulator.attribution_confidence
      ? preferredConfidence(accumulator.attribution_confidence, confidence)
      : confidence;
    return;
  }
  accumulator.has_opportunity = true;
  if (observedAtMs !== null && (accumulator.opportunity_first_seen_at_ms === null || observedAtMs < accumulator.opportunity_first_seen_at_ms)) {
    accumulator.opportunity_first_seen_at_ms = observedAtMs;
  }
  accumulator.opportunity_confidence = accumulator.opportunity_confidence
    ? preferredConfidence(accumulator.opportunity_confidence, confidence)
    : confidence;
}

function resolveAllocationBackfillObservedAtMs(entry: LifecycleAccumulator): number | null {
  const downstreamStageTimes = [
    entry.approval_first_seen_at_ms,
    entry.hardening_first_seen_at_ms,
    entry.execution_first_seen_at_ms,
    entry.outcome_first_seen_at_ms,
    entry.attribution_first_seen_at_ms,
  ].filter((value): value is number => value !== null);
  if (downstreamStageTimes.length === 0) {
    return null;
  }
  return Math.min(...downstreamStageTimes);
}

function shouldBackfillAllocationStage(entry: LifecycleAccumulator): boolean {
  if (entry.has_allocation) {
    return false;
  }
  return entry.has_approval
    || entry.has_hardening
    || entry.has_execution
    || entry.has_outcome
    || entry.has_attribution;
}

function backfillAllocationStageFromDownstreamEvidence(lifecycles: LifecycleAccumulator[]): void {
  for (const lifecycle of lifecycles) {
    if (!shouldBackfillAllocationStage(lifecycle)) {
      continue;
    }
    markStage(lifecycle, "allocation", "BACKFILLED", resolveAllocationBackfillObservedAtMs(lifecycle));
  }
}

function readCausalityConfidence(entry: ApprovalDecisionJournalEntry | AllocationDecisionJournalEntry | ExecutionFactJournalEntry | OpportunityCostJournalEntry): unknown {
  const direct = asRecord(entry as unknown as Record<string, unknown>);
  if (typeof direct.causality_confidence === "string") {
    return direct.causality_confidence;
  }
  const approvalContext = asRecord(direct.approval_context);
  if (typeof approvalContext.causality_confidence === "string") {
    return approvalContext.causality_confidence;
  }
  const marketContext = asRecord(direct.market_context);
  if (typeof marketContext.causality_confidence === "string") {
    return marketContext.causality_confidence;
  }
  return null;
}

function hasHardeningContext(entry: ApprovalDecisionJournalEntry): boolean {
  const approvalStatus = String(entry.approval_status || "").trim().toLowerCase();
  if (
    entry.source_event_category === "mt5_live_order_stale_approval_cancelled"
    || approvalStatus.includes("stale")
    || approvalStatus.includes("cancel")
  ) {
    return false;
  }
  return Object.keys(asRecord(entry.hardening)).length > 0;
}

function buildDecisionFrictionAnalyticsFromOpportunities(
  opportunities: OpportunityCostJournalEntry[],
  sinceDays: number,
): DecisionFrictionAnalyticsSnapshot {
  let capitalBasisAvailableRows = 0;
  let capitalBasisMissingRows = 0;

  const decisionGroups = [...opportunities.reduce((acc, entry) => {
    const decisionId = String(entry.decision_id || "").trim();
    if (!decisionId) {
      return acc;
    }
    const capitalBasisUsd = resolveOpportunityCapitalBasisUsd(entry);
    if (capitalBasisUsd !== null && capitalBasisUsd > 0) {
      capitalBasisAvailableRows += 1;
    } else {
      capitalBasisMissingRows += 1;
    }
    const current = acc.get(decisionId) || {
      decision_id: decisionId,
      trade_lifecycle_id: entry.trade_lifecycle_id,
      gate_name: String(entry.gate_name || "unknown").trim() || "unknown",
      blocked_count: 0,
      pending_count: 0,
      scored_count: 0,
      predicted_alpha_bps_total: 0,
      predicted_alpha_bps_sum_count: 0,
      opportunity_cost_bps_total: 0,
      missed_alpha_bps_total: 0,
      capital_impact_usd_total: 0,
      correlation_keys: new Set<string>(),
      last_created_at_iso: null as string | null,
    };
    current.blocked_count += 1;
    if (entry.status === "scored") {
      current.scored_count += 1;
    } else {
      current.pending_count += 1;
    }
    const predictedAlphaBps = toNumberOrNull(entry.predicted_alpha_bps);
    if (predictedAlphaBps !== null) {
      current.predicted_alpha_bps_total += predictedAlphaBps;
      current.predicted_alpha_bps_sum_count += 1;
    }
    current.opportunity_cost_bps_total += toNumberOrNull(entry.ex_post_opportunity_cost_bps) || 0;
    current.missed_alpha_bps_total += toNumberOrNull(entry.opportunity_attribution.missed_alpha_bps) || 0;
    current.capital_impact_usd_total += capitalBasisUsd !== null && capitalBasisUsd > 0
      ? computeOpportunityCapitalImpactUsd(entry)
      : 0;
    const correlationKey = String(asRecord(asRecord(entry.market_context).correlation).correlation_key || "").trim();
    if (correlationKey) {
      current.correlation_keys.add(correlationKey);
    }
    const createdAtMs = parseIsoMs(entry.created_at_iso);
    const currentLastCreatedAtMs = parseIsoMs(current.last_created_at_iso);
    if (createdAtMs !== null && (currentLastCreatedAtMs === null || createdAtMs > currentLastCreatedAtMs)) {
      current.last_created_at_iso = entry.created_at_iso;
    }
    acc.set(decisionId, current);
    return acc;
  }, new Map<string, {
    decision_id: string;
    trade_lifecycle_id: string | null;
    gate_name: string;
    blocked_count: number;
    pending_count: number;
    scored_count: number;
    predicted_alpha_bps_total: number;
    predicted_alpha_bps_sum_count: number;
    opportunity_cost_bps_total: number;
    missed_alpha_bps_total: number;
    capital_impact_usd_total: number;
    correlation_keys: Set<string>;
    last_created_at_iso: string | null;
  }>()).values()];

  const repeatedDecisionGroups = decisionGroups.filter((entry) => entry.blocked_count > 1);
  const topDecisions: DecisionFrictionDecisionRow[] = repeatedDecisionGroups
    .map((entry) => ({
      decision_id: entry.decision_id,
      trade_lifecycle_id: entry.trade_lifecycle_id || null,
      gate_name: entry.gate_name,
      blocked_count: entry.blocked_count,
      unique_correlation_keys: entry.correlation_keys.size,
      pending_count: entry.pending_count,
      scored_count: entry.scored_count,
      predicted_alpha_bps_total: Number(entry.predicted_alpha_bps_total.toFixed(1)),
      predicted_alpha_bps_avg: entry.predicted_alpha_bps_sum_count > 0
        ? Number((entry.predicted_alpha_bps_total / entry.predicted_alpha_bps_sum_count).toFixed(1))
        : 0,
      opportunity_cost_bps_total: Number(entry.opportunity_cost_bps_total.toFixed(1)),
      missed_alpha_bps_total: Number(entry.missed_alpha_bps_total.toFixed(1)),
      capital_impact_usd_total: Number(entry.capital_impact_usd_total.toFixed(2)),
      last_created_at_iso: entry.last_created_at_iso,
    }))
    .sort((left, right) => right.blocked_count - left.blocked_count)
    .slice(0, 5);

  const topCostDecisions: DecisionFrictionDecisionRow[] = decisionGroups
    .map((entry) => ({
      decision_id: entry.decision_id,
      trade_lifecycle_id: entry.trade_lifecycle_id || null,
      gate_name: entry.gate_name,
      blocked_count: entry.blocked_count,
      unique_correlation_keys: entry.correlation_keys.size,
      pending_count: entry.pending_count,
      scored_count: entry.scored_count,
      predicted_alpha_bps_total: Number(entry.predicted_alpha_bps_total.toFixed(1)),
      predicted_alpha_bps_avg: entry.predicted_alpha_bps_sum_count > 0
        ? Number((entry.predicted_alpha_bps_total / entry.predicted_alpha_bps_sum_count).toFixed(1))
        : 0,
      opportunity_cost_bps_total: Number(entry.opportunity_cost_bps_total.toFixed(1)),
      missed_alpha_bps_total: Number(entry.missed_alpha_bps_total.toFixed(1)),
      capital_impact_usd_total: Number(entry.capital_impact_usd_total.toFixed(2)),
      last_created_at_iso: entry.last_created_at_iso,
    }))
    .sort((left, right) => {
      if (right.capital_impact_usd_total !== left.capital_impact_usd_total) {
        return right.capital_impact_usd_total - left.capital_impact_usd_total;
      }
      if (right.missed_alpha_bps_total !== left.missed_alpha_bps_total) {
        return right.missed_alpha_bps_total - left.missed_alpha_bps_total;
      }
      if (right.opportunity_cost_bps_total !== left.opportunity_cost_bps_total) {
        return right.opportunity_cost_bps_total - left.opportunity_cost_bps_total;
      }
      return right.blocked_count - left.blocked_count;
    })
    .slice(0, 10);

  const gateGroups = [...decisionGroups.reduce((acc, entry) => {
    const gateName = entry.gate_name;
    const current = acc.get(gateName) || {
      gate_name: gateName,
      blocked_count: 0,
      unique_decision_count: 0,
      repeated_decision_count: 0,
      predicted_alpha_bps_total: 0,
      opportunity_cost_bps_total: 0,
      missed_alpha_bps_total: 0,
      capital_impact_usd_total: 0,
    };
    current.blocked_count += entry.blocked_count;
    current.unique_decision_count += 1;
    if (entry.blocked_count > 1) {
      current.repeated_decision_count += 1;
    }
    current.predicted_alpha_bps_total += entry.predicted_alpha_bps_total;
    current.opportunity_cost_bps_total += entry.opportunity_cost_bps_total;
    current.missed_alpha_bps_total += entry.missed_alpha_bps_total;
    current.capital_impact_usd_total += entry.capital_impact_usd_total;
    acc.set(gateName, current);
    return acc;
  }, new Map<string, {
    gate_name: string;
    blocked_count: number;
    unique_decision_count: number;
    repeated_decision_count: number;
    predicted_alpha_bps_total: number;
    opportunity_cost_bps_total: number;
    missed_alpha_bps_total: number;
    capital_impact_usd_total: number;
  }>()).values()];

  const topGates: DecisionFrictionGateRow[] = gateGroups
    .map((entry) => ({
      gate_name: entry.gate_name,
      blocked_count: entry.blocked_count,
      unique_decision_count: entry.unique_decision_count,
      repeated_decision_count: entry.repeated_decision_count,
      predicted_alpha_bps_total: Number(entry.predicted_alpha_bps_total.toFixed(1)),
      opportunity_cost_bps_total: Number(entry.opportunity_cost_bps_total.toFixed(1)),
      missed_alpha_bps_total: Number(entry.missed_alpha_bps_total.toFixed(1)),
      capital_impact_usd_total: Number(entry.capital_impact_usd_total.toFixed(2)),
      capital_impact_per_decision: computeCapitalImpactPerDecision(entry.capital_impact_usd_total, entry.unique_decision_count),
    }))
    .sort((left, right) => right.blocked_count - left.blocked_count)
    .slice(0, 5);

  const topCostGates: DecisionFrictionGateRow[] = gateGroups
    .map((entry) => ({
      gate_name: entry.gate_name,
      blocked_count: entry.blocked_count,
      unique_decision_count: entry.unique_decision_count,
      repeated_decision_count: entry.repeated_decision_count,
      predicted_alpha_bps_total: Number(entry.predicted_alpha_bps_total.toFixed(1)),
      opportunity_cost_bps_total: Number(entry.opportunity_cost_bps_total.toFixed(1)),
      missed_alpha_bps_total: Number(entry.missed_alpha_bps_total.toFixed(1)),
      capital_impact_usd_total: Number(entry.capital_impact_usd_total.toFixed(2)),
      capital_impact_per_decision: computeCapitalImpactPerDecision(entry.capital_impact_usd_total, entry.unique_decision_count),
    }))
    .sort((left, right) => {
      if (right.capital_impact_usd_total !== left.capital_impact_usd_total) {
        return right.capital_impact_usd_total - left.capital_impact_usd_total;
      }
      if (right.missed_alpha_bps_total !== left.missed_alpha_bps_total) {
        return right.missed_alpha_bps_total - left.missed_alpha_bps_total;
      }
      if (right.opportunity_cost_bps_total !== left.opportunity_cost_bps_total) {
        return right.opportunity_cost_bps_total - left.opportunity_cost_bps_total;
      }
      return right.blocked_count - left.blocked_count;
    })
    .slice(0, 5);

  const blockedTotal = opportunities.length;
  const uniqueDecisionTotal = decisionGroups.length;
  const repeatedDecisionTotal = repeatedDecisionGroups.length;
  const repeatedBlockedTotal = repeatedDecisionGroups.reduce((sum, entry) => sum + entry.blocked_count, 0);
  const opportunityCostBpsTotal = decisionGroups.reduce((sum, entry) => sum + entry.opportunity_cost_bps_total, 0);
  const missedAlphaBpsTotal = decisionGroups.reduce((sum, entry) => sum + entry.missed_alpha_bps_total, 0);
  const capitalImpactUsdTotal = decisionGroups.reduce((sum, entry) => sum + entry.capital_impact_usd_total, 0);
  const capitalBasisRowTotal = capitalBasisAvailableRows + capitalBasisMissingRows;
  const dominantGate = topGates[0] || null;
  const dominantDecision = topDecisions[0] || null;
  const dominantCostDecision = topCostDecisions[0] || null;
  const dominantCostGate = topCostGates[0] || null;
  const watchlistGateNames = ["routing-score-zero", "engine-v4-off"];
  const watchlistGates: DecisionFrictionWatchlistGateRow[] = watchlistGateNames
    .map((gateName) => {
      const gate = gateGroups.find((entry) => entry.gate_name === gateName);
      if (!gate) {
        return null;
      }
      return {
        gate_name: gateName,
        blocked_total: gate.blocked_count,
        unique_decision_total: gate.unique_decision_count,
        repeated_decision_total: gate.repeated_decision_count,
        blocked_share_pct: asPercent(gate.blocked_count, blockedTotal),
      };
    })
    .filter((entry): entry is DecisionFrictionWatchlistGateRow => entry !== null);

  return {
    generated_at_iso: new Date().toISOString(),
    window_days: sinceDays,
    blocked_total: blockedTotal,
    unique_decision_total: uniqueDecisionTotal,
    repeated_decision_total: repeatedDecisionTotal,
    repeated_blocked_total: repeatedBlockedTotal,
    repeated_blocked_share_pct: asPercent(repeatedBlockedTotal, blockedTotal),
    opportunity_cost_bps_total: Number(opportunityCostBpsTotal.toFixed(1)),
    missed_alpha_bps_total: Number(missedAlphaBpsTotal.toFixed(1)),
    capital_impact_usd_total: Number(capitalImpactUsdTotal.toFixed(2)),
    capital_impact_per_decision: computeCapitalImpactPerDecision(capitalImpactUsdTotal, uniqueDecisionTotal),
    capital_impact_coverage_pct: asPercent(capitalBasisAvailableRows, capitalBasisRowTotal),
    capital_basis_available_rows: capitalBasisAvailableRows,
    capital_basis_missing_rows: capitalBasisMissingRows,
    dominant_gate_name: dominantGate?.gate_name || null,
    dominant_gate_blocked_total: dominantGate?.blocked_count || 0,
    dominant_gate_share_pct: dominantGate ? asPercent(dominantGate.blocked_count, blockedTotal) : 0,
    dominant_cost_gate_name: dominantCostGate?.gate_name || null,
    dominant_cost_gate_capital_impact_usd: dominantCostGate?.capital_impact_usd_total || 0,
    dominant_decision_id: dominantDecision?.decision_id || null,
    dominant_decision_gate_name: dominantDecision?.gate_name || null,
    dominant_decision_blocked_total: dominantDecision?.blocked_count || 0,
    dominant_decision_share_pct: dominantDecision ? asPercent(dominantDecision.blocked_count, blockedTotal) : 0,
    dominant_cost_decision_id: dominantCostDecision?.decision_id || null,
    dominant_cost_decision_gate_name: dominantCostDecision?.gate_name || null,
    dominant_cost_decision_opportunity_cost_bps: dominantCostDecision?.opportunity_cost_bps_total || 0,
    dominant_cost_decision_missed_alpha_bps: dominantCostDecision?.missed_alpha_bps_total || 0,
    dominant_cost_decision_capital_impact_usd: dominantCostDecision?.capital_impact_usd_total || 0,
    watchlist_gates: watchlistGates,
    top_decisions: topDecisions,
    top_gates: topGates,
    top_cost_decisions: topCostDecisions,
    top_cost_gates: topCostGates,
  };
}

export async function buildDecisionFrictionAnalyticsSnapshot(options?: {
  sinceDays?: number;
}): Promise<DecisionFrictionAnalyticsSnapshot> {
  const sinceDays = Math.max(1, Math.min(365, Math.round(Number(options?.sinceDays || 30))));
  const opportunities = await readOpportunityCostJournalEntries({ limit: 2000, sinceDays });
  return buildDecisionFrictionAnalyticsFromOpportunities(opportunities, sinceDays);
}

export async function buildTradeLifecycleHealthSnapshot(options?: TradeLifecycleHealthSnapshotOptions): Promise<TradeLifecycleHealthSnapshot> {
  const sinceDays = Math.max(1, Math.min(365, Math.round(Number(options?.sinceDays || 30))));
  await Promise.all([
    backfillApprovalDecisionJournalFromCanonicalSource({ sinceDays, limit: 2000 }).catch(() => ({
      canonical_rows: 0,
      journal_rows: 0,
      appended_rows: 0,
    })),
    backfillExecutionFactJournalFromCanonicalSource({ sinceDays, limit: 2000 }).catch(() => ({
      canonical_rows: 0,
      journal_rows: 0,
      appended_rows: 0,
    })),
  ]);
  const [approvals, allocations, executionFacts, opportunities, allocationWriterAudits] = await Promise.all([
    readApprovalDecisionJournalEntries({ limit: 2000, sinceDays }),
    readAllocationDecisionJournalEntries({ limit: 2000, sinceDays }),
    readExecutionFactJournalEntries({ limit: 2000, sinceDays }),
    readOpportunityCostJournalEntries({ limit: 2000, sinceDays }),
    readAllocationWriterAuditEntries({ limit: 5000, sinceDays }),
  ]);
  const decisionFriction = buildDecisionFrictionAnalyticsFromOpportunities(opportunities, sinceDays);

  const lifecycleMap = new Map<string, LifecycleAccumulator>();

  for (const entry of approvals) {
    const info = resolveLifecycleInfo({
      trade_lifecycle_id: entry.trade_lifecycle_id,
      decision_id: entry.decision_id,
      fallback_id: entry.approval_fact_id,
      causality_confidence: readCausalityConfidence(entry),
    });
    const lifecycle = getOrCreateAccumulator(lifecycleMap, info);
    const observedAtMs = parseIsoMs(entry.created_at_iso);
    lifecycle.approval_count += 1;
    markStage(lifecycle, "approval", info.confidence, observedAtMs);
    if (hasHardeningContext(entry)) {
      markStage(lifecycle, "hardening", info.confidence, observedAtMs);
    }
  }

  for (const entry of allocations) {
    const info = resolveLifecycleInfo({
      trade_lifecycle_id: entry.trade_lifecycle_id,
      decision_id: entry.decision_id,
      fallback_id: entry.allocation_id,
      causality_confidence: readCausalityConfidence(entry),
    });
    const lifecycle = getOrCreateAccumulator(lifecycleMap, info);
    const observedAtMs = parseIsoMs(entry.created_at_iso);
    lifecycle.allocation_count += 1;
    markStage(lifecycle, "allocation", info.confidence, observedAtMs);
  }

  for (const entry of executionFacts) {
    const info = resolveLifecycleInfo({
      trade_lifecycle_id: entry.trade_lifecycle_id,
      decision_id: entry.decision_id,
      fallback_id: entry.fact_id,
      causality_confidence: readCausalityConfidence(entry),
    });
    const lifecycle = getOrCreateAccumulator(lifecycleMap, info);
    const observedAtMs = parseIsoMs(entry.created_at_iso);
    lifecycle.execution_count += 1;
    markStage(lifecycle, "execution", info.confidence, observedAtMs);
    if (hasExecutionOutcomePayload(entry)) {
      markStage(lifecycle, "outcome", info.confidence, parseIsoMs(entry.filled_at_iso) ?? observedAtMs);
    }
    if (isAttributionComputed(entry)) {
      markStage(lifecycle, "attribution", info.confidence, observedAtMs);
    }
  }

  for (const entry of opportunities) {
    const info = resolveLifecycleInfo({
      trade_lifecycle_id: entry.trade_lifecycle_id,
      decision_id: entry.decision_id,
      fallback_id: entry.entry_id,
      causality_confidence: readCausalityConfidence(entry),
    });
    const lifecycle = getOrCreateAccumulator(lifecycleMap, info);
    const observedAtMs = parseIsoMs(entry.created_at_iso);
    lifecycle.opportunity_count += 1;
    markStage(lifecycle, "opportunity", info.confidence, observedAtMs);
  }

  const lifecycles = [...lifecycleMap.values()];
  backfillAllocationStageFromDownstreamEvidence(lifecycles);
  const lifecycleTotal = lifecycles.length;
  const decisionJourneyCompletion = buildDecisionJourneyCompletionSnapshot(lifecycles);
  const decisionGapReduction = buildDecisionGapReductionSnapshot(lifecycles);
  const decisionGapResolution = buildDecisionGapResolutionSnapshot(lifecycles);
  const allocationWriterClosure = buildAllocationWriterClosureSnapshot(allocations, approvals, executionFacts, opportunities, allocationWriterAudits, decisionGapResolution);
  const executionGapDiagnostic = buildExecutionGapDiagnosticSnapshot(
    lifecycles,
    allocations,
    approvals,
    executionFacts,
    opportunities,
    allocationWriterAudits,
    decisionGapResolution,
  );
  const terminalDecisionStateDiagnostic = buildTerminalDecisionStateDiagnosticSnapshot(
    lifecycles,
    allocations,
    approvals,
    executionFacts,
    opportunities,
    allocationWriterAudits,
  );
  const decisionEvidenceQuality = buildDecisionEvidenceQualitySnapshot(lifecycles);
  const allocationLinkedTotal = lifecycles.filter((entry) => entry.has_allocation).length;
  const approvalLinkedTotal = lifecycles.filter((entry) => entry.has_approval).length;
  const hardeningLinkedTotal = lifecycles.filter((entry) => entry.has_hardening).length;
  const executionLinkedTotal = lifecycles.filter((entry) => entry.has_execution).length;
  const outcomeLinkedTotal = lifecycles.filter((entry) => entry.has_outcome).length;
  const attributionLinkedTotal = lifecycles.filter((entry) => entry.has_attribution).length;
  const opportunityLinkedTotal = lifecycles.filter((entry) => entry.has_opportunity).length;
  const crossObjectLifecycleTotal = lifecycles.filter((entry) => entry.has_execution && entry.has_opportunity).length;
  const decisionContinuityLinks = buildDecisionContinuityLinks(lifecycles);
  const decisionContinuityScorePct = average(decisionContinuityLinks.map((entry) => entry.continuity_score_pct));
  const truthReliability = buildTruthReliabilitySnapshot({
    decisionContinuityPct: decisionContinuityScorePct,
    evidenceQualityPct: decisionEvidenceQuality.score_pct,
    spineMatchRatePct: options?.truthReliabilityInput?.spineMatchRatePct ?? 0,
    runtimeTruthSnapshotAgeMs: options?.truthReliabilityInput?.runtimeTruthSnapshotAgeMs ?? null,
    canonicalSpineSnapshotAgeMs: options?.truthReliabilityInput?.canonicalSpineSnapshotAgeMs ?? null,
    runtimeTruthTtlMs: options?.truthReliabilityInput?.runtimeTruthTtlMs ?? 15_000,
    canonicalSpineTtlMs: options?.truthReliabilityInput?.canonicalSpineTtlMs ?? 60_000,
  });
  const decisionGovernance = buildDecisionGovernanceSnapshot(
    decisionJourneyCompletion,
    decisionGapResolution,
    decisionEvidenceQuality,
    allocationWriterClosure,
  );

  const causalityConfidence = initializeConfidenceSummary();
  const allocationConfidence = initializeConfidenceSummary();
  const approvalConfidence = initializeConfidenceSummary();
  const hardeningConfidence = initializeConfidenceSummary();
  const executionConfidence = initializeConfidenceSummary();
  const outcomeConfidence = initializeConfidenceSummary();
  const attributionConfidence = initializeConfidenceSummary();
  const opportunityConfidence = initializeConfidenceSummary();

  for (const lifecycle of lifecycles) {
    incrementConfidence(causalityConfidence, lifecycle.confidence);
    incrementConfidence(allocationConfidence, lifecycle.allocation_confidence);
    incrementConfidence(approvalConfidence, lifecycle.approval_confidence);
    incrementConfidence(hardeningConfidence, lifecycle.hardening_confidence);
    incrementConfidence(executionConfidence, lifecycle.execution_confidence);
    incrementConfidence(outcomeConfidence, lifecycle.outcome_confidence);
    incrementConfidence(attributionConfidence, lifecycle.attribution_confidence);
    incrementConfidence(opportunityConfidence, lifecycle.opportunity_confidence);
  }

  return assertTradeLifecycleHealthSnapshot({
    schema_version: TRADE_LIFECYCLE_HEALTH_SCHEMA_VERSION,
    generated_at_iso: new Date().toISOString(),
    window_days: sinceDays,
    source_diagnostics: {
      rows_scanned: approvals.length + allocations.length + executionFacts.length + opportunities.length,
      rows_returned: lifecycleTotal,
    },
    lifecycle_total: lifecycleTotal,
    decision_journey_completion: decisionJourneyCompletion,
    decision_gap_reduction: decisionGapReduction,
    decision_gap_resolution: decisionGapResolution,
    allocation_writer_closure: allocationWriterClosure,
    execution_gap_diagnostic: executionGapDiagnostic,
    terminal_decision_state_diagnostic: terminalDecisionStateDiagnostic,
    decision_governance: decisionGovernance,
    link_coverage_score_pct: average([
      asPercent(allocationLinkedTotal, lifecycleTotal),
      asPercent(approvalLinkedTotal, lifecycleTotal),
      asPercent(hardeningLinkedTotal, lifecycleTotal),
      asPercent(executionLinkedTotal, lifecycleTotal),
      asPercent(outcomeLinkedTotal, lifecycleTotal),
      asPercent(attributionLinkedTotal, lifecycleTotal),
      asPercent(opportunityLinkedTotal, lifecycleTotal),
    ]),
    decision_continuity_score_pct: decisionContinuityScorePct,
    decision_evidence_quality: decisionEvidenceQuality,
    cross_object_lifecycle_total: crossObjectLifecycleTotal,
    allocation_link_rate_pct: asPercent(allocationLinkedTotal, lifecycleTotal),
    approval_link_rate_pct: asPercent(approvalLinkedTotal, lifecycleTotal),
    hardening_link_rate_pct: asPercent(hardeningLinkedTotal, lifecycleTotal),
    execution_link_rate_pct: asPercent(executionLinkedTotal, lifecycleTotal),
    outcome_link_rate_pct: asPercent(outcomeLinkedTotal, lifecycleTotal),
    attribution_link_rate_pct: asPercent(attributionLinkedTotal, lifecycleTotal),
    opportunity_link_rate_pct: asPercent(opportunityLinkedTotal, lifecycleTotal),
    allocation_linked_total: allocationLinkedTotal,
    approval_linked_total: approvalLinkedTotal,
    hardening_linked_total: hardeningLinkedTotal,
    execution_linked_total: executionLinkedTotal,
    outcome_linked_total: outcomeLinkedTotal,
    attribution_linked_total: attributionLinkedTotal,
    opportunity_linked_total: opportunityLinkedTotal,
    causality_confidence: causalityConfidence,
    link_confidence: {
      allocation: allocationConfidence,
      approval: approvalConfidence,
      hardening: hardeningConfidence,
      execution: executionConfidence,
      outcome: outcomeConfidence,
      attribution: attributionConfidence,
      opportunity: opportunityConfidence,
    },
    decision_continuity_links: decisionContinuityLinks,
    top_decision_friction: decisionFriction.top_decisions,
    top_friction_by_gate: decisionFriction.top_gates,
    decision_friction: decisionFriction,
    tri_score: truthReliability.score_pct,
    tri_status: truthReliability.status,
    tri_cap: truthReliability.cap_pct,
    tri_continuity: truthReliability.components.decision_continuity_pct,
    tri_evidence: truthReliability.components.evidence_quality_pct,
    tri_spine_match: truthReliability.components.spine_match_rate_pct,
    tri_freshness: truthReliability.components.snapshot_freshness_pct,
    truth_reliability_index: truthReliability,
  });
}