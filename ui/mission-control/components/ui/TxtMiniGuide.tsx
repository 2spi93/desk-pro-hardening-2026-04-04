"use client";

import HelpTooltip from "./HelpTooltip";
import { glossary } from "../../lib/glossary";
import { useUiMode } from "../../lib/userUiPrefs";

type TermKey = keyof typeof glossary;

type Props = {
  title: string;
  what: string;
  why: string;
  example: string;
  terms?: TermKey[];
};

export default function TxtMiniGuide({ title, what, why, example, terms = [] }: Props) {
  const [uiMode] = useUiMode();

  if (uiMode === "expert") {
    return (
      <div className="txt-mini-guide compact" role="note" aria-label={`${title} quick guidance`}>
        <span className="txt-mini-guide-title">{title}</span>
        <span className="txt-mini-guide-text">{why}</span>
      </div>
    );
  }

  return (
    <div className="txt-mini-guide" role="note" aria-label={`${title} quick guidance`}>
      <div className="txt-mini-guide-title">{title}</div>
      <div className="txt-mini-guide-row"><span className="txt-mini-guide-label">Ce module montre</span><span className="txt-mini-guide-text">{what}</span></div>
      <div className="txt-mini-guide-row"><span className="txt-mini-guide-label">A quoi il sert</span><span className="txt-mini-guide-text">{why}</span></div>
      <div className="txt-mini-guide-row"><span className="txt-mini-guide-label">Exemple</span><span className="txt-mini-guide-text">{example}</span></div>
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
  );
}