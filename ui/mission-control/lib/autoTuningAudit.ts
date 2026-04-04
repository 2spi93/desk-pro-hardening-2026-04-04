import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type AutoTuningAuditRecord = {
  id: string;
  timestampIso: string;
  actor: string;
  dryRun: boolean;
  status: "accepted" | "rejected" | "failed";
  recommendationCount: number;
  summary: string;
  requestHash?: string;
  idempotencyKeyHash?: string;
  signedAtIso?: string;
  appliedBy?: string;
  resultHash?: string;
};

const AUDIT_DIR = process.env.AUTO_TUNING_AUDIT_DIR || "/tmp";
const AUDIT_FILE = process.env.AUTO_TUNING_AUDIT_FILE || "mission-control-auto-tuning-audit.jsonl";

function getAuditPath(): string {
  return path.join(AUDIT_DIR, AUDIT_FILE);
}

export async function appendAutoTuningAudit(record: AutoTuningAuditRecord): Promise<void> {
  const auditPath = getAuditPath();
  await mkdir(path.dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, "utf-8");
}

export async function readAutoTuningAudit(limit = 30): Promise<AutoTuningAuditRecord[]> {
  const auditPath = getAuditPath();
  try {
    const content = await readFile(auditPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const rows = lines
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line) as AutoTuningAuditRecord;
        } catch {
          return null;
        }
      })
      .filter((row): row is AutoTuningAuditRecord => row !== null)
      .reverse();
    return rows;
  } catch {
    return [];
  }
}