import type { ReactNode } from "react";

type Props = {
  className?: string;
  children: ReactNode;
};

export default function PanelShell({ className = "", children }: Props) {
  return <section className={`gtix-panel-shell ${className}`.trim()}>{children}</section>;
}