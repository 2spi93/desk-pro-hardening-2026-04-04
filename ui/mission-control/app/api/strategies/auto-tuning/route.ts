import { NextResponse } from "next/server";
import { createHash, createHmac } from "node:crypto";

import { appendAutoTuningAudit, readAutoTuningAudit } from "../../../../lib/autoTuningAudit";
import { getCachedIdempotentResult, saveIdempotentResult } from "../../../../lib/autoTuningIdempotency";
import { cpFetch, getControlPlaneToken, readJsonFromResponseSafe } from "../../../../lib/controlPlane";

type RecommendationPayload = {
  strategyId: string;
  targetWeightPct: number;
  confidence?: number;
  recommendation?: string;
  rationale?: string;
};

type WritebackOptions = {
  minConfidence: number;
  maxRecommendations: number;
  weightFloorPct: number;
  weightCapPct: number;
  renormalizeTo100: boolean;
};

function isEnabled(): boolean {
  const raw = String(process.env.AUTO_TUNING_WRITEBACK_ENABLED || "").toLowerCase();
  return raw === "1" || raw === "true";
}

function getControlPlanePath(): string {
  return process.env.CONTROL_PLANE_AUTO_TUNING_PATH || "/v1/strategies/weights/auto-tune";
}

function getAdminHeaderName(): string {
  return (process.env.AUTO_TUNING_ADMIN_HEADER || "x-auto-tuning-admin-key").toLowerCase();
}

function getAdminKey(): string {
  return String(process.env.AUTO_TUNING_ADMIN_KEY || "").trim();
}

function getSignatureSecret(adminKey: string): string {
  return String(process.env.AUTO_TUNING_HMAC_SECRET || "").trim() || adminKey;
}

function isUpstreamSigningEnabled(): boolean {
  const raw = String(process.env.AUTO_TUNING_SIGN_UPSTREAM || "1").toLowerCase();
  return raw === "1" || raw === "true";
}

function isAdminRequiredForDryRun(): boolean {
  const raw = String(process.env.AUTO_TUNING_ADMIN_REQUIRED_FOR_DRYRUN || "").toLowerCase();
  return raw === "1" || raw === "true";
}

function isSignatureRequired(): boolean {
  const raw = String(process.env.AUTO_TUNING_REQUIRE_SIGNATURE || "").toLowerCase();
  return raw === "1" || raw === "true";
}

function idempotencyTtlMs(): number {
  const raw = Number(process.env.AUTO_TUNING_IDEMPOTENCY_TTL_SEC || 3600);
  const sec = Number.isFinite(raw) ? Math.max(30, Math.min(24 * 3600, Math.round(raw))) : 3600;
  return sec * 1000;
}

function hashIdempotencyKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function parseOptions(body: Record<string, unknown>): WritebackOptions {
  const minConfidenceRaw = Number(body.minConfidence);
  const maxRecommendationsRaw = Number(body.maxRecommendations);
  const weightFloorPctRaw = Number(body.weightFloorPct);
  const weightCapPctRaw = Number(body.weightCapPct);
  const renormalizeTo100 = Boolean(body.renormalizeTo100);

  const minConfidence = Number.isFinite(minConfidenceRaw) ? Math.max(0, Math.min(1, minConfidenceRaw)) : 0;
  const maxRecommendations = Number.isFinite(maxRecommendationsRaw)
    ? Math.max(1, Math.min(32, Math.round(maxRecommendationsRaw)))
    : 32;
  const weightFloorPct = Number.isFinite(weightFloorPctRaw) ? Math.max(0, Math.min(100, weightFloorPctRaw)) : 0;
  const weightCapPct = Number.isFinite(weightCapPctRaw)
    ? Math.max(weightFloorPct, Math.min(100, weightCapPctRaw))
    : 100;

  return {
    minConfidence,
    maxRecommendations,
    weightFloorPct,
    weightCapPct,
    renormalizeTo100,
  };
}

function applyOptions(rows: RecommendationPayload[], options: WritebackOptions): RecommendationPayload[] {
  let out = rows
    .filter((row) => (row.confidence ?? 1) >= options.minConfidence)
    .slice(0, options.maxRecommendations)
    .map((row) => ({
      ...row,
      targetWeightPct: Math.max(options.weightFloorPct, Math.min(options.weightCapPct, row.targetWeightPct)),
    }));

  if (options.renormalizeTo100 && out.length > 0) {
    const total = out.reduce((sum, row) => sum + row.targetWeightPct, 0);
    if (total > 0) {
      out = out.map((row) => ({
        ...row,
        targetWeightPct: Number(((row.targetWeightPct / total) * 100).toFixed(4)),
      }));
    }
  }

  return out;
}

function normalizeRecommendations(input: unknown): RecommendationPayload[] {
  if (!Array.isArray(input)) return [];
  const mapped: Array<RecommendationPayload | null> = input.map((item) => {
      const row = (item || {}) as Record<string, unknown>;
      const strategyId = String(row.strategyId || "").trim();
      const targetWeightPct = Number(row.targetWeightPct);
      const confidence = row.confidence == null ? undefined : Number(row.confidence);
      const recommendation = row.recommendation == null ? undefined : String(row.recommendation);
      const rationale = row.rationale == null ? undefined : String(row.rationale);
      if (!strategyId || !Number.isFinite(targetWeightPct)) return null;
      return {
        strategyId,
        targetWeightPct: Math.max(0, Math.min(100, targetWeightPct)),
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, Number(confidence))) : undefined,
        recommendation,
        rationale,
      };
    });
  return mapped.filter(Boolean).slice(0, 32) as RecommendationPayload[];
}

export async function GET(): Promise<NextResponse> {
  const entries = await readAutoTuningAudit(40);
  return NextResponse.json({
    enabled: isEnabled(),
    adminRequiredForDryRun: isAdminRequiredForDryRun(),
    signatureRequired: isSignatureRequired(),
    upstreamSigningEnabled: isUpstreamSigningEnabled(),
    entries,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const enabled = isEnabled();
  const token = await getControlPlaneToken();
  const actor = token ? "authenticated" : "anonymous";
  const adminHeaderName = getAdminHeaderName();
  const adminHeaderValue = request.headers.get(adminHeaderName) || "";
  const adminKey = getAdminKey();
  const signatureSecret = getSignatureSecret(adminKey);
  const idempotencyKey = request.headers.get("x-idempotency-key") || "";
  const idempotencyKeyHash = idempotencyKey ? hashIdempotencyKey(idempotencyKey) : "";

  if (idempotencyKey) {
    const cache = await getCachedIdempotentResult(idempotencyKeyHash, idempotencyTtlMs());
    if (cache) {
      return NextResponse.json(cache.payload, {
        status: cache.status,
        headers: { "x-idempotency-replayed": "1" },
      });
    }
  }

  if (!enabled) {
    await appendAutoTuningAudit({
      id: `at-${Date.now()}`,
      timestampIso: new Date().toISOString(),
      actor,
      dryRun: true,
      status: "rejected",
      recommendationCount: 0,
      summary: "feature_flag_disabled",
    });
    return NextResponse.json({ message: "AUTO_TUNING_WRITEBACK_ENABLED is disabled" }, { status: 403 });
  }

  if (!token) {
    await appendAutoTuningAudit({
      id: `at-${Date.now()}`,
      timestampIso: new Date().toISOString(),
      actor,
      dryRun: true,
      status: "rejected",
      recommendationCount: 0,
      summary: "missing_control_plane_token",
    });
    return NextResponse.json({ message: "Authentication required" }, { status: 401 });
  }

  const rawBody = await request.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(rawBody || "{}") as Record<string, unknown>;
  } catch {
    const payload = { message: "Malformed JSON payload" };
    if (idempotencyKey) {
      await saveIdempotentResult(hashIdempotencyKey(idempotencyKey), 400, payload, idempotencyTtlMs());
    }
    return NextResponse.json(payload, { status: 400 });
  }
  const dryRun = Boolean((body as Record<string, unknown>).dryRun);
  const adminRequiredForDryRun = isAdminRequiredForDryRun();
  const reason = String(body.reason || "auto-tuning write-back").slice(0, 240);
  const baseRecommendations = normalizeRecommendations(body.recommendations);
  const options = parseOptions(body);
  const recommendations = applyOptions(baseRecommendations, options);
  const requestHash = sha256Hex(rawBody);

  // Optional hardening: if admin key is configured, apply always requires key,
  // and dry-run requires key when AUTO_TUNING_ADMIN_REQUIRED_FOR_DRYRUN is enabled.
  const mustCheckAdminKey = Boolean(adminKey) && (!dryRun || adminRequiredForDryRun);

  if (mustCheckAdminKey && adminHeaderValue !== adminKey) {
    await appendAutoTuningAudit({
      id: `at-${Date.now()}`,
      timestampIso: new Date().toISOString(),
      actor,
      dryRun,
      status: "rejected",
      recommendationCount: recommendations.length,
      summary: dryRun ? "admin_key_mismatch_dryrun" : "admin_key_mismatch_apply",
      requestHash,
      idempotencyKeyHash: idempotencyKeyHash || undefined,
      appliedBy: actor,
    });
    const payload = { message: `Missing or invalid admin header: ${adminHeaderName}` };
    if (idempotencyKey) {
      await saveIdempotentResult(idempotencyKeyHash, 403, payload, idempotencyTtlMs());
    }
    return NextResponse.json(payload, { status: 403 });
  }

  if (!recommendations.length) {
    await appendAutoTuningAudit({
      id: `at-${Date.now()}`,
      timestampIso: new Date().toISOString(),
      actor,
      dryRun,
      status: "rejected",
      recommendationCount: 0,
      summary: "invalid_recommendations_payload",
      requestHash,
      idempotencyKeyHash: idempotencyKeyHash || undefined,
      appliedBy: actor,
    });
    const payload = { message: "No valid recommendations" };
    if (idempotencyKey) {
      await saveIdempotentResult(idempotencyKeyHash, 400, payload, idempotencyTtlMs());
    }
    return NextResponse.json(payload, { status: 400 });
  }

  const mustSignUpstream = isUpstreamSigningEnabled() || isSignatureRequired() || mustCheckAdminKey;
  if (mustSignUpstream && !signatureSecret) {
    const payload = { message: "Signature secret is not configured" };
    if (idempotencyKey) {
      await saveIdempotentResult(idempotencyKeyHash, 500, payload, idempotencyTtlMs());
    }
    return NextResponse.json(payload, { status: 500 });
  }

  const cpPath = getControlPlanePath();
  const upstreamBody = {
    source: "mission-control-ui",
    reason,
    dry_run: dryRun,
    options,
    recommendations,
  };
  const upstreamBodyText = JSON.stringify(upstreamBody);
  const upstreamHeaders: Record<string, string> = { "Content-Type": "application/json" };
  let signedAtIso: string | undefined;

  if (mustSignUpstream && signatureSecret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", signatureSecret).update(`${ts}.${upstreamBodyText}`).digest("hex");
    upstreamHeaders["x-signature-timestamp"] = ts;
    upstreamHeaders["x-signature"] = signature;
    signedAtIso = new Date(Number(ts) * 1000).toISOString();
  }
  upstreamHeaders["x-request-hash"] = requestHash;
  if (idempotencyKey) {
    upstreamHeaders["x-idempotency-key"] = idempotencyKey;
  }

  const response = await cpFetch(cpPath, {
    method: "POST",
    headers: upstreamHeaders,
    body: upstreamBodyText,
  });

  const upstreamPayload = await readJsonFromResponseSafe(response);
  const status: "accepted" | "failed" = response.ok ? "accepted" : "failed";
  await appendAutoTuningAudit({
    id: `at-${Date.now()}`,
    timestampIso: new Date().toISOString(),
    actor,
    dryRun,
    status,
    recommendationCount: recommendations.length,
    summary: response.ok
      ? (dryRun ? "dry_run_accepted" : "writeback_accepted")
      : `upstream_failed_${response.status}`,
    requestHash,
    idempotencyKeyHash: idempotencyKeyHash || undefined,
    signedAtIso,
    appliedBy: actor,
    resultHash: sha256Hex(JSON.stringify(upstreamPayload || {})),
  });

  const payload = {
    message: response.ok
      ? (dryRun ? "Dry-run accepted and audited" : "Write-back accepted and audited")
      : "Upstream write-back failed",
    upstream: upstreamPayload,
  };
  if (idempotencyKey) {
    await saveIdempotentResult(idempotencyKeyHash, response.status, payload, idempotencyTtlMs());
  }
  return NextResponse.json(payload, { status: response.status });
}