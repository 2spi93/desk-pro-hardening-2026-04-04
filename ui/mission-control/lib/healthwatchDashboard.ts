import { readFile } from "node:fs/promises";
import path from "node:path";

export type HealthwatchDashboardPayload = {
  generated_at?: string;
  public_chart_visibility?: unknown;
  [key: string]: unknown;
};

function dashboardPath(): string {
  return path.resolve(process.cwd(), "../../logs/healthwatch/dashboard.json");
}

export async function readHealthwatchDashboard(): Promise<HealthwatchDashboardPayload | null> {
  try {
    const raw = await readFile(dashboardPath(), "utf8");
    return JSON.parse(raw) as HealthwatchDashboardPayload;
  } catch {
    return null;
  }
}