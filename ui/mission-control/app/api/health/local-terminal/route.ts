import { NextRequest, NextResponse } from "next/server";

import { getControlPlaneToken } from "../../../../lib/controlPlane";
import { appendAuditEvent } from "../../../../lib/auditEvents";
import {
  buildLocalTerminalIncidentSignature,
  getLocalTerminalAutoIncident,
  getLocalTerminalCaptureHistory,
  getLatestLocalTerminalCapture,
  getLocalTerminalCaptureByClientId,
  isLocalTerminalRuntimeCapture,
  summarizeRecentLocalTerminalCaptureEvents,
  summarizeLocalTerminalCaptures,
} from "../../../../lib/localTerminalCapture";
import { closeIncidentTicket, getIncidentTicket, listIncidentTickets, openIncidentTicket, type IncidentTicketRecord } from "../../../../lib/incidentTickets";
import { readLocalTerminalCaptureStore, writeLocalTerminalAutoIncident, writeLocalTerminalCapture } from "../../../../lib/localTerminalCaptureStore";

const AUTO_CLOSE_MIN_HEALTHY_FRAMES = 3;

function buildChartIncidentTitle(capture: {
  chart: { instrument: string; timeframe: string };
}): string {
  return `Terminal local hard fail ${capture.chart.instrument} ${capture.chart.timeframe}`;
}

function isIncidentClosedStatus(status: string | null | undefined): boolean {
  return String(status || "").toLowerCase() === "closed";
}

function matchesLocalTerminalChartIncident(
  incident: IncidentTicketRecord,
  capture: {
    chart: { instrument: string; timeframe: string; venue: string };
  },
): boolean {
  if (incident.title !== buildChartIncidentTitle(capture)) {
    return false;
  }
  const payload = incident.payload && typeof incident.payload === "object" ? incident.payload : {};
  const origin = typeof payload.origin === "string" ? payload.origin : "";
  const chartPayload = payload.chart && typeof payload.chart === "object"
    ? payload.chart as Record<string, unknown>
    : {};
  const instrument = typeof chartPayload.instrument === "string" ? chartPayload.instrument : "";
  const timeframe = typeof chartPayload.timeframe === "string" ? chartPayload.timeframe : "";
  const venue = typeof chartPayload.venue === "string" ? chartPayload.venue : "";
  return origin === "local-terminal-health"
    && instrument === capture.chart.instrument
    && timeframe === capture.chart.timeframe
    && venue === capture.chart.venue;
}

async function findActiveMatchingLocalTerminalIncidents(capture: {
  chart: { instrument: string; timeframe: string; venue: string };
}): Promise<IncidentTicketRecord[]> {
  const incidentList = await listIncidentTickets().catch(() => null);
  if (!incidentList?.ok) {
    return [];
  }
  return incidentList.items.filter((incident) => (
    !isIncidentClosedStatus(incident.status)
      && matchesLocalTerminalChartIncident(incident, capture)
  ));
}

function isDurablyHealthyCapture(capture: {
  localFeed: { signal: string };
  runtime: { blockedByFiveStateFailure: boolean; noCandlesExpected: boolean; bus: { status: string }; ohlcv: { status: string } };
}): boolean {
  return capture.localFeed.signal === "OHLCV_RENDERABLE"
    && !capture.runtime.blockedByFiveStateFailure
    && !capture.runtime.noCandlesExpected
    && capture.runtime.bus.status === "ok"
    && capture.runtime.ohlcv.status === "live";
}

function hasHealthyCaptureSince(
  history: Array<{
    capturedAt: string;
    localFeed: { signal: string };
    runtime: { blockedByFiveStateFailure: boolean; noCandlesExpected: boolean; bus: { status: string }; ohlcv: { status: string } };
  }>,
  timestamp: string | null | undefined,
): boolean {
  if (!timestamp) {
    return false;
  }
  return history.some((capture) => String(capture.capturedAt) > timestamp && isDurablyHealthyCapture(capture));
}

function summarizeTransitionPayload(current: {
  clientId: string;
  chart: { instrument: string; timeframe: string; venue: string; feedLabel: string };
  localFeed: { signal: string; message: string; renderableRows: number; fetchedRows: number };
  runtime: { exactStateVector: string[]; bars: { state: string }; blockedByFiveStateFailure: boolean };
}, previous: {
  localFeed?: { signal?: string };
  runtime?: { bars?: { state?: string } };
} | null, ticketKey: string | null): Record<string, unknown> {
  return {
    client_id: current.clientId,
    ticket_key: ticketKey,
    chart_feed: current.chart.feedLabel,
    instrument: current.chart.instrument,
    timeframe: current.chart.timeframe,
    venue: current.chart.venue,
    signal: current.localFeed.signal,
    message: current.localFeed.message,
    renderable_rows: current.localFeed.renderableRows,
    fetched_rows: current.localFeed.fetchedRows,
    bars_state: current.runtime.bars.state,
    blocked_by_five_state_failure: current.runtime.blockedByFiveStateFailure,
    exact_state_vector: current.runtime.exactStateVector,
    previous_signal: previous?.localFeed?.signal || null,
    previous_bars_state: previous?.runtime?.bars?.state || null,
  };
}

function noStoreJson(payload: unknown, status = 200): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const store = await readLocalTerminalCaptureStore();
  const clientId = request.nextUrl.searchParams.get("client_id");
  const requestedCapture = getLocalTerminalCaptureByClientId(store, clientId);
  const latestCapture = getLatestLocalTerminalCapture(store);
  const capture = requestedCapture || latestCapture;
  const captureClientId = capture?.clientId || clientId;
  const captureHistory = getLocalTerminalCaptureHistory(store, captureClientId);
  const autoIncident = getLocalTerminalAutoIncident(store, captureClientId);

  return noStoreJson({
    available: Boolean(capture),
    requested_client_id: clientId,
    latest_client_id: store.latestClientId,
    updated_at: store.updatedAt,
    capture,
    capture_history: captureHistory,
    auto_incident: autoIncident,
    recent_captures: summarizeLocalTerminalCaptures(store),
    recent_capture_events: summarizeRecentLocalTerminalCaptureEvents(store),
  }, 200);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = await getControlPlaneToken();
  if (!token) {
    return noStoreJson({ status: "error", detail: "authentication_required" }, 401);
  }

  const body = await request.json().catch(() => null);
  if (!isLocalTerminalRuntimeCapture(body)) {
    return noStoreJson({ status: "error", detail: "invalid_local_terminal_capture" }, 400);
  }

  const previousStore = await readLocalTerminalCaptureStore();
  const previousCapture = getLocalTerminalCaptureByClientId(previousStore, body.clientId);
  let store = await writeLocalTerminalCapture(body);
  const incidentSignature = buildLocalTerminalIncidentSignature(body);
  const existingIncident = getLocalTerminalAutoIncident(store, body.clientId);
  let autoIncident = existingIncident;
  const currentHistory = getLocalTerminalCaptureHistory(store, body.clientId);

  if (autoIncident?.ticketKey) {
    const currentTicket = await getIncidentTicket(autoIncident.ticketKey).catch(() => null);
    if (currentTicket?.ok && isIncidentClosedStatus(currentTicket.ticketStatus) && autoIncident.status !== "closed") {
      autoIncident = {
        ...autoIncident,
        closedAt: autoIncident.closedAt || body.capturedAt,
        detail: "incident_closed_remote",
        status: "closed",
      };
      store = await writeLocalTerminalAutoIncident(autoIncident);
    }
  }

  const canReopenSameSignature = autoIncident?.status === "closed"
    && autoIncident.signature === incidentSignature
    && hasHealthyCaptureSince(currentHistory, autoIncident.closedAt || autoIncident.openedAt);

  if (body.runtime.blockedByFiveStateFailure && (!autoIncident || autoIncident.signature !== incidentSignature || canReopenSameSignature)) {
    const incidentTitle = buildChartIncidentTitle(body);
    const matchingActiveIncidents = await findActiveMatchingLocalTerminalIncidents(body);
    const reusedIncident = matchingActiveIncidents[0] || null;
    const incidentResult = reusedIncident
      ? {
        ok: true,
        status: 200,
        ticketKey: reusedIncident.ticketKey,
        detail: "incident_reused_existing_open_ticket",
      }
      : await openIncidentTicket({
        title: incidentTitle,
        severity: "critical",
        payload: {
          origin: "local-terminal-health",
          client_id: body.clientId,
          chart: body.chart,
          runtime: body.runtime,
          local_feed: body.localFeed,
        },
      }).catch((error) => ({
        ok: false,
        status: 500,
        ticketKey: null,
        detail: error instanceof Error ? error.message : "incident_open_failed",
      }));

    autoIncident = {
      clientId: body.clientId,
      signature: incidentSignature,
      openedAt: body.capturedAt,
      ticketKey: incidentResult.ticketKey,
      title: incidentTitle,
      detail: incidentResult.detail,
      status: incidentResult.ok ? "opened" : "failed",
    };
    store = await writeLocalTerminalAutoIncident(autoIncident);
  }

  const healthyRecoveryReady = currentHistory.length >= AUTO_CLOSE_MIN_HEALTHY_FRAMES
    && currentHistory.slice(0, AUTO_CLOSE_MIN_HEALTHY_FRAMES).every((capture) => isDurablyHealthyCapture(capture));

  if (!body.runtime.blockedByFiveStateFailure
    && healthyRecoveryReady) {
    const matchingActiveIncidents = await findActiveMatchingLocalTerminalIncidents(body);
    const resolutionNote = `Auto-closed after ${AUTO_CLOSE_MIN_HEALTHY_FRAMES} healthy local captures for ${body.chart.feedLabel || `${body.chart.instrument} ${body.chart.timeframe}`}`;
    const closableIncident = autoIncident
      && autoIncident.status !== "closed"
      && autoIncident.status !== "suppressed"
      && autoIncident.ticketKey
      ? autoIncident
      : null;
    const ticketsToClose = new Set<string>([
      ...matchingActiveIncidents.map((incident) => incident.ticketKey),
      ...(closableIncident?.ticketKey ? [closableIncident.ticketKey] : []),
    ]);
    let closeFailed = false;
    for (const ticketKey of ticketsToClose) {
      const closeResult = await closeIncidentTicket(ticketKey, resolutionNote).catch((error) => ({
        ok: false,
        status: 500,
        detail: error instanceof Error ? error.message : "incident_close_failed",
      }));
      closeFailed = closeFailed || !closeResult.ok;
    }
    if (closableIncident) {
      autoIncident = {
        ...closableIncident,
        closedAt: body.capturedAt,
        detail: closeFailed ? "incident_close_failed" : "incident_closed_recovered_chart",
        status: closeFailed ? "close-failed" : "closed",
      };
      store = await writeLocalTerminalAutoIncident(autoIncident);
    }
  }

  const transitionEvents: Array<Promise<unknown>> = [];
  const transitionPayload = summarizeTransitionPayload(body, previousCapture, autoIncident?.ticketKey || null);
  if (body.localFeed.signal === "OHLCV_UNUSABLE" && previousCapture?.localFeed.signal !== "OHLCV_UNUSABLE") {
    transitionEvents.push(appendAuditEvent("local_terminal_ohlcv_unusable", transitionPayload).catch(() => undefined));
  }
  if (body.runtime.bars.state === "hard-fail" && previousCapture?.runtime.bars.state !== "hard-fail") {
    transitionEvents.push(appendAuditEvent("local_terminal_bars_hard_fail", transitionPayload).catch(() => undefined));
  }
  if (body.localFeed.signal === "OHLCV_RENDERABLE" && previousCapture && previousCapture.localFeed.signal !== "OHLCV_RENDERABLE") {
    transitionEvents.push(appendAuditEvent("local_terminal_ohlcv_renderable_recovered", transitionPayload).catch(() => undefined));
  }
  await Promise.all(transitionEvents);

  return noStoreJson({
    status: "ok",
    updated_at: store.updatedAt,
    latest_client_id: store.latestClientId,
    capture: getLocalTerminalCaptureByClientId(store, body.clientId),
    capture_history: getLocalTerminalCaptureHistory(store, body.clientId),
    auto_incident: autoIncident,
  }, 200);
}