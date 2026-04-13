type JsonMap = Record<string, unknown>;

function asMap(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function toFiniteNumber(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export type ConnectorHealthView = {
  action: "block" | "reduce_size" | "ok";
  label: string;
  compactLabel: string;
  message: string;
  score: number | null;
  scorePct: number | null;
  scoreText: string;
  badgeClassName: string;
  noteClassName: string;
};

export function getConnectorHealthView(connector: unknown): ConnectorHealthView {
  const row = asMap(connector);
  const degradation = asMap(row.degradation_engine);
  const feedQuality = asMap(row.feed_quality);
  const state = String(degradation.state || row.health_action || "ok").trim().toLowerCase();
  const feedState = String(feedQuality.status || "ok").trim().toLowerCase();
  const rawScore = toFiniteNumber(degradation.health_score ?? row.health_score);
  const score = rawScore === null ? null : Math.max(0, Math.min(1, rawScore));
  const scorePct = score === null ? null : Math.round(score * 100);
  let action: "block" | "reduce_size" | "ok" = "ok";

  if (Boolean(degradation.auto_disable_live) || state === "critical" || state === "block") {
    action = "block";
  } else if (
    String(degradation.health_action || row.health_action || "").trim().toLowerCase() === "reduce_size"
    || state === "degraded"
    || state === "watch"
    || feedState === "degraded"
    || feedState === "watch"
  ) {
    action = "reduce_size";
  }

  const scoreText = scorePct === null ? "--/100" : `${scorePct}/100`;
  if (action === "block") {
    return {
      action,
      label: "LIVE BLOCKED",
      compactLabel: `BLOCK ${scorePct === null ? "--" : scorePct}`,
      message: `${scoreText} - execution hard-blocked`,
      score,
      scorePct,
      scoreText,
      badgeClassName: "connector-health-badge is-block",
      noteClassName: "connector-health-note is-block",
    };
  }
  if (action === "reduce_size") {
    return {
      action,
      label: "REDUCE SIZE",
      compactLabel: `REDUCE ${scorePct === null ? "--" : scorePct}`,
      message: `${scoreText} - size reduction active`,
      score,
      scorePct,
      scoreText,
      badgeClassName: "connector-health-badge is-reduce",
      noteClassName: "connector-health-note is-reduce",
    };
  }
  return {
    action,
    label: "EXCHANGE OK",
    compactLabel: `OK ${scorePct === null ? "--" : scorePct}`,
    message: `${scoreText} - execution allowed`,
    score,
    scorePct,
    scoreText,
    badgeClassName: "connector-health-badge is-ok",
    noteClassName: "connector-health-note is-ok",
  };
}