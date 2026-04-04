function normalizeForwardedProto(value: string | null): string {
  if (!value) {
    return "";
  }
  return value.split(",")[0].trim().toLowerCase();
}

function isPublicHttpsHost(host: string): boolean {
  const normalized = host.split(":")[0].toLowerCase();
  return normalized === "app.txt.gtixt.com" || normalized.endsWith(".gtixt.com");
}

export function isHttpsRequest(request: Request): boolean {
  const fallback = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || fallback.host;
  if (isPublicHttpsHost(host)) {
    return true;
  }
  const forwardedProto = normalizeForwardedProto(request.headers.get("x-forwarded-proto"));
  if (forwardedProto) {
    return forwardedProto === "https";
  }
  if (fallback.protocol === "https:") {
    return true;
  }
  return isPublicHttpsHost(host);
}

export function buildAppUrl(request: Request, path: string): URL {
  const fallback = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || fallback.host;
  const protocol = isHttpsRequest(request) ? "https" : "http";
  return new URL(path, `${protocol}://${host}`);
}
