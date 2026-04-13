type StepKey = "decision" | "operator" | "pnl";

type SearchParamsInput = Promise<{ step?: string | string[] | undefined }> | { step?: string | string[] | undefined } | undefined;

const STEP_ORDER: StepKey[] = ["decision", "operator", "pnl"];

const STEP_CONFIG: Record<StepKey, {
  targetId: string;
  title: string;
  explanation: string;
  validationLabel: string;
  tone: "good" | "subtle" | "warn";
  overlayStyle: { top: number; left: number };
  dotStyle: { top: number; left: number };
}> = {
  decision: {
    targetId: "terminal-decision-layer",
    title: "Lis la decision immediate",
    explanation: "Commence par le Decision Layer pour savoir si le terminal veut attendre, reduire ou executer petit.",
    validationLabel: "decision chargee",
    tone: "subtle",
    overlayStyle: { top: 188, left: 870 },
    dotStyle: { top: 230, left: 822 },
  },
  operator: {
    targetId: "terminal-operator-action",
    title: "Valide la stabilite",
    explanation: "Regarde le bloc operateur pour confirmer qu'aucun guardrail ne force un ralentissement ou un override visible.",
    validationLabel: "stabilite acquise",
    tone: "subtle",
    overlayStyle: { top: 466, left: 870 },
    dotStyle: { top: 512, left: 822 },
  },
  pnl: {
    targetId: "terminal-pnl-truth",
    title: "Laisse le no-trade dominer",
    explanation: "Verifie que le reward, le drift et la discipline restent superieurs a l'envie d'entrer.",
    validationLabel: "filtre defensif actif",
    tone: "warn",
    overlayStyle: { top: 744, left: 870 },
    dotStyle: { top: 790, left: 822 },
  },
};

async function resolveSearchParams(searchParams: SearchParamsInput): Promise<{ step?: string | string[] | undefined }> {
  if (!searchParams) {
    return {};
  }
  if (typeof (searchParams as Promise<{ step?: string | string[] | undefined }>).then === "function") {
    return searchParams as Promise<{ step?: string | string[] | undefined }>;
  }
  return searchParams as { step?: string | string[] | undefined };
}

function normalizeStepKey(step: string | string[] | undefined): StepKey {
  const raw = Array.isArray(step) ? step[0] : step;
  return STEP_ORDER.includes(raw as StepKey) ? (raw as StepKey) : "decision";
}

export default async function TerminalGuideVisualLockPage({
  searchParams,
}: {
  searchParams?: SearchParamsInput;
}) {
  const resolvedSearchParams = await resolveSearchParams(searchParams);
  const activeStep = normalizeStepKey(resolvedSearchParams.step);
  const stepConfig = STEP_CONFIG[activeStep];

  return (
    <main className="guide-visual-lock-surface">
      <section className="guide-visual-lock-stage" data-testid="guide-visual-lock-stage">
        <div className="guide-visual-lock-shell">
          <div className="guide-visual-lock-header">
            <div className="eyebrow">Terminal Visual Lock</div>
            <h1>Coach overlay and guided anchors</h1>
            <p>Contrat visuel dedie aux trois zones guidees du terminal: decision, bloc operateur et verite PnL.</p>
          </div>
          <div className="guide-visual-lock-grid">
            {STEP_ORDER.map((stepKey, index) => {
              const step = STEP_CONFIG[stepKey];
              const isActive = stepConfig.targetId === step.targetId;
              return (
                <section
                  key={step.targetId}
                  id={step.targetId}
                  className={`guide-visual-lock-section terminal-guide-anchor${isActive ? " is-guided-target" : ""}`}
                >
                  <div className="guide-visual-lock-section-head">
                    <div>
                      <div className="eyebrow">Zone {index + 1}</div>
                      <strong>{step.title}</strong>
                    </div>
                    <span className={`terminal-onboarding-pill ${isActive ? step.tone : "subtle"}`}>{step.validationLabel}</span>
                  </div>
                  <p>{step.explanation}</p>
                  <div className="guide-visual-lock-meta">
                    <span>id {step.targetId}</span>
                    <span>{isActive ? "guide actif" : "zone passive"}</span>
                  </div>
                </section>
              );
            })}
          </div>
        </div>

        <div className={`terminal-coach-overlay-dot ${stepConfig.tone}`} style={stepConfig.dotStyle} />
        <div
          className={`terminal-coach-overlay ${stepConfig.tone} guide-visual-lock-overlay-shell`}
          style={stepConfig.overlayStyle}
          role="dialog"
          aria-label="Coach overlay terminal"
        >
          <div className="terminal-coach-overlay-card">
            <div className="terminal-coach-overlay-head">
              <div>
                <div className="terminal-coach-overlay-kicker">Coach overlay</div>
                <div className="terminal-coach-overlay-title">{stepConfig.title}</div>
              </div>
              <button type="button" className="terminal-coach-overlay-close" aria-label="Masquer le coach overlay">x</button>
            </div>
            <div className="terminal-coach-overlay-pills">
              <span className={`terminal-coach-overlay-pill ${stepConfig.tone}`}>assistance MEDIUM</span>
              <span className="terminal-coach-overlay-pill subtle">{stepConfig.validationLabel}</span>
            </div>
            <p className="terminal-coach-overlay-copy">{stepConfig.explanation}</p>
            <div className="terminal-coach-overlay-actions">
              <button type="button" className="btn">Pointer la zone</button>
              <button type="button" className="btn">Commandant</button>
              <button type="button" className="btn btn-primary">Suivant</button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}