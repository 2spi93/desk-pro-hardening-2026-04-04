export type ReplayEventMarker = {
  id: string;
  label: string;
  kind: "intent" | "approval" | "fill" | "incident" | "routing" | "outcome" | "latent" | "other";
  timeKey: string;
  frameIndex: number;
  critical: boolean;
  detail: string;
};

const REPLAY_MARKER_BUCKET_CAPS: Record<ReplayEventMarker["kind"], number> = {
  intent: 2,
  approval: 1,
  fill: 2,
  incident: 1,
  routing: 2,
  outcome: 2,
  latent: 1,
  other: 2,
};

function normalizeReplayMarkerText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9+.$:%\/-]+/g, " ")
    .trim();
}

function buildReplayMarkerSemanticKey(marker: ReplayEventMarker): string {
  const detailSignature = normalizeReplayMarkerText(marker.detail).slice(0, 96);
  return [
    marker.kind,
    marker.timeKey,
    normalizeReplayMarkerText(marker.label),
    detailSignature,
  ].join("|");
}

export function collapseReplayEventMarkers(markers: ReplayEventMarker[]): ReplayEventMarker[] {
  const semanticGroups = new Map<string, { marker: ReplayEventMarker; details: string[]; count: number }>();

  for (const marker of markers) {
    const semanticKey = buildReplayMarkerSemanticKey(marker);
    const existing = semanticGroups.get(semanticKey);
    if (!existing) {
      semanticGroups.set(semanticKey, {
        marker: { ...marker },
        details: marker.detail ? [marker.detail] : [],
        count: 1,
      });
      continue;
    }

    existing.count += 1;
    existing.marker.critical = existing.marker.critical || marker.critical;
    existing.marker.frameIndex = Math.min(existing.marker.frameIndex, marker.frameIndex);
    if (marker.detail && !existing.details.includes(marker.detail)) {
      existing.details.push(marker.detail);
    }
  }

  const merged = Array.from(semanticGroups.values())
    .map(({ marker, details, count }) => ({
      ...marker,
      label: count > 1 ? `${marker.label} x${count}` : marker.label,
      detail: details.length > 0 ? details.slice(0, 2).join(" · ") : marker.detail,
    }))
    .sort((left, right) => left.frameIndex - right.frameIndex || Number(right.critical) - Number(left.critical));

  const kept: ReplayEventMarker[] = [];
  const bucketMeta = new Map<string, {
    firstIndex: number;
    totalCount: number;
    keptCount: number;
    overflowDetails: string[];
    overflowCritical: boolean;
    collapseLabel: boolean;
  }>();

  for (const marker of merged) {
    const bucketKey = `${marker.timeKey}:${marker.kind}`;
    const cap = REPLAY_MARKER_BUCKET_CAPS[marker.kind] || 1;
    const meta = bucketMeta.get(bucketKey) || {
      firstIndex: -1,
      totalCount: 0,
      keptCount: 0,
      overflowDetails: [],
      overflowCritical: false,
      collapseLabel: cap === 1,
    };
    meta.totalCount += 1;

    if (meta.keptCount < cap) {
      if (meta.firstIndex === -1) {
        meta.firstIndex = kept.length;
      }
      kept.push(marker);
      meta.keptCount += 1;
    } else {
      meta.overflowCritical = meta.overflowCritical || marker.critical;
      if (marker.detail && !meta.overflowDetails.includes(marker.detail)) {
        meta.overflowDetails.push(marker.detail);
      }
    }

    bucketMeta.set(bucketKey, meta);
  }

  for (const meta of bucketMeta.values()) {
    if (meta.firstIndex < 0 || meta.totalCount <= meta.keptCount) {
      continue;
    }
    const targetIndex = meta.firstIndex + Math.max(0, meta.keptCount - 1);
    const target = kept[targetIndex];
    if (!target) {
      continue;
    }
    if (meta.collapseLabel && meta.totalCount > 1 && !/ x\d+$/i.test(target.label)) {
      target.label = `${target.label} x${meta.totalCount}`;
    }
    if (meta.overflowDetails.length > 0) {
      const overflowLabel = `+${meta.totalCount - meta.keptCount} more`;
      target.detail = target.detail
        ? `${target.detail} · ${overflowLabel}`
        : overflowLabel;
    }
    target.critical = target.critical || meta.overflowCritical;
  }

  return kept;
}