"use client";

import type { UiMode } from "../../lib/userUiPrefs";

type Props = {
  title?: string;
  what: string;
  why: string;
  example: string;
  mode: UiMode;
};

export default function ModuleGuide({ title = "Quick guide", what, why, example, mode }: Props) {
  if (mode === "expert") {
    return null;
  }

  return (
    <div className="gtix-module-guide">
      <div className="gtix-module-guide-title">{title === "Quick guide" ? "Guide rapide" : title}</div>
      <div className="gtix-module-guide-row">
        <span className="gtix-module-guide-label">Ce que tu vois</span>
        <span className="gtix-module-guide-text">{what}</span>
      </div>
      <div className="gtix-module-guide-row">
        <span className="gtix-module-guide-label">Pourquoi c'est utile</span>
        <span className="gtix-module-guide-text">{why}</span>
      </div>
      <div className="gtix-module-guide-row">
        <span className="gtix-module-guide-label">Exemple concret</span>
        <span className="gtix-module-guide-text">{example}</span>
      </div>
    </div>
  );
}