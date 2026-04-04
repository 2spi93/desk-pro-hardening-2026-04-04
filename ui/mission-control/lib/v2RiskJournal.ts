import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type V2RiskJournalEntry = {
  id: string;
  createdAtIso: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  action: string;
  detail: string;
  meta?: Record<string, unknown>;
};

const JOURNAL_DIR = process.env.V2_RISK_JOURNAL_DIR || "/tmp";
const JOURNAL_FILE = process.env.V2_RISK_JOURNAL_FILE || "mission-control-v2-risk-journal.jsonl";

function filePath(): string {
  return path.join(JOURNAL_DIR, JOURNAL_FILE);
}

export async function appendV2RiskJournalEntry(entry: V2RiskJournalEntry): Promise<void> {
  const target = filePath();
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(entry)}\n`, "utf-8");
}

export async function readV2RiskJournalEntries(options?: {
  symbol?: string;
  timeframe?: string;
  strategy?: string;
  limit?: number;
}): Promise<V2RiskJournalEntry[]> {
  const symbol = String(options?.symbol || "").trim().toUpperCase();
  const timeframe = String(options?.timeframe || "").trim();
  const strategy = String(options?.strategy || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Math.round(Number(options?.limit || 40))));

  try {
    const content = await readFile(filePath(), "utf-8");
    const rows = content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as V2RiskJournalEntry;
        } catch {
          return null;
        }
      })
      .filter((row): row is V2RiskJournalEntry => row !== null)
      .filter((row) => {
        if (symbol && String(row.symbol || "").toUpperCase() !== symbol) return false;
        if (timeframe && String(row.timeframe || "") !== timeframe) return false;
        if (strategy && String(row.strategy || "").toLowerCase() !== strategy) return false;
        return true;
      });

    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}
