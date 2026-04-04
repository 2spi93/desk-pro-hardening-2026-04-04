export type AuthSessionStatus = "unknown" | "authenticated" | "unauthenticated";

export const PUBLIC_AUTH_STATUS_CACHE_MS = 60_000;
export const PUBLIC_AUTH_STATUS_SYNC_MS = 60_000;
export const PUBLIC_TERMINAL_BACKGROUND_REFRESH_MS = 180_000;
export const PUBLIC_TERMINAL_GOVERNANCE_REFRESH_MS = 120_000;
export const PUBLIC_TERMINAL_FALLBACK_POLL_MS = 8_000;

export function isGtixPublicHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "app.txt.gtixt.com"
    || normalized === "staging.txt.gtixt.com"
    || normalized === "api.txt.gtixt.com"
    || normalized === "api.staging.txt.gtixt.com";
}

export function isGtixPublicBrowserHost(): boolean {
  return typeof window !== "undefined" && isGtixPublicHost(window.location.hostname);
}

export function isAutomationBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  if (navigator.webdriver) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  const automationWindow = window as typeof window & {
    __playwright__?: unknown;
    __pw_manual?: unknown;
    Cypress?: unknown;
  };
  return Boolean(automationWindow.__playwright__ || automationWindow.__pw_manual || automationWindow.Cypress);
}

export function shouldPausePublicOpsRefresh(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  if (!isGtixPublicBrowserHost()) {
    return false;
  }
  if (isAutomationBrowser()) {
    return false;
  }
  return document.visibilityState !== "visible" || !document.hasFocus();
}

export async function fetchTerminalAuthStatus(wasAuthenticated: boolean): Promise<{ authenticated: boolean; definitive: boolean }> {
  return fetch("/api/auth/status", { cache: "no-store" })
    .then(async (response) => {
      if (response.status === 401 || response.status === 403) {
        return { authenticated: false, definitive: true };
      }
      if (!response.ok) {
        return { authenticated: wasAuthenticated, definitive: false };
      }
      const payload = await response.json().catch(() => null);
      return {
        authenticated: Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).authenticated),
        definitive: true,
      };
    })
    .catch(() => ({ authenticated: wasAuthenticated, definitive: false }));
}