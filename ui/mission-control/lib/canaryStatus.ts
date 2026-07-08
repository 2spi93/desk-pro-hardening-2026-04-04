import { promises as fs } from "fs";
import path from "path";

// Reads the one-shot SELL canary artifacts written by
// scripts/txt_sell_canary_autoexec_oneshot.py and the shadow fresh-episode
// alert. Read-only: never mutates markers, never triggers execution.
const PROOF_RENEWAL_DIR =
  process.env.TXT_PROOF_RENEWAL_DIR || path.resolve(process.cwd(), "../../var/proof_renewal");

const ARM_MARKER = "sell_canary_autoexec.ARMED";
const CONSUMED_MARKER = "sell_canary_autoexec.CONSUMED";
const FRESH_ALERT = "shadow_fresh_episode_alert.json";
const OUTCOME_PREFIX = "sell_canary_autoexec_outcome_";

export type CanaryState =
  | "ARMED_WAITING"
  | "ARM_EXPIRED"
  | "FIRED"
  | "FIRE_ERROR"
  | "DISARMED";

export type CanaryStatusSnapshot = {
  generated_at: string;
  state: CanaryState;
  armed: boolean;
  consumed: boolean;
  expired: boolean;
  seconds_to_expiry: number | null;
  arm: Record<string, unknown> | null;
  fresh_episode: {
    present: boolean;
    fresh: boolean;
    side: string | null;
    status: string | null;
    net_bps: number | null;
    expires_at: string | null;
    seconds_left: number | null;
    episode_key: string | null;
  } | null;
  last_outcome: Record<string, unknown> | null;
  notional_note: string;
};

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(PROOF_RENEWAL_DIR, file), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(path.join(PROOF_RENEWAL_DIR, file));
    return true;
  } catch {
    return false;
  }
}

async function latestOutcome(): Promise<Record<string, unknown> | null> {
  try {
    const entries = await fs.readdir(PROOF_RENEWAL_DIR);
    const outcomes = entries
      .filter((name) => name.startsWith(OUTCOME_PREFIX) && name.endsWith(".json"))
      .sort();
    if (outcomes.length === 0) {
      return null;
    }
    return readJson(outcomes[outcomes.length - 1]);
  } catch {
    return null;
  }
}

function toNum(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTs(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export async function buildCanaryStatus(now = Date.now()): Promise<CanaryStatusSnapshot> {
  const [arm, consumed, freshAlert, outcome] = await Promise.all([
    readJson(ARM_MARKER),
    exists(CONSUMED_MARKER),
    readJson(FRESH_ALERT),
    latestOutcome(),
  ]);

  const armed = arm !== null;
  const expiryMs = arm ? parseTs(arm.arm_expires_at) : null;
  const secondsToExpiry = expiryMs !== null ? Math.round((expiryMs - now) / 1000) : null;
  const expired = expiryMs !== null && now >= expiryMs;

  let fresh_episode: CanaryStatusSnapshot["fresh_episode"] = null;
  if (freshAlert) {
    const exp = parseTs(freshAlert.expires_at);
    const isFreshSell =
      freshAlert.status === "FRESH_SHADOW_EPISODE" &&
      String(freshAlert.side).toLowerCase() === "sell" &&
      exp !== null &&
      now < exp;
    fresh_episode = {
      present: true,
      fresh: Boolean(isFreshSell),
      side: (freshAlert.side as string) ?? null,
      status: (freshAlert.status as string) ?? null,
      net_bps: toNum(freshAlert.net_expected_edge_bps),
      expires_at: (freshAlert.expires_at as string) ?? null,
      seconds_left: exp !== null ? Math.round((exp - now) / 1000) : null,
      episode_key: (freshAlert.episode_key as string) ?? null,
    };
  }

  let state: CanaryState;
  if (consumed || outcome) {
    const result = String(outcome?.result ?? "");
    if (result === "FIRE_ERROR") {
      state = "FIRE_ERROR";
    } else if (result === "ARM_EXPIRED") {
      state = "ARM_EXPIRED";
    } else if (result === "FIRED") {
      state = "FIRED";
    } else {
      state = consumed ? "FIRED" : "DISARMED";
    }
  } else if (armed && expired) {
    state = "ARM_EXPIRED";
  } else if (armed) {
    state = "ARMED_WAITING";
  } else {
    state = "DISARMED";
  }

  return {
    generated_at: new Date(now).toISOString(),
    state,
    armed,
    consumed,
    expired,
    seconds_to_expiry: secondsToExpiry,
    arm,
    fresh_episode,
    last_outcome: outcome,
    notional_note: "Ordre minimum BingX ≈ 0,0001 BTC (~$6,2) — le plus petit test réel possible.",
  };
}
