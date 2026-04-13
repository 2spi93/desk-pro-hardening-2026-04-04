"use client";

import type { ReactNode } from "react";

import HelpTooltip from "./HelpTooltip";
import { glossary } from "../../lib/glossary";
import { useUiMode } from "../../lib/userUiPrefs";

type TermKey = Extract<keyof typeof glossary, string>;

type OperatorPanelGuideProps = {
  title: string;
  what: string;
  why: string;
  example?: string;
  terms?: TermKey[];
  actions?: ReactNode;
  label?: string;
  mode?: "inline" | "hint";
  compact?: boolean;
};

export default function OperatorPanelGuide({
  title,
  what,
  why,
  example = "",
  terms = [],
  actions,
  label,
  mode = "inline",
  compact = false,
}: OperatorPanelGuideProps) {
  const [uiMode] = useUiMode();
  const entry = {
    label: label || title,
    simple: what,
    example,
    whyItMatters: why,
  };

  if (mode === "hint") {
    return <HelpTooltip entry={entry} mode={uiMode} />;
  }

  const isCompact = compact || uiMode === "expert";

  return (
    <div className={`txt-mini-guide operator-panel-guide${isCompact ? " compact" : ""}`} role="note" aria-label={`${title} quick guidance`}>
      <div className="operator-panel-guide-copy">
        <div className="operator-panel-guide-head">
          <div className="txt-mini-guide-title">{title}</div>
          {terms.length > 0 ? (
            <div className="txt-mini-guide-terms" aria-label="Glossary terms">
              {terms.map((term) => (
                <span key={term} className="txt-mini-guide-term">
                  {glossary[term].label}
                  <HelpTooltip termKey={term} mode={uiMode} />
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {isCompact ? (
          <span className="txt-mini-guide-text">{why}</span>
        ) : (
          <>
            <div className="txt-mini-guide-row"><span className="txt-mini-guide-label">Ce module montre</span><span className="txt-mini-guide-text">{what}</span></div>
            <div className="txt-mini-guide-row"><span className="txt-mini-guide-label">A quoi il sert</span><span className="txt-mini-guide-text">{why}</span></div>
            {example ? <div className="txt-mini-guide-row"><span className="txt-mini-guide-label">Exemple</span><span className="txt-mini-guide-text">{example}</span></div> : null}
          </>
        )}
      </div>
      {actions ? <div className="operator-panel-guide-actions">{actions}</div> : null}
    </div>
  );
}