"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { glossary, type GlossaryEntry } from "../../lib/glossary";
import type { UiMode } from "../../lib/userUiPrefs";

type Props = {
  termKey?: keyof typeof glossary;
  entry?: GlossaryEntry;
  label?: string;
  simple?: string;
  example?: string;
  whyItMatters?: string;
  mode?: UiMode;
};

export default function HelpTooltip({ termKey, entry, label, simple, example, whyItMatters, mode = "expert" }: Props) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<{ top?: string; left?: string }>({});
  const resolved = entry || (termKey ? glossary[termKey] : null) || {
    label: label || "Aide rapide",
    simple: simple || "Explication indisponible.",
    example: example || "",
    whyItMatters: whyItMatters || "",
  };

  const description = [resolved.label, resolved.simple, resolved.example, resolved.whyItMatters].filter(Boolean).join(" ");

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      if (typeof window === "undefined") return;
      const button = buttonRef.current;
      const popover = popoverRef.current;
      if (!button || !popover) return;

      const viewportPadding = 12;
      const offset = 10;
      const maxWidth = Math.min(420, window.innerWidth - viewportPadding * 2);
      const buttonRect = button.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const popoverWidth = Math.min(maxWidth, popoverRect.width || maxWidth);
      const popoverHeight = popoverRect.height || 0;

      let left = buttonRect.left + buttonRect.width / 2 - popoverWidth / 2;
      left = Math.max(viewportPadding, Math.min(left, window.innerWidth - popoverWidth - viewportPadding));

      let top = buttonRect.bottom + offset;
      if (popoverHeight && top + popoverHeight > window.innerHeight - viewportPadding) {
        const aboveTop = buttonRect.top - popoverHeight - offset;
        top = aboveTop >= viewportPadding ? aboveTop : Math.max(viewportPadding, window.innerHeight - popoverHeight - viewportPadding);
      }

      setPopoverStyle({
        top: `${Math.round(top)}px`,
        left: `${Math.round(left)}px`,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown, { passive: true });

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [open]);

  return (
    <span
      className={`gtix-help-hint${mode === "novice" ? " novice" : ""}${open ? " is-open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        className="gtix-help-hint-btn"
        aria-label={description}
        aria-expanded={open}
        aria-controls={tooltipId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((current) => !current);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        ?
      </button>
      <span ref={popoverRef} id={tooltipId} className="gtix-help-popover" role="tooltip" style={popoverStyle}>
        <span className="gtix-help-popover-title">{resolved.label}</span>
        <span className="gtix-help-popover-section-label">En clair</span>
        <span className="gtix-help-popover-text">{resolved.simple}</span>
        {resolved.example ? (
          <>
            <span className="gtix-help-popover-section-label">Exemple simple</span>
            <span className="gtix-help-popover-example">{resolved.example}</span>
          </>
        ) : null}
        {resolved.whyItMatters ? (
          <>
            <span className="gtix-help-popover-section-label">Pourquoi tu le vois ici</span>
            <span className="gtix-help-popover-text">{resolved.whyItMatters}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}