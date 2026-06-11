import { promises as fs } from "node:fs";
import path from "node:path";

import { buildTradeLifecycleHealthSnapshot } from "../lib/tradeLifecycleHealth";

type LifecyclePublishGateReport = {
  schema_version: "lifecycle-publish-gate/v1";
  generated_at_iso: string;
  window_days: number;
  publish_blocked: boolean;
  block_reasons: string[];
  lifecycle_gate: {
    terminal_publish_blocked: boolean;
    execution_publish_blocked: boolean;
    review_blocking_total: number;
    delegated_readiness_gate: "scan:replay-certification-gate";
  };
  terminal_decision_state_diagnostic: unknown;
  execution_gap_diagnostic: unknown;
  decision_gap_resolution: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function writeReport(reportPath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const sinceDays = Math.max(1, Number(process.env.LIFECYCLE_GATE_SINCE_DAYS || 30));
  const reportPath = process.env.CONSTITUTIONAL_REPORT_PATH || path.resolve(process.cwd(), "artifacts/lifecycle-publish-gate.report.json");

  const snapshot = await buildTradeLifecycleHealthSnapshot({ sinceDays });
  const terminalDecisionStateDiagnostic = asRecord(snapshot.terminal_decision_state_diagnostic);
  const executionGapDiagnostic = asRecord(snapshot.execution_gap_diagnostic);
  const reviewRequired = asRecord(terminalDecisionStateDiagnostic.review_required);

  const terminalPublishBlocked = Boolean(terminalDecisionStateDiagnostic.publish_blocked);
  const executionBlockedDecisionTotal = Number(executionGapDiagnostic.blocked_decision_total || 0);
  const executionPublishBlocked = executionBlockedDecisionTotal > 0;
  const reviewBlockingTotal = Number(reviewRequired.blocking_total || 0);
  const terminalBlockReasons = asArray<string>(terminalDecisionStateDiagnostic.publish_block_reasons);
  const executionFamilyReasons = asArray<Record<string, unknown>>(executionGapDiagnostic.blocked_family_breakdown).flatMap((entry) => {
    const familyKey = String(entry.family_key || "").trim();
    const decisionTotal = Number(entry.decision_total || 0);
    if (!familyKey || decisionTotal <= 0) {
      return [];
    }
    return [`execution_gap:${familyKey}:${decisionTotal}`];
  });

  const report: LifecyclePublishGateReport = {
    schema_version: "lifecycle-publish-gate/v1",
    generated_at_iso: new Date().toISOString(),
    window_days: sinceDays,
    publish_blocked: terminalPublishBlocked || executionPublishBlocked,
    block_reasons: [
      ...terminalBlockReasons,
      ...executionFamilyReasons,
    ],
    lifecycle_gate: {
      terminal_publish_blocked: terminalPublishBlocked,
      execution_publish_blocked: executionPublishBlocked,
      review_blocking_total: reviewBlockingTotal,
      delegated_readiness_gate: "scan:replay-certification-gate",
    },
    terminal_decision_state_diagnostic: snapshot.terminal_decision_state_diagnostic || null,
    execution_gap_diagnostic: snapshot.execution_gap_diagnostic || null,
    decision_gap_resolution: snapshot.decision_gap_resolution,
  };

  await writeReport(reportPath, report as unknown as Record<string, unknown>);

  if (report.publish_blocked) {
    console.error(`BLOCK lifecycle publish gate: ${report.block_reasons.join(" | ") || "unknown_reason"}`);
    process.exit(1);
  }

  console.log("PASS lifecycle publish gate: terminal lifecycle truth is clear and execution debt is zero");
}

main().catch(async (error) => {
  const reportPath = process.env.CONSTITUTIONAL_REPORT_PATH || path.resolve(process.cwd(), "artifacts/lifecycle-publish-gate.report.json");
  await writeReport(reportPath, {
    schema_version: "lifecycle-publish-gate/v1",
    generated_at_iso: new Date().toISOString(),
    publish_blocked: true,
    error: error instanceof Error ? error.message : String(error || "unknown_error"),
  });
  console.error(error instanceof Error ? error.stack || error.message : String(error || "unknown_error"));
  process.exitCode = 1;
});