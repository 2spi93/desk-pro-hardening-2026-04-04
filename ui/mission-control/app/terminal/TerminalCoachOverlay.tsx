"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type {
  TerminalAdaptiveGuideAssistanceLevel,
  TerminalAdaptiveGuideStep,
  TerminalAdaptiveGuideTone,
} from "./terminalAdaptiveGuide";

type OverlayRect = {
  top: number;
  left: number;
  dotTop: number;
  dotLeft: number;
  pointerTop: number;
  pointerLeft: number;
};

function resolveOverlayRect(targetId: string): OverlayRect | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  const target = document.getElementById(targetId);
  if (!target) {
    return null;
  }
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  const overlayWidth = Math.min(340, Math.max(280, window.innerWidth - 28));
  const dotTop = Math.max(18, Math.min(window.innerHeight - 18, rect.top + Math.min(28, rect.height / 2)));
  const dotLeft = Math.max(18, Math.min(window.innerWidth - 18, rect.left + Math.min(24, rect.width / 2)));
  const placeRight = rect.right + overlayWidth + 28 < window.innerWidth;
  const left = placeRight
    ? Math.min(window.innerWidth - overlayWidth - 12, rect.right + 18)
    : Math.max(12, rect.left - overlayWidth - 18);
  const top = Math.max(12, Math.min(window.innerHeight - 220, rect.top + 8));
  return {
    top,
    left,
    dotTop,
    dotLeft,
    pointerTop: Math.max(16, dotTop - 24),
    pointerLeft: Math.max(16, dotLeft - 22),
  };
}

function resolveOverlayRectWithFallback(targetId: string, fallbackTargetId = "terminal-onboarding"): OverlayRect | null {
  const resolved = resolveOverlayRect(targetId) || (fallbackTargetId !== targetId ? resolveOverlayRect(fallbackTargetId) : null);
  if (resolved || typeof window === "undefined") {
    return resolved;
  }
  const overlayWidth = Math.min(340, Math.max(280, window.innerWidth - 28));
  const left = Math.max(12, window.innerWidth - overlayWidth - 16);
  return {
    top: 96,
    left,
    dotTop: 78,
    dotLeft: left + 24,
    pointerTop: 52,
    pointerLeft: left + 6,
  };
}

export default function TerminalCoachOverlay({
  visible,
  step,
  stepIndex,
  stepCount,
  validated,
  tone,
  assistanceLevel,
  disciplineLock,
  onDismiss,
  onFocusTarget,
  onCommand,
  onValidate,
  onNext,
}: {
  visible: boolean;
  step: TerminalAdaptiveGuideStep | null;
  stepIndex: number;
  stepCount: number;
  validated: boolean;
  tone: TerminalAdaptiveGuideTone;
  assistanceLevel: TerminalAdaptiveGuideAssistanceLevel;
  disciplineLock: boolean;
  onDismiss: () => void;
  onFocusTarget: () => void;
  onCommand: () => void;
  onValidate: () => void;
  onNext: () => void;
}) {
  const [rect, setRect] = useState<OverlayRect | null>(null);

  useEffect(() => {
    if (!visible || !step) {
      setRect(null);
      return;
    }
    const update = () => {
      setRect(resolveOverlayRectWithFallback(step.targetId));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step, visible]);

  const body = useMemo(() => {
    if (!visible || !step || !rect) {
      return null;
    }
    return (
      <>
        <div className={`terminal-coach-overlay-dot ${tone}`} style={{ top: rect.dotTop, left: rect.dotLeft }} />
        <div className={`terminal-coach-overlay-pointer ${tone}`} style={{ top: rect.pointerTop, left: rect.pointerLeft }} aria-hidden="true">
          <svg viewBox="0 0 48 48" role="presentation">
            <path d="M9 6L31 25H21L27 42L20 45L14 28L7 35Z" />
          </svg>
        </div>
        <div className={`terminal-coach-overlay ${tone}`} style={{ top: rect.top, left: rect.left }} role="dialog" aria-label="Coach overlay terminal">
          <div className="terminal-coach-overlay-card">
            <div className="terminal-coach-overlay-head">
              <div>
                <div className="terminal-coach-overlay-kicker">Coach overlay</div>
                <div className="terminal-coach-overlay-title">{step.title}</div>
              </div>
              <button type="button" className="terminal-coach-overlay-close" onClick={onDismiss} aria-label="Masquer le coach overlay">×</button>
            </div>
            <div className="terminal-coach-overlay-pills">
              <span className="terminal-coach-overlay-pill">etape {Math.min(stepIndex + 1, Math.max(stepCount, 1))}/{Math.max(stepCount, 1)}</span>
              <span className={`terminal-coach-overlay-pill ${tone}`}>assistance {assistanceLevel}</span>
              {disciplineLock ? <span className="terminal-coach-overlay-pill warn">discipline lock</span> : null}
              <span className="terminal-coach-overlay-pill subtle">{step.validationLabel}</span>
              <span className={`terminal-coach-overlay-pill ${validated ? "good" : "warn"}`}>{validated ? "validee" : "clic requis"}</span>
            </div>
            <p className="terminal-coach-overlay-copy">{step.explanation}</p>
            <div className={`terminal-coach-overlay-validation ${validated ? "good" : "warn"}`}>
              {validated
                ? "Etape validee. Tu peux passer a la suite."
                : "Clique la zone surlignee ou valide l'etape explicitement avant de continuer."}
            </div>
            <div className="terminal-coach-overlay-actions">
              <button type="button" className="btn" onClick={onFocusTarget}>Pointer la zone</button>
              <button type="button" className={`btn${validated ? " btn-primary" : ""}`} onClick={onValidate}>Valider l'etape</button>
              <button type="button" className="btn" onClick={onCommand}>Commandant</button>
              <button type="button" className="btn btn-primary" onClick={onNext} disabled={!validated}>Suivant</button>
            </div>
          </div>
        </div>
      </>
    );
  }, [assistanceLevel, disciplineLock, onCommand, onDismiss, onFocusTarget, onNext, onValidate, rect, step, stepCount, stepIndex, tone, validated, visible]);

  if (!body || typeof document === "undefined" || !document.body) {
    return null;
  }
  return createPortal(body, document.body);
}