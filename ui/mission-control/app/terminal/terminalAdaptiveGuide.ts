import type { SmartDecisionHudShape } from "./chartHudTypes";
import type { FeedbackSummary } from "./feedbackEngine";

export type TerminalAdaptiveGuideMode = "READ_MARKET" | "EXECUTE_SAFE" | "CALIBRATE";
export type TerminalAdaptiveGuideTone = "good" | "subtle" | "warn";
export type TerminalAdaptiveGuideAssistanceLevel = "LOW" | "MEDIUM" | "HIGH";
export type TerminalAdaptiveGuideTargetId = "terminal-onboarding" | "terminal-decision-layer" | "terminal-operator-action" | "terminal-pnl-truth";

export type TerminalAdaptiveGuideStep = {
  id: string;
  title: string;
  explanation: string;
  targetId: TerminalAdaptiveGuideTargetId;
  completed: boolean;
  validationLabel: string;
};

export type TerminalAdaptiveGuidePlan = {
  mode: TerminalAdaptiveGuideMode;
  title: string;
  headline: string;
  summary: string;
  tone: TerminalAdaptiveGuideTone;
  layoutPreset: "scalp" | "monitoring";
  uiMode: "novice" | "expert";
  densityMode: "focus" | "full";
  commandPrompt: string;
  steps: TerminalAdaptiveGuideStep[];
};

export type TerminalAdaptiveGuide = {
  recommendedMode: TerminalAdaptiveGuideMode;
  headline: string;
  summary: string;
  tone: TerminalAdaptiveGuideTone;
  assistanceLevel: TerminalAdaptiveGuideAssistanceLevel;
  assistanceReason: string;
  disciplineLock: boolean;
  disciplineReason: string | null;
  plans: TerminalAdaptiveGuidePlan[];
};

type JournalRow = Record<string, unknown>;

function makeStep(step: Omit<TerminalAdaptiveGuideStep, "completed" | "validationLabel"> & { completed: boolean; validationLabel?: string }): TerminalAdaptiveGuideStep {
  return {
    ...step,
    validationLabel: step.validationLabel || (step.completed ? "ok" : "a verifier"),
  };
}

function resolveGuideTone(input: { completedSteps: number; totalSteps: number; hardBlock?: boolean }): TerminalAdaptiveGuideTone {
  if (input.hardBlock) {
    return "warn";
  }
  const ratio = input.totalSteps > 0 ? input.completedSteps / input.totalSteps : 0;
  if (ratio >= 0.67) {
    return "good";
  }
  if (ratio >= 0.34) {
    return "subtle";
  }
  return "warn";
}

function normalizeKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function countJournalActions(entries: JournalRow[], actions: Set<string>, hours: number, nowMs: number): number {
  const windowMs = hours * 60 * 60 * 1000;
  return entries.filter((entry) => {
    if (!actions.has(normalizeKey(entry.action))) {
      return false;
    }
    const createdAt = Date.parse(String(entry.createdAtIso || entry.created_at || ""));
    return Number.isFinite(createdAt) && nowMs - createdAt <= windowMs;
  }).length;
}

function resolveAssistance(input: {
  feedbackSummary: FeedbackSummary;
  journalEntries: JournalRow[];
  disciplineLock: boolean;
  nowMs: number;
}): { level: TerminalAdaptiveGuideAssistanceLevel; reason: string } {
  const override24h = countJournalActions(input.journalEntries, new Set(["override-visible-on"]), 24, input.nowMs);
  const forced24h = countJournalActions(input.journalEntries, new Set(["auto-reduce", "auto-close", "emergency-stop"]), 24, input.nowMs);
  const reopened72h = countJournalActions(input.journalEntries, new Set(["daily-plan-task-reopened", "daily-plan-sprint-reset"]), 72, input.nowMs);
  const disciplineWins7d = countJournalActions(input.journalEntries, new Set(["daily-plan-task-done", "daily-plan-brief-opened", "sprint-brief-opened"]), 168, input.nowMs);
  const negativeEvents = override24h + forced24h + reopened72h;

  if (input.disciplineLock || negativeEvents >= 2 || input.feedbackSummary.modelHealth === "BROKEN" || input.feedbackSummary.driftState === "LOCK") {
    return {
      level: "HIGH",
      reason: input.disciplineLock
        ? `discipline lock active: ${input.feedbackSummary.protections[0] || "hard protection"}`
        : `${negativeEvents.toFixed(0)} recent operator error(s) require stronger guidance`,
    };
  }
  if (
    negativeEvents === 0
    && input.feedbackSummary.modelHealth === "HEALTHY"
    && input.feedbackSummary.reward.scorePct >= 65
  ) {
    return {
      level: "LOW",
      reason: disciplineWins7d >= 2
        ? "recent discipline is clean enough to keep guidance lightweight"
        : "no recent operator error and healthy live feedback let the guide stay light",
    };
  }
  return {
    level: "MEDIUM",
    reason: negativeEvents > 0
      ? `recent operator friction detected: ${negativeEvents.toFixed(0)} event(s)`
      : "keep the guide visible until the live flow stays cleaner",
  };
}

function buildReadMarketPlan(input: {
  smartDecision: SmartDecisionHudShape | null;
  feedbackSummary: FeedbackSummary;
}): TerminalAdaptiveGuidePlan {
  const smartDecisionReady = Boolean(input.smartDecision);
  const decisionStable = Boolean(input.smartDecision?.stability.isStable);
  const noTradeDominant = input.feedbackSummary.tradeCount === 0
    || input.feedbackSummary.tradeQualityCounts.GOOD_NO_TRADE > 0
    || input.feedbackSummary.driftState !== "CALM";
  const steps = [
    makeStep({
      id: "read-decision",
      title: "Lis la decision immediate",
      explanation: "Commence par le Decision Layer pour savoir si le terminal veut attendre, reduire ou executer petit.",
      targetId: "terminal-decision-layer",
      completed: smartDecisionReady,
      validationLabel: smartDecisionReady ? "decision chargee" : "decision en attente",
    }),
    makeStep({
      id: "check-stability",
      title: "Valide la stabilite",
      explanation: "Regarde si l'etat est stable ou encore en confirmation avant de croire au signal.",
      targetId: "terminal-operator-action",
      completed: decisionStable,
      validationLabel: decisionStable ? "stabilite acquise" : "confirmation requise",
    }),
    makeStep({
      id: "respect-no-trade",
      title: "Laisse le no-trade dominer",
      explanation: "Avant d'agir, confirme que la discipline et la dominance no-trade restent superieures a l'envie d'entrer.",
      targetId: "terminal-pnl-truth",
      completed: noTradeDominant,
      validationLabel: noTradeDominant ? "filtre defensif actif" : "flux encore permissif",
    }),
  ];
  const completedSteps = steps.filter((step) => step.completed).length;
  return {
    mode: "READ_MARKET",
    title: "Read the market",
    headline: "Comprendre avant de trader",
    summary: "Le terminal doit d'abord te montrer l'etat du signal, sa stabilite et la domination du no-trade.",
    tone: resolveGuideTone({ completedSteps, totalSteps: steps.length }),
    layoutPreset: "scalp",
    uiMode: "novice",
    densityMode: "focus",
    commandPrompt: "Mode commandant: aide-moi a lire le terminal maintenant. Donne DECISION, STABILITE, NO-TRADE DOMINANCE et dis clairement si je dois juste observer.",
    steps,
  };
}

function buildExecuteSafePlan(input: {
  smartDecision: SmartDecisionHudShape | null;
  feedbackSummary: FeedbackSummary;
}): TerminalAdaptiveGuidePlan {
  const entryReady = input.smartDecision?.state === "ENTRY_VALID" && input.smartDecision.qualityGate === "pass";
  const stabilityReady = Boolean(input.smartDecision?.stability.isStable);
  const safeToExecute = !input.feedbackSummary.forceNoTrade && !input.feedbackSummary.learningDisabled && !input.feedbackSummary.reduceSize;
  const steps = [
    makeStep({
      id: "entry-stable",
      title: "Confirme l'entree stable",
      explanation: "Le Decision Layer doit montrer un signal stable et propre, pas juste une impulsion instantanee.",
      targetId: "terminal-decision-layer",
      completed: Boolean(entryReady && stabilityReady),
      validationLabel: entryReady && stabilityReady ? "entry valid stable" : "pas encore tradable",
    }),
    makeStep({
      id: "check-operator-guard",
      title: "Lis le bloc operateur",
      explanation: "Le bloc operateur doit rester compatible avec une entree petite, sans garde dure ni override cache.",
      targetId: "terminal-operator-action",
      completed: safeToExecute,
      validationLabel: safeToExecute ? "micro-live possible" : "garde active",
    }),
    makeStep({
      id: "verify-feedback-floor",
      title: "Verifie le plancher feedback",
      explanation: "Avant le clic, verifie que le reward, le drift et la discipline n'obligent pas a reduire ou geler.",
      targetId: "terminal-pnl-truth",
      completed: input.feedbackSummary.reward.scorePct >= 45 && input.feedbackSummary.driftState === "CALM",
      validationLabel: input.feedbackSummary.reward.scorePct >= 45 && input.feedbackSummary.driftState === "CALM" ? "feedback propre" : "feedback defensif",
    }),
  ];
  const completedSteps = steps.filter((step) => step.completed).length;
  return {
    mode: "EXECUTE_SAFE",
    title: "Execute safe",
    headline: "Executer petit, jamais forcer",
    summary: "L'entree n'est validee que si la decision reste stable et si le feedback n'impose ni freeze ni no-trade.",
    tone: resolveGuideTone({ completedSteps, totalSteps: steps.length, hardBlock: input.feedbackSummary.forceNoTrade }),
    layoutPreset: "scalp",
    uiMode: "expert",
    densityMode: "focus",
    commandPrompt: "Mode commandant: confirme si une entree micro-live est autorisee maintenant. Donne DECISION, RISQUE, TAILLE et rappelle que je ne dois pas passer outre une garde active.",
    steps,
  };
}

function buildCalibratePlan(input: {
  smartDecision: SmartDecisionHudShape | null;
  feedbackSummary: FeedbackSummary;
}): TerminalAdaptiveGuidePlan {
  const feedbackReady = input.feedbackSummary.tradeCount > 0;
  const shieldReady = input.feedbackSummary.errors.length > 0;
  const cappedActions = input.feedbackSummary.calibrationActions.every((action) => action.magnitudePct <= input.feedbackSummary.maxAdjustmentPerDayPct);
  const steps = [
    makeStep({
      id: "review-truth",
      title: "Lis la verite PnL",
      explanation: "Commence par les faits: model health, drift, reward et erreurs de feedback reel.",
      targetId: "terminal-pnl-truth",
      completed: feedbackReady,
      validationLabel: feedbackReady ? `${input.feedbackSummary.tradeCount.toFixed(0)} echantillons` : "pas assez d'echantillons",
    }),
    makeStep({
      id: "respect-shield",
      title: "Respecte le shield",
      explanation: "Si le shield passe en REVIEW, REJECT ou FROZEN, tu ralentis ou tu geleras l'apprentissage avant toute calibration.",
      targetId: "terminal-pnl-truth",
      completed: shieldReady && input.feedbackSummary.shield.learningState !== "ACTIVE" ? true : shieldReady,
      validationLabel: `${input.feedbackSummary.shield.multiRegimeValidation} / ${input.feedbackSummary.shield.learningState}`,
    }),
    makeStep({
      id: "apply-small-adjustment",
      title: "Ajuste lentement",
      explanation: "Les calibrations restent bornees a 5% par jour et ne doivent jamais reconfigurer brutalement le systeme.",
      targetId: "terminal-onboarding",
      completed: cappedActions,
      validationLabel: cappedActions ? `cap ${input.feedbackSummary.maxAdjustmentPerDayPct.toFixed(0)}% respecte` : "budget depasse",
    }),
  ];
  const completedSteps = steps.filter((step) => step.completed).length;
  return {
    mode: "CALIBRATE",
    title: "Calibrate",
    headline: "Corriger sans sur-ajuster",
    summary: "La calibration doit suivre le feedback reel, le shield et le cap de variation journalier, jamais l'emotion du dernier trade.",
    tone: resolveGuideTone({ completedSteps, totalSteps: steps.length, hardBlock: input.feedbackSummary.driftState === "LOCK" }),
    layoutPreset: "monitoring",
    uiMode: "novice",
    densityMode: "full",
    commandPrompt: "Mode commandant: resume la calibration a appliquer maintenant. Donne MODEL HEALTH, DRIFT, ACTIONS BORNEES, et dis explicitement si l'apprentissage doit etre gele.",
    steps,
  };
}

export function buildTerminalAdaptiveGuide(input: {
  smartDecision: SmartDecisionHudShape | null;
  feedbackSummary: FeedbackSummary;
  journalEntries?: JournalRow[];
  nowMs?: number;
}): TerminalAdaptiveGuide {
  const journalEntries = Array.isArray(input.journalEntries) ? input.journalEntries : [];
  const nowMs = input.nowMs ?? Date.now();
  const readMarketPlan = buildReadMarketPlan(input);
  const executeSafePlan = buildExecuteSafePlan(input);
  const calibratePlan = buildCalibratePlan(input);
  const disciplineLock = input.feedbackSummary.forceNoTrade || input.feedbackSummary.learningDisabled || input.feedbackSummary.driftState === "LOCK";
  const disciplineReason = disciplineLock
    ? input.feedbackSummary.protections[0] || "hard protection active"
    : null;

  const recommendedMode: TerminalAdaptiveGuideMode = disciplineLock
    ? "CALIBRATE"
    : executeSafePlan.steps.every((step) => step.completed)
      ? "EXECUTE_SAFE"
      : input.smartDecision?.state === "ENTRY_VALID"
        ? "EXECUTE_SAFE"
        : input.feedbackSummary.tradeCount > 0 && (input.feedbackSummary.modelHealth === "DEGRADING" || input.feedbackSummary.driftState !== "CALM")
          ? "CALIBRATE"
          : "READ_MARKET";

  const recommendedPlan = [readMarketPlan, executeSafePlan, calibratePlan].find((plan) => plan.mode === recommendedMode) || readMarketPlan;
  const assistance = resolveAssistance({
    feedbackSummary: input.feedbackSummary,
    journalEntries,
    disciplineLock,
    nowMs,
  });

  return {
    recommendedMode,
    headline: disciplineLock
      ? "Le guide bascule en mode discipline"
      : recommendedPlan.headline,
    summary: disciplineLock
      ? "Le systeme protege d'abord l'execution et l'apprentissage. Tu calibres ou tu observes, tu ne forces pas."
      : recommendedPlan.summary,
    tone: disciplineLock ? "warn" : recommendedPlan.tone,
    assistanceLevel: assistance.level,
    assistanceReason: assistance.reason,
    disciplineLock,
    disciplineReason,
    plans: [readMarketPlan, executeSafePlan, calibratePlan],
  };
}