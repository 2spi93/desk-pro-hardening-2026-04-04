import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

// Runtime Decision Time-Window Reader v1.
// Le lecteur historique scannait le fichier ENTIER depuis le début et gardait les N
// dernières lignes (cap dur 2000) — O(taille_fichier), et plafonnait la couverture
// temporelle à ~quelques heures quel que soit le besoin (24h/72h). Ce lecteur lit
// depuis la FIN par chunks et s'arrête dès qu'il a couvert la fenêtre temporelle
// demandée (cutoff) ou atteint une borne de sécurité. Le descripteur est TOUJOURS
// fermé (finally) — c'est ce qui empêche la fuite de streams qui saturait le pool I/O.
function _journalEnvInt(name: string, def: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return def;
  return Math.max(min, Math.min(max, Math.round(raw)));
}
// Cap de lignes (remplace l'ancien cap dur 2000). Configurable.
const RUNTIME_JOURNAL_MAX_TAIL_LINES = _journalEnvInt("RUNTIME_DECISION_MAX_TAIL_LINES", 50_000, 1_000, 500_000);
// Borne d'octets lus depuis la fin (sécurité anti-re-bloat). Défaut 128MB ≈ ~40h à 11KB/entrée.
const RUNTIME_JOURNAL_MAX_TAIL_BYTES = _journalEnvInt("RUNTIME_DECISION_MAX_TAIL_BYTES", 134_217_728, 8_388_608, 1_073_741_824);
const RUNTIME_JOURNAL_TAIL_CHUNK = 8 * 1024 * 1024; // 8MB

async function readJournalTailFromEnd(input: {
  symbol: string;
  timeframe: string;
  strategy: string;
  action: string;
  cutoffMs: number;
  limit: number;
}): Promise<V2RiskJournalEntry[]> {
  const target = filePath();
  let fh: FileHandle | null = null;
  try {
    fh = await open(target, "r");
    const { size } = await fh.stat();
    const matched: V2RiskJournalEntry[] = []; // newest -> oldest
    let position = size;
    let pending = ""; // fragment de ligne dont le début est dans un chunk plus ancien
    let bytesRead = 0;
    let reachedCutoff = false;

    while (
      position > 0
      && matched.length < input.limit
      && bytesRead < RUNTIME_JOURNAL_MAX_TAIL_BYTES
      && !reachedCutoff
    ) {
      const readSize = Math.min(RUNTIME_JOURNAL_TAIL_CHUNK, position);
      position -= readSize;
      bytesRead += readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, position);
      const text = buf.toString("utf-8") + pending;
      const lines = text.split("\n");
      pending = lines.shift() ?? ""; // 1er élément = ligne incomplète (suite dans chunk antérieur)
      for (let i = lines.length - 1; i >= 0 && matched.length < input.limit; i--) {
        const line = lines[i];
        if (!line) continue;
        let row: V2RiskJournalEntry;
        try { row = JSON.parse(line) as V2RiskJournalEntry; } catch { continue; }
        if (input.cutoffMs > 0) {
          const createdAtMs = Date.parse(String(row.createdAtIso || ""));
          if (Number.isFinite(createdAtMs) && createdAtMs < input.cutoffMs) {
            reachedCutoff = true;
            break;
          }
        }
        if (!matchesJournalEntry(row, input)) continue;
        matched.push(row);
      }
    }
    // début de fichier atteint : traiter le dernier fragment
    if (position === 0 && pending && !reachedCutoff && matched.length < input.limit) {
      try {
        const row = JSON.parse(pending) as V2RiskJournalEntry;
        let keep = true;
        if (input.cutoffMs > 0) {
          const createdAtMs = Date.parse(String(row.createdAtIso || ""));
          if (Number.isFinite(createdAtMs) && createdAtMs < input.cutoffMs) keep = false;
        }
        if (keep && matchesJournalEntry(row, input)) matched.push(row);
      } catch { /* ignore */ }
    }
    return matched; // newest -> oldest (même ordre que l'ancien queue.reverse())
  } finally {
    if (fh) {
      await fh.close().catch(() => undefined);
    }
  }
}

export type V2RiskJournalEntry = {
  id: string;
  createdAtIso: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  action: string;
  detail: string;
  decisionOutcome?: "correct" | "false_positive" | "unknown";
  meta?: Record<string, unknown>;
};

type V2RiskJournalCache = {
  filePath: string;
  mtimeMs: number;
  size: number;
  rows: V2RiskJournalEntry[];
};

let journalCache: V2RiskJournalCache | null = null;

const OPERATIONAL_REFUSAL_CODES = new Set([
  "engine-v4-off",
  "fallback-mode",
  "routing-blocked",
  "routing-score-zero",
  "runtime-kill-switch-active",
]);

function normalizeDecisionCode(row: V2RiskJournalEntry): string {
  const meta = asRecord(row.meta);
  const decisionAudit = asRecord(meta.decision_audit);
  return String(decisionAudit.code || "").trim().toLowerCase() || "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRefusalAction(action: string): boolean {
  return action === "execution-v7-blocked"
    || action === "execution-disabled-policy"
    || action === "execution-disabled-fallback"
    || action === "execution-disabled-routing";
}

export function isOpportunityEligibleRefusalEntry(row: V2RiskJournalEntry): boolean {
  const action = String(row.action || "").trim().toLowerCase();
  if (!isRefusalAction(action)) {
    return false;
  }
  if (action === "execution-v7-blocked") {
    return true;
  }
  const decisionCode = normalizeDecisionCode(row);
  return !OPERATIONAL_REFUSAL_CODES.has(decisionCode);
}

function filePath(): string {
  const journalDir = process.env.V2_RISK_JOURNAL_DIR || "/tmp";
  const journalFile = process.env.V2_RISK_JOURNAL_FILE || "mission-control-v2-risk-journal.jsonl";
  return path.join(journalDir, journalFile);
}

async function loadAllEntries(): Promise<V2RiskJournalEntry[]> {
  const target = filePath();

  try {
    const metadata = await stat(target);
    if (
      journalCache
      && journalCache.filePath === target
      && journalCache.mtimeMs === metadata.mtimeMs
      && journalCache.size === metadata.size
    ) {
      return journalCache.rows;
    }

    const content = await readFile(target, "utf-8");
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
      .filter((row): row is V2RiskJournalEntry => row !== null);

    journalCache = {
      filePath: target,
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      rows,
    };
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCache = null;
      return [];
    }
    throw error;
  }
}

async function streamTailMatchingEntries(input: {
  symbol: string;
  timeframe: string;
  strategy: string;
  action: string;
  cutoffMs: number;
  limit: number;
}): Promise<V2RiskJournalEntry[]> {
  const target = filePath();
  try {
    const lines = readline.createInterface({
      input: createReadStream(target, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    const queue: V2RiskJournalEntry[] = [];
    for await (const line of lines) {
      if (!line) {
        continue;
      }
      try {
        const row = JSON.parse(line) as V2RiskJournalEntry;
        if (!matchesJournalEntry(row, input)) {
          continue;
        }
        queue.push(row);
        if (queue.length > input.limit) {
          queue.shift();
        }
      } catch {
        continue;
      }
    }
    return queue.reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function scanV2RiskJournalDerivedActionIds(options?: {
  sinceDays?: number;
  postProducerStartIso?: string | null;
}): Promise<{
  executionOutcomeSourceIds: Set<string>;
  refusalSourceIdsRaw: Set<string>;
  refusalSourceIdsEligible: Set<string>;
  refusalSourceIdsRawPostProducer: Set<string>;
  operationalRefusalCountsByCode: Map<string, number>;
  operationalRefusalCountsByCodePostProducer: Map<string, number>;
}> {
  const sinceDays = Math.max(0, Math.min(365, Number(options?.sinceDays || 0)));
  const cutoffMs = sinceDays > 0 ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;
  const postProducerStartMs = Date.parse(String(options?.postProducerStartIso || ""));
  const hasPostProducerStart = Number.isFinite(postProducerStartMs);
  const target = filePath();
  const executionOutcomeSourceIds = new Set<string>();
  const refusalSourceIdsRaw = new Set<string>();
  const refusalSourceIdsEligible = new Set<string>();
  const refusalSourceIdsRawPostProducer = new Set<string>();
  const operationalRefusalCountsByCode = new Map<string, number>();
  const operationalRefusalCountsByCodePostProducer = new Map<string, number>();
  try {
    const lines = readline.createInterface({
      input: createReadStream(target, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line) {
        continue;
      }
      try {
        const row = JSON.parse(line) as V2RiskJournalEntry;
        const createdAtMs = Date.parse(String(row.createdAtIso || ""));
        if (cutoffMs > 0 && Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) {
          continue;
        }
        const action = String(row.action || "").trim().toLowerCase();
        if (action.startsWith("execution-v7-outcome-")) {
          executionOutcomeSourceIds.add(String(row.id || "").trim());
          continue;
        }
        if (isRefusalAction(action)) {
          const sourceId = String(row.id || "").trim();
          if (!sourceId) {
            continue;
          }
          const decisionCode = normalizeDecisionCode(row);
          refusalSourceIdsRaw.add(sourceId);
          if (isOpportunityEligibleRefusalEntry(row)) {
            refusalSourceIdsEligible.add(sourceId);
          } else {
            operationalRefusalCountsByCode.set(decisionCode, (operationalRefusalCountsByCode.get(decisionCode) || 0) + 1);
          }
          if (hasPostProducerStart && createdAtMs >= postProducerStartMs) {
            refusalSourceIdsRawPostProducer.add(sourceId);
            if (!isOpportunityEligibleRefusalEntry(row)) {
              operationalRefusalCountsByCodePostProducer.set(decisionCode, (operationalRefusalCountsByCodePostProducer.get(decisionCode) || 0) + 1);
            }
          }
        }
      } catch {
        continue;
      }
    }
    return {
      executionOutcomeSourceIds,
      refusalSourceIdsRaw,
      refusalSourceIdsEligible,
      refusalSourceIdsRawPostProducer,
      operationalRefusalCountsByCode,
      operationalRefusalCountsByCodePostProducer,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        executionOutcomeSourceIds,
        refusalSourceIdsRaw,
        refusalSourceIdsEligible,
        refusalSourceIdsRawPostProducer,
        operationalRefusalCountsByCode,
        operationalRefusalCountsByCodePostProducer,
      };
    }
    return {
      executionOutcomeSourceIds,
      refusalSourceIdsRaw,
      refusalSourceIdsEligible,
      refusalSourceIdsRawPostProducer,
      operationalRefusalCountsByCode,
      operationalRefusalCountsByCodePostProducer,
    };
  }
}

function matchesJournalEntry(
  row: V2RiskJournalEntry,
  input: {
    symbol: string;
    timeframe: string;
    strategy: string;
    action: string;
    cutoffMs: number;
  },
): boolean {
  if (input.symbol && String(row.symbol || "").toUpperCase() !== input.symbol) return false;
  if (input.timeframe && String(row.timeframe || "") !== input.timeframe) return false;
  if (input.strategy && String(row.strategy || "").toLowerCase() !== input.strategy) return false;
  if (input.action && String(row.action || "").toLowerCase() !== input.action) return false;
  if (input.cutoffMs > 0) {
    const createdAtMs = Date.parse(String(row.createdAtIso || ""));
    if (Number.isFinite(createdAtMs) && createdAtMs < input.cutoffMs) return false;
  }
  return true;
}

export async function appendV2RiskJournalEntry(entry: V2RiskJournalEntry): Promise<void> {
  const target = filePath();
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(entry)}\n`, "utf-8");
  journalCache = null;
}

export async function readV2RiskJournalEntries(options?: {
  symbol?: string;
  timeframe?: string;
  strategy?: string;
  limit?: number;
  sinceDays?: number;
  action?: string;
}): Promise<V2RiskJournalEntry[]> {
  const symbol = String(options?.symbol || "").trim().toUpperCase();
  const timeframe = String(options?.timeframe || "").trim();
  const strategy = String(options?.strategy || "").trim().toLowerCase();
  // Cap configurable (ancien cap dur 2000 supprimé) : permet de couvrir 24h/72h.
  const limit = Math.max(1, Math.min(RUNTIME_JOURNAL_MAX_TAIL_LINES, Math.round(Number(options?.limit || 40))));
  const sinceDays = Math.max(0, Math.min(90, Number(options?.sinceDays || 0)));
  const action = String(options?.action || "").trim().toLowerCase();
  const cutoffMs = sinceDays > 0 ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0;

  try {
    // Lecture depuis la FIN, bornée par la fenêtre temporelle (cutoff) — O(fenêtre), pas O(fichier).
    return await readJournalTailFromEnd({ symbol, timeframe, strategy, action, cutoffMs, limit });
  } catch (error) {
    // Fichier absent = vide légitime ; toute autre erreur est propagée (pas de [] silencieux qui
    // ferait conclure faussement coveredHours=0 / BLOCKED_BY_DATA).
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
