/**
 * TXT Role Groups
 * ──────────────────────────────────────────────────────────────────────────
 * INTERNAL — TXT team only.  Never visible / accessible to clients.
 *   admin · operator · viewer
 *
 * CLIENT — External traders / investors.  Never see internal tooling.
 *   client · trader · investor · premium · pro
 * ──────────────────────────────────────────────────────────────────────────
 */

export const INTERNAL_ROLES = ["admin", "operator", "viewer"] as const;
export const CLIENT_ROLES = ["client", "trader", "investor", "premium", "pro"] as const;

export type InternalRole = (typeof INTERNAL_ROLES)[number];
export type ClientRole = (typeof CLIENT_ROLES)[number];
export type AppRole = InternalRole | ClientRole;
export type RoleGroup = "internal" | "client" | "unknown";

export function isInternalRole(role: string): role is InternalRole {
  return (INTERNAL_ROLES as readonly string[]).includes(role);
}

export function isClientRole(role: string): role is ClientRole {
  return (CLIENT_ROLES as readonly string[]).includes(role);
}

export function getRoleGroup(role: string | null | undefined): RoleGroup {
  if (!role) return "unknown";
  if (isInternalRole(role)) return "internal";
  if (isClientRole(role)) return "client";
  return "unknown";
}

/**
 * Friendly label shown in the UI.
 * Internal role names (admin, operator, viewer) are NEVER shown to client users.
 */
export function getRoleDisplayLabel(role: string, group: RoleGroup): string {
  if (group === "client") {
    const labels: Record<string, string> = {
      client: "Client",
      trader: "Trader",
      investor: "Investor",
      premium: "Premium",
      pro: "Pro",
    };
    return labels[role] ?? "Client";
  }
  const labels: Record<string, string> = {
    admin: "Admin",
    operator: "Operator",
    viewer: "Viewer",
  };
  return labels[role] ?? role;
}

/** Pages internal staff can access (clients are blocked). */
export const INTERNAL_ONLY_PATHS = [
  "/",
  "/live-readiness",
  "/live-capital",
  "/incidents",
  "/connectors",
  "/ai",
  "/advanced",
  "/settings",
] as const;

/** Default landing page for each group after login. */
export const GROUP_HOME: Record<RoleGroup, string> = {
  internal: "/",
  client: "/terminal",
  unknown: "/login",
};
