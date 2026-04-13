"use client";

import OperatorPanelGuide from "./ui/OperatorPanelGuide";

type HelpHintProps = {
  text: string;
  examples?: string[];
  label?: string;
  whyItMatters?: string;
};

export default function HelpHint({
  text,
  examples = [],
  label = "Pour lire ce bloc",
  whyItMatters = "Lis cette aide pour comprendre rapidement ce que montre le bloc et ce qu'il faut regarder.",
}: HelpHintProps) {
  return (
    <OperatorPanelGuide
      mode="hint"
      title={label}
      label={label}
      what={text}
      why={whyItMatters}
      example={examples.join(" ")}
    />
  );
}
