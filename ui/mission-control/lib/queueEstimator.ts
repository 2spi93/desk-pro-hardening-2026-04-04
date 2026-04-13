export type QueueEstimate = {
  queuePosition: number;
  fillUrgency: "fast" | "working" | "blocked" | "dead";
  shouldReprice: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function estimateQueuePosition(input: {
  orderSize: number;
  levelSize: number;
  tradedVolume: number;
}): QueueEstimate {
  const denominator = Math.max(1, input.levelSize + input.tradedVolume);
  const queuePosition = clamp(input.orderSize / denominator, 0, 1.5);
  const fillUrgency = queuePosition <= 0.2
    ? "fast"
    : queuePosition <= 0.5
      ? "working"
      : queuePosition <= 0.9
        ? "blocked"
        : "dead";
  return {
    queuePosition,
    fillUrgency,
    shouldReprice: queuePosition > 0.6,
  };
}