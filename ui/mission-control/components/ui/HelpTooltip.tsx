"use client";

import { useId, useState } from "react";

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
  const resolved = entry || (termKey ? glossary[termKey] : null) || {
    label: label || "Help",
    simple: simple || "Definition unavailable.",
    example: example || "",
    whyItMatters: whyItMatters || "",
  };

  const description = [resolved.label, resolved.simple, resolved.example, resolved.whyItMatters].filter(Boolean).join(" ");

  return (
    <span
      className={`gtix-help-hint${mode === "novice" ? " novice" : ""}${open ? " is-open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="gtix-help-hint-btn"
        aria-label={description}
        aria-expanded={open}
        aria-controls={tooltipId}
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
      <span id={tooltipId} className="gtix-help-popover" role="tooltip">
        <span className="gtix-help-popover-title">{resolved.label}</span>
        <span className="gtix-help-popover-section-label">Definition</span>
        <span className="gtix-help-popover-text">{resolved.simple}</span>
        {resolved.example ? (
          <>
            <span className="gtix-help-popover-section-label">Example</span>
            <span className="gtix-help-popover-example">{resolved.example}</span>
          </>
        ) : null}
        {resolved.whyItMatters ? (
          <>
            <span className="gtix-help-popover-section-label">Why it matters here</span>
            <span className="gtix-help-popover-text">{resolved.whyItMatters}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}