"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useUiMode } from "../../lib/userUiPrefs";
import { UI_TERMS } from "../../lib/uiLexicon";
import type { RoleGroup } from "../../lib/roleGroups";

/** Navigation visible to internal TXT staff only (admin · operator · viewer). */
const INTERNAL_NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/fund-manager", label: "Fund Manager" },
  { href: "/live-capital", label: "Live Capital" },
  { href: "/live-ops", label: "Live Ops" },
  { href: "/canary", label: "Canary" },
  { href: "/terminal", label: "Terminal" },
  { href: "/live-readiness", label: UI_TERMS.readiness },
  { href: "/advanced/reality-gap", label: UI_TERMS.executionGap },
  { href: "/advanced/kairos-shadow", label: UI_TERMS.marketRegime },
  { href: "/incidents", label: "Incidents" },
  { href: "/connectors", label: "Connectors" },
  { href: "/ai", label: "AI" },
  { href: "/learn", label: "Learn" },
  { href: "/advanced", label: UI_TERMS.diagnostics },
  { href: "/settings", label: "Settings" },
];

/** Navigation visible to external clients (client · trader · investor · premium · pro). */
const CLIENT_NAV_ITEMS = [
  { href: "/terminal", label: "Terminal" },
  { href: "/connections", label: "Connections" },
  { href: "/learn", label: "Learn" },
];

const HARD_NAVIGATION_ROUTE_PREFIXES = [
  "/terminal",
  "/live-ops",
  "/live-capital",
  "/live-readiness",
  "/connectors",
  "/connections",
  "/ai",
];

function shouldUseHardNavigation(pathname: string | null): boolean {
  if (!pathname) {
    return false;
  }
  return HARD_NAVIGATION_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function navTargetIdFromHref(href: string): string {
  if (href === "/") {
    return "txt-global-nav-link-home";
  }
  return `txt-global-nav-link-${href.replace(/^\//, "").replace(/\//g, "-")}`;
}

export default function TxtGlobalNav({ roleGroup = "unknown" }: { roleGroup?: RoleGroup }) {
  const pathname = usePathname();
  const [uiMode, setUiMode] = useUiMode();
  const [hydrated, setHydrated] = useState(false);
  const useHardNavigation = shouldUseHardNavigation(pathname);

  useEffect(() => {
    setHydrated(true);
  }, []);

  if (pathname === "/login" || pathname === "/change-password") {
    return null;
  }

  // Clients never see internal nav items; unknown role falls back to internal
  // nav so the UX is intact for unauthenticated / SSR edge cases where the
  // middleware will redirect anyway.
  const navItems = roleGroup === "client" ? CLIENT_NAV_ITEMS : INTERNAL_NAV_ITEMS;

  return (
    <header id="txt-global-nav" className="txt-global-nav" role="banner" data-hydrated={hydrated ? "1" : "0"}>
      <div className="txt-global-brand-wrap">
        <div className="txt-global-brand">TXT</div>
        <div className="txt-global-subbrand">Trader eXelle Terminal</div>
      </div>
      <nav className="txt-global-links" aria-label="TXT main navigation">
        {navItems.map((item) => {
          const active = pathname === item.href;
          const linkId = navTargetIdFromHref(item.href);
          const className = `txt-global-link${active ? " active" : ""}`;
          return (
            useHardNavigation ? (
              <a key={item.href} id={linkId} href={item.href} className={className}>
                {item.label}
              </a>
            ) : (
              <Link key={item.href} id={linkId} href={item.href} className={className}>
                {item.label}
              </Link>
            )
          );
        })}
        <button
          type="button"
          className="txt-global-link txt-global-link-button"
          onClick={() => {
            window.dispatchEvent(new Event("txt-global-walkthrough-start"));
          }}
        >
          Walkthrough
        </button>
      </nav>
      <div className="txt-global-mode" role="tablist" aria-label="Global display mode">
        <button type="button" className={`txt-global-mode-btn${uiMode === "novice" ? " active" : ""}`} onClick={() => setUiMode("novice")}>
          Novice
        </button>
        <button type="button" className={`txt-global-mode-btn${uiMode === "expert" ? " active" : ""}`} onClick={() => setUiMode("expert")}>
          Expert
        </button>
      </div>
    </header>
  );
}