"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useUiMode } from "../../lib/userUiPrefs";
import type { RoleGroup } from "../../lib/roleGroups";

/** Navigation visible to internal TXT staff only (admin · operator · viewer). */
const INTERNAL_NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/fund-manager", label: "Fund Manager" },
  { href: "/live-capital", label: "Live Capital" },
  { href: "/live-ops", label: "Live Ops" },
  { href: "/terminal", label: "Terminal" },
  { href: "/live-readiness", label: "Readiness" },
  { href: "/advanced/reality-gap", label: "Reality Gap" },
  { href: "/advanced/kairos-shadow", label: "Kairos" },
  { href: "/incidents", label: "Incidents" },
  { href: "/connectors", label: "Connectors" },
  { href: "/ai", label: "AI" },
  { href: "/learn", label: "Learn" },
  { href: "/advanced", label: "Advanced" },
  { href: "/settings", label: "Settings" },
];

/** Navigation visible to external clients (client · trader · investor · premium · pro). */
const CLIENT_NAV_ITEMS = [
  { href: "/terminal", label: "Terminal" },
  { href: "/connections", label: "Connections" },
  { href: "/learn", label: "Learn" },
];

function navTargetIdFromHref(href: string): string {
  if (href === "/") {
    return "txt-global-nav-link-home";
  }
  return `txt-global-nav-link-${href.replace(/^\//, "").replace(/\//g, "-")}`;
}

export default function TxtGlobalNav({ roleGroup = "unknown" }: { roleGroup?: RoleGroup }) {
  const pathname = usePathname();
  const [uiMode, setUiMode] = useUiMode();

  if (pathname === "/login" || pathname === "/change-password") {
    return null;
  }

  // Clients never see internal nav items; unknown role falls back to internal
  // nav so the UX is intact for unauthenticated / SSR edge cases where the
  // middleware will redirect anyway.
  const navItems = roleGroup === "client" ? CLIENT_NAV_ITEMS : INTERNAL_NAV_ITEMS;

  return (
    <header id="txt-global-nav" className="txt-global-nav" role="banner">
      <div className="txt-global-brand-wrap">
        <div className="txt-global-brand">TXT</div>
        <div className="txt-global-subbrand">Trader eXelle Terminal</div>
      </div>
      <nav className="txt-global-links" aria-label="TXT main navigation">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link key={item.href} id={navTargetIdFromHref(item.href)} href={item.href} className={`txt-global-link${active ? " active" : ""}`}>
              {item.label}
            </Link>
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