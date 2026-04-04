"use client";

import { useEffect } from "react";

import { readStoredUiMode } from "../../lib/userUiPrefs";

export default function UiModeController() {
  useEffect(() => {
    const mode = readStoredUiMode();
    document.documentElement.setAttribute("data-ui-mode", mode);
  }, []);

  return null;
}