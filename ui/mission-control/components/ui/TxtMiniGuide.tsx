"use client";

import OperatorPanelGuide from "./OperatorPanelGuide";
import { glossary } from "../../lib/glossary";

type TermKey = Extract<keyof typeof glossary, string>;

type Props = {
  title: string;
  what: string;
  why: string;
  example: string;
  terms?: TermKey[];
};

export default function TxtMiniGuide({ title, what, why, example, terms = [] }: Props) {
  return (
    <OperatorPanelGuide title={title} what={what} why={why} example={example} terms={terms} />
  );
}