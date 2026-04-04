"use client";

import HelpTooltip from "./ui/HelpTooltip";
import { useUiMode } from "../lib/userUiPrefs";

type HelpHintProps = {
  text: string;
  examples?: string[];
  label?: string;
};

export default function HelpHint({ text, examples = [], label = "A quoi sert ce bloc ?" }: HelpHintProps) {
  const [uiMode] = useUiMode();

  return (
    <HelpTooltip
      mode={uiMode}
      entry={{
        label,
        simple: text,
        example: examples.join(" "),
        whyItMatters: "Utilise ce repère pour interpréter le bloc sans dérouler toute la logique métier.",
      }}
    />
  );
}
