import { NextResponse } from "next/server";

import { attachInfraAwareResponseHeaders, cpFetchJsonSafe, extractMcContextHeaders, withControlPlaneNetwork } from "../../../../../lib/controlPlane";

export async function POST(request: Request): Promise<NextResponse> {
  const forwardedHeaders = extractMcContextHeaders(request);
  const payload = await request.json();
  const { response, payload: body } = await cpFetchJsonSafe("/v1/execution/rust/preview", {
    method: "POST",
    headers: {
      ...Object.fromEntries(forwardedHeaders.entries()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const network = {
    network_state: String(response.headers.get("x-mc-control-plane-network-state") || "healthy") as "healthy" | "retry_recovered" | "degraded",
    retry_count: Number.parseInt(response.headers.get("x-mc-control-plane-retry-count") || "0", 10) || 0,
    degraded_flag: response.headers.get("x-mc-e2e-degraded") === "1",
    failure_classification: String(response.headers.get("x-mc-control-plane-failure-class") || "none") as "none" | "dns_transient" | "dns_unresolved" | "timeout" | "connection_refused" | "connection_reset" | "aborted" | "network_unknown" | "unknown_error",
    failure_detail: String(response.headers.get("x-mc-control-plane-failure-detail") || ""),
    attempted_targets: String(response.headers.get("x-mc-control-plane-attempted-targets") || "").split(",").filter(Boolean),
    attempted_base_urls: String(response.headers.get("x-mc-control-plane-attempted-base-urls") || "").split(",").filter(Boolean),
    upstream_status: response.status,
  };
  const nextResponse = NextResponse.json(withControlPlaneNetwork(body, network), { status: response.status });
  attachInfraAwareResponseHeaders(nextResponse.headers, network, response.headers.get("x-mc-control-plane-retry-policy") || undefined);
  return nextResponse;
}