"use client";

import { useRef } from "react";
import type { ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";

type Props = {
  autoSaveId: string;
  left: ReactNode;
  right: ReactNode;
  defaultLeft?: number;
  minLeft?: number;
  minRight?: number;
  resetLeft?: number;
};

export default function TxtSplitPanel({
  autoSaveId,
  left,
  right,
  defaultLeft = 74,
  minLeft = 52,
  minRight = 20,
  resetLeft = 74,
}: Props) {
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null);

  return (
    <PanelGroup ref={groupRef} direction="horizontal" autoSaveId={autoSaveId} className="txt-split-group">
      <Panel defaultSize={defaultLeft} minSize={minLeft} className="txt-split-panel txt-split-panel-left">
        {left}
      </Panel>
      <PanelResizeHandle
        className="term-core-resize-handle"
        title="Drag to resize. Double click to reset."
        onDoubleClick={() => {
          if (groupRef.current) {
            groupRef.current.setLayout([resetLeft, 100 - resetLeft]);
          }
        }}
      >
        <span className="term-core-resize-grip" aria-hidden="true" />
      </PanelResizeHandle>
      <Panel defaultSize={100 - defaultLeft} minSize={minRight} className="txt-split-panel txt-split-panel-right">
        {right}
      </Panel>
    </PanelGroup>
  );
}