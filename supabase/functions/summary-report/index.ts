import {
  extractSummaryMetrics,
  fetchTopvisorSummaryForDate,
} from "../_shared/topvisor-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-demo-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DEFAULT_LOOKBACK_DAYS = 14;

type SummaryReportBody = {
  project_id?: number;
  region_index?: number;
  date?: string;
  mode?: "mock" | "strict" | "latest_available";
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  const demoToken = Deno.env.get("DEMO_TOKEN");
  const requestToken = req.headers.get("x-demo-token");

  if (!demoToken || requestToken !== demoToken) {
    return Response.json(
      {
        ok: false,
        error: "Unauthorized",
      },
      {
        status: 401,
        headers: corsHeaders,
      },
    );
  }

  let body: SummaryReportBody = {};

  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return Response.json(
        {
          ok: false,
          error: "Invalid JSON body",
        },
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }
  }

  if (body.mode === "mock" || req.method === "GET") {
    return Response.json(
      {
        ok: true,
        service: "ai-seo-analyst",
        scenario: "summary-report",
        mode: "mock",
        message: "Supabase backend core is working",
      },
      {
        status: 200,
        headers: corsHeaders,
      },
    );
  }

  const validationError = validateBody(body);
  if (validationError) {
    return Response.json(
      {
        ok: false,
        error: validationError,
      },
      {
        status: 400,
        headers: corsHeaders,
      },
    );
  }

  const userId = Deno.env.get("TOPVISOR_USER_ID");
  const apiKey = Deno.env.get("TOPVISOR_API_KEY");

  if (!userId || !apiKey) {
    return Response.json(
      {
        ok: false,
        error: "TopVisor credentials are not configured",
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }

  const projectId = Number(body.project_id);
  const regionIndex = Number(body.region_index);
  const requestedDate = String(body.date);
  const reportMode = body.mode || "latest_available";

  try {
    const summaryResult = await findSummaryWithFallback({
      userId,
      apiKey,
      projectId,
      regionIndex,
      requestedDate,
      reportMode,
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
    });

    if (!summaryResult) {
      return Response.json(
        {
          ok: false,
          error: "No TopVisor summary data found in lookback window",
          request: {
            project_id: projectId,
            region_index: regionIndex,
            requested_date: requestedDate,
            report_mode: reportMode,
          },
        },
        {
          status: 404,
          headers: corsHeaders,
        },
      );
    }

    const warnings: string[] = [];

    if (summaryResult.fallback_used) {
      warnings.push("Requested date had no data. Used nearest available previous snapshot.");
    }

    return Response.json(
      {
        ok: true,
        service: "ai-seo-analyst",
        scenario: "summary-report",
        mode: "real",
        request: {
          project_id: projectId,
          region_index: regionIndex,
          requested_date: requestedDate,
          report_mode: reportMode,
        },
        data: {
          actual_snapshot_date: summaryResult.metrics.actual_snapshot_date,
          fallback_used: summaryResult.fallback_used,
          fallback_days: summaryResult.fallback_days,
          top10_abs: summaryResult.metrics.top10_abs,
          keywords_all: summaryResult.metrics.keywords_all,
          top10_pct: summaryResult.metrics.top10_pct,
        },
        warnings,
      },
      {
        status: 200,
        headers: corsHeaders,
      },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: normalizeErrorMessage(error),
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
});

function validateBody(body: SummaryReportBody): string | null {
  if (!Number.isFinite(Number(body.project_id))) {
    return "Missing or invalid project_id";
  }

  if (!Number.isFinite(Number(body.region_index))) {
    return "Missing or invalid region_index";
  }

  if (!body.date || !isValidYmd(String(body.date))) {
    return "Missing or invalid date. Expected YYYY-MM-DD";
  }

  if (body.mode && !["strict", "latest_available", "mock"].includes(body.mode)) {
    return "Invalid mode. Expected strict, latest_available, or mock";
  }

  return null;
}

async function findSummaryWithFallback(params: {
  userId: string;
  apiKey: string;
  projectId: number;
  regionIndex: number;
  requestedDate: string;
  reportMode: "strict" | "latest_available" | "mock";
  lookbackDays: number;
}) {
  const maxFallbackDays = params.reportMode === "strict" ? 0 : params.lookbackDays;

  for (let fallbackDays = 0; fallbackDays <= maxFallbackDays; fallbackDays += 1) {
    const currentDate = addDaysYmd(params.requestedDate, -fallbackDays);

    const summary = await fetchTopvisorSummaryForDate(
      {
        userId: params.userId,
        apiKey: params.apiKey,
      },
      {
        project_id: params.projectId,
        region_index: params.regionIndex,
        date: currentDate,
      },
    );

    const metrics = extractSummaryMetrics(summary, currentDate);

    if (metrics) {
      return {
        metrics,
        fallback_used: fallbackDays > 0,
        fallback_days: fallbackDays,
      };
    }
  }

  return null;
}

function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && value === date.toISOString().slice(0, 10);
}

function addDaysYmd(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error || "Unknown error");
}
