/**
 * Next.js Edge Middleware — Route-level RBAC guard
 * ──────────────────────────────────────────────────────────────────────────
 * • Unauthenticated users → /login
 * • CLIENT roles trying to access internal-only pages → /terminal
 * • All other authenticated requests → pass through
 *
 * NOTE: This is a UX-layer guard. The backend control-plane enforces
 * role-based ACLs on every API call independently.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { type NextRequest, NextResponse } from "next/server";

// Pages exclusive to internal TXT staff (admin · operator · viewer)
const INTERNAL_ONLY_PATHS = [
  "/",
  "/live-readiness",
  "/live-capital",
  "/incidents",
  "/connectors",
  "/ai",
  "/advanced",
  "/settings",
];

// Paths accessible without any authentication
const PUBLIC_PATHS = ["/login", "/change-password"];

// Client role identifiers (kept in sync with lib/roleGroups.ts — duplicated
// here to avoid importing ESM from edge middleware)
const CLIENT_ROLES = new Set(["client", "trader", "investor", "premium", "pro"]);

function parseTokenRole(token: string): string | null {
  try {
    const parts = token.split(".");
    const payloadPart = parts.length === 2 ? parts[0] : parts[1];
    if (!payloadPart) return null;
    const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
    // atob is available in the Edge Runtime
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(decoded) as { role?: string; exp?: number };
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.role ?? null;
  } catch {
    return null;
  }
}

function getTokenFromRequest(request: NextRequest): string | null {
  return (
    request.cookies.get("mc_token")?.value ??
    request.cookies.get("mc_token_compat")?.value ??
    null
  );
}

function isInternalOnlyPath(pathname: string): boolean {
  return INTERNAL_ONLY_PATHS.some(
    (p) => pathname === p || (p !== "/" && pathname.startsWith(p + "/")),
  );
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Always allow: API routes, Next.js internals, static assets
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  // Always allow: public pages (login, change-password)
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = getTokenFromRequest(request);

  // No valid token → redirect to login
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  const role = parseTokenRole(token);

  // Invalid / expired token → redirect to login
  if (!role) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  const isClient = CLIENT_ROLES.has(role);

  // Client users are blocked from internal-only pages → send to /terminal
  if (isClient && isInternalOnlyPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/terminal";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
