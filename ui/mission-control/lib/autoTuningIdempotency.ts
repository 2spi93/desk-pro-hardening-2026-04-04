import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type IdempotencyRecord = {
  keyHash: string;
  createdAtMs: number;
  status: number;
  payload: unknown;
};

const IDEMPOTENCY_DIR = process.env.AUTO_TUNING_IDEMPOTENCY_DIR || "/tmp";
const IDEMPOTENCY_FILE = process.env.AUTO_TUNING_IDEMPOTENCY_FILE || "mission-control-auto-tuning-idempotency.json";

function filePath(): string {
  return path.join(IDEMPOTENCY_DIR, IDEMPOTENCY_FILE);
}

async function readRecords(): Promise<IdempotencyRecord[]> {
  try {
    const content = await readFile(filePath(), "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed as IdempotencyRecord[] : [];
  } catch {
    return [];
  }
}

async function writeRecords(records: IdempotencyRecord[]): Promise<void> {
  const out = records.slice(-300);
  await mkdir(path.dirname(filePath()), { recursive: true });
  await writeFile(filePath(), JSON.stringify(out), "utf-8");
}

export async function getCachedIdempotentResult(keyHash: string, ttlMs: number): Promise<IdempotencyRecord | null> {
  const now = Date.now();
  const records = await readRecords();
  const fresh = records.filter((row) => now - row.createdAtMs <= ttlMs);
  if (fresh.length !== records.length) {
    await writeRecords(fresh);
  }
  const existing = fresh.find((row) => row.keyHash === keyHash);
  return existing || null;
}

export async function saveIdempotentResult(keyHash: string, status: number, payload: unknown, ttlMs: number): Promise<void> {
  const now = Date.now();
  const records = await readRecords();
  const fresh = records.filter((row) => now - row.createdAtMs <= ttlMs && row.keyHash !== keyHash);
  fresh.push({
    keyHash,
    createdAtMs: now,
    status,
    payload,
  });
  await writeRecords(fresh);
}