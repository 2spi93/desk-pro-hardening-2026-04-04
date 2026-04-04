import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultLocalTerminalCaptureStore,
  type LocalTerminalAutoIncident,
  type LocalTerminalRuntimeCapture,
  normalizeLocalTerminalCaptureStore,
  type PersistedLocalTerminalCaptureStore,
  setLocalTerminalAutoIncident,
  upsertLocalTerminalCaptureStore,
} from "./localTerminalCapture";

function localTerminalCapturePath(): string {
  return path.resolve(process.cwd(), "../../logs/healthwatch/local-terminal-captures.json");
}

export async function readLocalTerminalCaptureStore(): Promise<PersistedLocalTerminalCaptureStore> {
  try {
    const raw = await readFile(localTerminalCapturePath(), "utf8");
    return normalizeLocalTerminalCaptureStore(JSON.parse(raw) as unknown);
  } catch {
    return defaultLocalTerminalCaptureStore();
  }
}

export async function writeLocalTerminalCapture(capture: LocalTerminalRuntimeCapture): Promise<PersistedLocalTerminalCaptureStore> {
  const current = await readLocalTerminalCaptureStore();
  const next = upsertLocalTerminalCaptureStore(current, capture);
  await mkdir(path.dirname(localTerminalCapturePath()), { recursive: true });
  await writeFile(localTerminalCapturePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function writeLocalTerminalAutoIncident(incident: LocalTerminalAutoIncident): Promise<PersistedLocalTerminalCaptureStore> {
  const current = await readLocalTerminalCaptureStore();
  const next = setLocalTerminalAutoIncident(current, incident);
  await mkdir(path.dirname(localTerminalCapturePath()), { recursive: true });
  await writeFile(localTerminalCapturePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}