"use client";

import { useEffect, useMemo, useState } from "react";

type OpsCopilotPromptDetail = {
  message?: string;
  autoSend?: boolean;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

type ChatResponse = {
  status?: string;
  reply?: string;
  actions?: string[];
  suggested_actions?: Array<Record<string, unknown>>;
  confirmation?: {
    token?: string;
    summary?: string;
    expires_at?: string;
  };
};

const PAGE_SHORTCUTS = [
  { href: "/terminal", label: "Terminal" },
  { href: "/ai", label: "AI Desk" },
  { href: "/live-capital", label: "Live Capital" },
  { href: "/connectors", label: "Connectors" },
  { href: "/connections", label: "Connections" },
] as const;

const PROMPT_SHORTCUTS = [
  "Explique-moi la différence entre fonds paper, live, exchange et wallet.",
  "Vérifie ce qu'il est possible de contrôler sur la plateforme et les fonds disponibles.",
  "Propose si la stratégie doit être promue vers un usage live et pourquoi.",
  "Résume-moi les pages utiles pour piloter le capital et les connecteurs.",
] as const;

export default function OpsChatbot() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Ops Copilot actif. Je peux expliquer paper/live/exchange/wallet, vérifier les workflows capital/plateforme, guider la promotion live d'une stratégie et t'orienter vers les bons desks.",
    },
  ]);
  const [pendingAction, setPendingAction] = useState("run_runbook");
  const [actionRegime, setActionRegime] = useState("trend");
  const [actionTitle, setActionTitle] = useState("Derive strategie detectee");
  const [safeMode, setSafeMode] = useState(true);
  const [confirmToken, setConfirmToken] = useState("");
  const [confirmSummary, setConfirmSummary] = useState("");

  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  useEffect(() => {
    function onPrompt(event: Event): void {
      const detail = (event as CustomEvent<OpsCopilotPromptDetail>).detail;
      const message = String(detail?.message || "").trim();
      if (!message) {
        return;
      }
      setOpen(true);
      if (detail?.autoSend) {
        void sendMessage(message);
        return;
      }
      setInput(message);
    }

    window.addEventListener("ops-copilot:prompt", onPrompt as EventListener);
    return () => window.removeEventListener("ops-copilot:prompt", onPrompt as EventListener);
  }, [loading]);

  async function sendMessage(forcedMessage?: string): Promise<void> {
    const message = String(forcedMessage ?? input).trim();
    if (!message) {
      return;
    }
    setMessages((prev) => [...prev, { role: "user", text: message }]);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = (await response.json()) as ChatResponse;
      const text = String(payload.reply || "Aucune reponse");
      const actions = (payload.actions || []).map((a) => `#${a}`).join(" ");
      const suggestions = (payload.suggested_actions || [])
        .map((s) => String(s.label || s.type || "action"))
        .join(" | ");
      setMessages((prev) => [...prev, { role: "assistant", text: `${text}${actions ? `\n${actions}` : ""}` }]);
      if ((payload.actions || []).includes("open_incident_board")) {
        setMessages((prev) => [...prev, { role: "assistant", text: "Ouvre /incidents pour traiter les tickets." }]);
      }
      if ((payload.actions || []).includes("open_live_capital")) {
        setMessages((prev) => [...prev, { role: "assistant", text: "Ouvre /live-capital pour distinguer paper/live/exchange/wallet, vérifier les comptes source et poser les caps d'allocation." }]);
      }
      if ((payload.actions || []).includes("open_connectors_hub")) {
        setMessages((prev) => [...prev, { role: "assistant", text: "Ouvre /connectors ou /connections pour contrôler la plateforme, les credentials, les statuts d'intégration et les venues branchés." }]);
      }
      if ((payload.actions || []).includes("open_ai_desk")) {
        setMessages((prev) => [...prev, { role: "assistant", text: "Ouvre /ai pour relire la gouvernance de route, les sources de capital et les vérifications plateforme en langage naturel." }]);
      }
      if ((payload.actions || []).includes("review_strategy_promotion")) {
        setMessages((prev) => [...prev, { role: "assistant", text: "Va sur /live-capital pour confronter la proposition de promotion de stratégie au compte source, au cap USD et au niveau courant." }]);
      }
      if (suggestions) {
        setMessages((prev) => [...prev, { role: "assistant", text: `Actions guidees: ${suggestions}` }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: "Erreur reseau. Reessaie dans quelques secondes." }]);
    } finally {
      setLoading(false);
    }
  }

  async function runGuidedAction(): Promise<void> {
    if (loading) {
      return;
    }
    setLoading(true);
    let action: Record<string, unknown> = { type: pendingAction };
    if (pendingAction === "apply_threshold") {
      action = {
        type: "apply_threshold",
        regime: actionRegime,
        min_samples: 25,
        min_win_rate: 0.52,
        max_drawdown_usd: 1000,
        max_avg_loss_usd: 140,
      };
    }
    if (pendingAction === "open_incident_ticket") {
      action = {
        type: "open_incident_ticket",
        title: actionTitle,
        severity: "high",
        payload: { origin: "ops-chatbot" },
      };
    }
    if (pendingAction === "run_runbook") {
      action = { type: "run_runbook", name: "stabilize_trading" };
    }

    try {
      const response = await fetch("/api/chat/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, safe_mode: safeMode }),
      });
      const payload = (await response.json()) as ChatResponse;
      const status = String(payload.status || "");
      if (status === "confirmation_required") {
        const token = String(payload.confirmation?.token || "");
        setConfirmToken(token);
        setConfirmSummary(String(payload.confirmation?.summary || "Confirmer action"));
        setMessages((prev) => [...prev, { role: "assistant", text: `${String(payload.reply || "Confirmation requise")}\n${String(payload.confirmation?.expires_at || "")}` }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", text: String(payload.reply || "Action executee") }]);
        setConfirmToken("");
        setConfirmSummary("");
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: "Echec action guidee." }]);
    } finally {
      setLoading(false);
    }
  }

  async function confirmGuidedAction(): Promise<void> {
    if (!confirmToken || loading) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/chat/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_token: confirmToken, confirm_ack: true }),
      });
      const payload = (await response.json()) as ChatResponse;
      setMessages((prev) => [...prev, { role: "assistant", text: String(payload.reply || "Action confirmee") }]);
      setConfirmToken("");
      setConfirmSummary("");
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: "Confirmation echouee." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ops-chatbot-wrap">
      <button type="button" className="ops-chatbot-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Fermer Copilot" : "Ops Copilot"}
      </button>
      {open ? (
        <div className="ops-chatbot-panel">
          <div className="ops-chatbot-head">Agent Ops</div>
            <div className="ops-chatbot-guided" style={{ paddingTop: 0 }}>
              <div className="subtle mini">Raccourcis pages</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {PAGE_SHORTCUTS.map((shortcut) => (
                  <a key={shortcut.href} href={shortcut.href} className="subtle mini">{shortcut.label}</a>
                ))}
              </div>
              <div className="subtle mini" style={{ marginTop: 6 }}>Prompts rapides</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {PROMPT_SHORTCUTS.map((shortcut) => (
                  <button key={shortcut} type="button" disabled={loading} onClick={() => void sendMessage(shortcut)}>
                    {shortcut}
                  </button>
                ))}
              </div>
            </div>
          <div className="ops-chatbot-messages">
            {messages.map((m, idx) => (
              <div key={`${m.role}-${idx}`} className={m.role === "assistant" ? "chat-bubble assistant" : "chat-bubble user"}>
                {m.text}
              </div>
            ))}
          </div>
          <div className="ops-chatbot-input-row">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Pose une question operationnelle..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSend) {
                  void sendMessage();
                }
              }}
            />
            <button type="button" disabled={!canSend} onClick={() => void sendMessage()}>
              {loading ? "..." : "Envoyer"}
            </button>
          </div>
          <div className="ops-chatbot-guided">
            <label className="subtle mini" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={safeMode} onChange={(e) => setSafeMode(e.target.checked)} />
              Safe action confirmation (2 etapes)
            </label>
            <select value={pendingAction} onChange={(e) => setPendingAction(e.target.value)}>
              <option value="run_runbook">Lancer runbook</option>
              <option value="apply_threshold">Appliquer seuil regime</option>
              <option value="open_incident_ticket">Ouvrir ticket incident</option>
            </select>
            {pendingAction === "apply_threshold" ? (
              <input value={actionRegime} onChange={(e) => setActionRegime(e.target.value)} placeholder="regime" />
            ) : null}
            {pendingAction === "open_incident_ticket" ? (
              <input value={actionTitle} onChange={(e) => setActionTitle(e.target.value)} placeholder="titre incident" />
            ) : null}
            <button type="button" disabled={loading} onClick={() => void runGuidedAction()}>
              {loading ? "..." : "Executer action"}
            </button>
            {confirmToken ? (
              <>
                <div className="subtle mini">{confirmSummary}</div>
                <button type="button" disabled={loading} onClick={() => void confirmGuidedAction()}>
                  {loading ? "..." : "Confirmer action sensible"}
                </button>
              </>
            ) : null}
            <a href="/incidents" className="subtle mini">Ouvrir Incident Desk</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
