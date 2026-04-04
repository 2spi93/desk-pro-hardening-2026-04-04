import { NextRequest, NextResponse } from "next/server";

import { cpFetch, readJsonFromResponseSafe } from "../../../../../../lib/controlPlane";

function csvToJsonRows(payload: string): Array<Record<string, string>> {
  const lines = payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(",").map((value) => value.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header || `col_${index + 1}`] = (values[index] || "").trim();
    });
    return row;
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const format = (request.nextUrl.searchParams.get("format") || "json").toLowerCase();
  const limit = request.nextUrl.searchParams.get("limit") || "1000";
  const symbol = request.nextUrl.searchParams.get("symbol") || "";
  const accountId = request.nextUrl.searchParams.get("account_id") || "";
  const fromTs = request.nextUrl.searchParams.get("from") || "";
  const toTs = request.nextUrl.searchParams.get("to") || "";

  const params = new URLSearchParams();
  params.set("format", format === "csv" ? "csv" : "json");
  params.set("limit", limit);
  if (symbol.trim()) {
    params.set("symbol", symbol.trim());
  }
  if (accountId.trim()) {
    params.set("account_id", accountId.trim());
  }
  if (fromTs.trim()) {
    params.set("from_ts", fromTs.trim());
  }
  if (toTs.trim()) {
    params.set("to_ts", toTs.trim());
  }

  try {
    const response = await cpFetch(`/v1/mt5/orders/risk-history/export?${params.toString()}`);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();

    if (format === "csv") {
      const payload = await response.text();
      return new NextResponse(payload, {
        status: response.status,
        headers: {
          "content-type": "text/csv; charset=utf-8",
        },
      });
    }

    if (contentType.includes("application/json")) {
      const payload = await readJsonFromResponseSafe(response);
      return NextResponse.json(payload, { status: response.status });
    }

    const fallbackParams = new URLSearchParams(params);
    fallbackParams.set("format", "csv");
    const fallbackResponse = await cpFetch(`/v1/mt5/orders/risk-history/export?${fallbackParams.toString()}`);
    const fallbackRawPayload = await fallbackResponse.text();
    const items = csvToJsonRows(fallbackRawPayload);

    if (fallbackResponse.ok) {
      return NextResponse.json(
        {
          status: "ok",
          format: "json-fallback-from-csv",
          items,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        status: "error",
        message: "upstream export unavailable",
        format: "json-fallback-from-csv",
        items,
      },
      { status: fallbackResponse.status }
    );
  } catch {
    return NextResponse.json({ status: "error", message: "unable to export risk history" }, { status: 500 });
  }
}
