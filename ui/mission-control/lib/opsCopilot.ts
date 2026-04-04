export type OpsCopilotPromptDetail = {
  message: string;
  autoSend?: boolean;
};

export function openOpsCopilotPrompt(detail: OpsCopilotPromptDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent("ops-copilot:prompt", { detail }));
}