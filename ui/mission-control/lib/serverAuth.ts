/**
 * Server-side auth helpers (App Router server components / API routes).
 * Reads the mc_token cookie and extracts role information WITHOUT network calls.
 * Signature verification is done by the control plane on every API request.
 */
import { cookies } from "next/headers";

import { getRoleGroup, type RoleGroup } from "./roleGroups";

function parseTokenPayload(token: string): { role?: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    const payloadPart = parts.length === 2 ? parts[0] : parts[1];
    if (!payloadPart) return null;
    const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
    const decoded = Buffer.from(
      padded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    return JSON.parse(decoded) as { role?: string; exp?: number };
  } catch {
    return null;
  }
}

function extractRole(cookieStore: Awaited<ReturnType<typeof cookies>>): string | null {
  const token =
    cookieStore.get("mc_token")?.value ??
    cookieStore.get("mc_token_compat")?.value;
  if (!token) return null;
  const payload = parseTokenPayload(token);
  if (!payload?.role) return null;
  // Treat locally-expired tokens as absent; backend will enforce on API calls
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload.role;
}

export async function getServerRole(): Promise<string | null> {
  const cookieStore = await cookies();
  return extractRole(cookieStore);
}

export async function getServerRoleGroup(): Promise<RoleGroup> {
  const role = await getServerRole();
  return getRoleGroup(role);
}
