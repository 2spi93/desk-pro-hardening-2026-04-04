import { cpFetchJsonSafe } from "./controlPlane";

export type LocalTerminalAuditCategory =
  | "local_terminal_ohlcv_unusable"
  | "local_terminal_bars_hard_fail"
  | "local_terminal_ohlcv_renderable_recovered";

export async function appendAuditEvent(
  category: LocalTerminalAuditCategory,
  payload: Record<string, unknown>,
): Promise<{
  ok: boolean;
  status: number;
  detail: string;
}> {
  const { response, payload: responsePayload } = await cpFetchJsonSafe("/v1/audit/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ category, payload }),
  });

  const safePayload = responsePayload && typeof responsePayload === "object"
    ? responsePayload as Record<string, unknown>
    : {};

  return {
    ok: response.ok,
    status: response.status,
    detail: typeof safePayload.detail === "string"
      ? safePayload.detail
      : typeof safePayload.status === "string"
        ? safePayload.status
        : response.ok
          ? "audit_event_appended"
          : `audit_event_failed_${response.status}`,
  };
}