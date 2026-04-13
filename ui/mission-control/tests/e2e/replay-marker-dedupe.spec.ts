import { expect, test } from "@playwright/test";

import { collapseReplayEventMarkers, type ReplayEventMarker } from "../../app/terminal/replayEventMarkers";

function marker(partial: Partial<ReplayEventMarker> & Pick<ReplayEventMarker, "id" | "kind" | "timeKey" | "frameIndex" | "label">): ReplayEventMarker {
  return {
    critical: false,
    detail: "",
    ...partial,
  };
}

test("replay marker dedupe collapses semantically duplicated approvals and incidents", () => {
  const collapsed = collapseReplayEventMarkers([
    marker({ id: "approval-1", kind: "approval", timeKey: "1710000000", frameIndex: 12, label: "Approval", detail: "appr-1" }),
    marker({ id: "approval-2", kind: "approval", timeKey: "1710000000", frameIndex: 13, label: "Approval", detail: "appr-1" }),
    marker({ id: "approval-3", kind: "approval", timeKey: "1710000000", frameIndex: 14, label: "Approval", detail: "appr-2" }),
    marker({ id: "incident-1", kind: "incident", timeKey: "1710000000", frameIndex: 12, label: "Incident", detail: "INC-7 high" }),
    marker({ id: "incident-2", kind: "incident", timeKey: "1710000000", frameIndex: 15, label: "Incident", detail: "INC-8 medium", critical: true }),
  ]);

  expect(collapsed).toHaveLength(2);
  expect(collapsed[0]).toMatchObject({ kind: "approval", label: "Approval x2" });
  expect(collapsed[0].detail).toContain("appr-1");
  expect(collapsed[0].detail).toContain("+1 more");
  expect(collapsed[1]).toMatchObject({ kind: "incident", label: "Incident x2", critical: true });
  expect(collapsed[1].detail).toContain("INC-7 high");
  expect(collapsed[1].detail).toContain("+1 more");
});

test("replay marker dedupe keeps outcome markers within the same bucket cap and preserves order", () => {
  const collapsed = collapseReplayEventMarkers([
    marker({ id: "outcome-1", kind: "outcome", timeKey: "1710000001", frameIndex: 20, label: "+12$ VW", detail: "BTCUSDT +0.22%" }),
    marker({ id: "outcome-2", kind: "outcome", timeKey: "1710000001", frameIndex: 21, label: "+15$ VW", detail: "BTCUSDT +0.28%" }),
    marker({ id: "outcome-3", kind: "outcome", timeKey: "1710000001", frameIndex: 22, label: "+18$ VW", detail: "BTCUSDT +0.31%", critical: true }),
    marker({ id: "fill-1", kind: "fill", timeKey: "1710000002", frameIndex: 25, label: "Fill", detail: "binance 101.23 0.100" }),
  ]);

  expect(collapsed.map((entry) => entry.kind)).toEqual(["outcome", "outcome", "fill"]);
  expect(collapsed[0].frameIndex).toBe(20);
  expect(collapsed[1].frameIndex).toBe(21);
  expect(collapsed[1].critical).toBe(true);
  expect(collapsed[0].detail).not.toContain("+1 more");
  expect(collapsed[1].detail).toContain("+1 more");
});