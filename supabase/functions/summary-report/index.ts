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

type ReportMode = "strict" | "latest_available";

type SummaryReportBody = {
  project_id?: number;
  region_index?: number;
  date?: string;
  mode?: "mock" | "strict" | "latest_available" | "portfolio_latest";
  report_mode?: ReportMode;
  projects?: PortfolioProjectInput[];
};

type PortfolioProjectInput = {
  project_id?: number;
  region_index?: number;
};

type TopvisorConfig = {
  userId: string;
  apiKey: string;
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

  if (body.mode === "portfolio_latest") {
    const validationError = validatePortfolioBody(body);
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

    const config = getTopvisorConfig();
    if (!config) {
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

    const response = await buildPortfolioLatestResponse(config, body);

    return Response.json(response, {
      status: 200,
      headers: corsHeaders,
    });
  }

  const validationError = validateSingleBody(body);
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

  const config = getTopvisorConfig();
  if (!config) {
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
  const reportMode: ReportMode = body.mode === "strict" ? "strict" : "latest_available";

  try {
    const summaryResult = await findSummaryWithFallback({
      userId: config.userId,
      apiKey: config.apiKey,
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

function validateSingleBody(body: SummaryReportBody): string | null {
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
    return "Invalid mode. Expected strict, latest_available, mock, or portfolio_latest";
  }

  return null;
}

function validatePortfolioBody(body: SummaryReportBody): string | null {
  if (!body.date || !isValidYmd(String(body.date))) {
    return "Missing or invalid date. Expected YYYY-MM-DD";
  }

  if (body.report_mode && !["strict", "latest_available"].includes(body.report_mode)) {
    return "Invalid report_mode. Expected strict or latest_available";
  }

  if (!Array.isArray(body.projects)) {
    return "Missing or invalid projects. Expected array";
  }

  if (body.projects.length === 0) {
    return "Projects array must not be empty";
  }

  return null;
}

async function buildPortfolioLatestResponse(config: TopvisorConfig, body: SummaryReportBody) {
  const requestedDate = String(body.date);
  const reportMode: ReportMode = body.report_mode || "latest_available";
  const projects = body.projects || [];

  const items = [];

  for (const project of projects) {
    const projectId = Number(project.project_id);
    const regionIndex = Number(project.region_index);

    if (!Number.isFinite(projectId) || !Number.isFinite(regionIndex)) {
      items.push({
        ok: false,
        project_id: project.project_id ?? null,
        region_index: project.region_index ?? null,
        requested_date: requestedDate,
        error: "Missing or invalid project_id or region_index",
      });
      continue;
    }

    try {
      const summaryResult = await findSummaryWithFallback({
        userId: config.userId,
        apiKey: config.apiKey,
        projectId,
        regionIndex,
        requestedDate,
        reportMode,
        lookbackDays: DEFAULT_LOOKBACK_DAYS,
      });

      if (!summaryResult) {
        items.push({
          ok: false,
          project_id: projectId,
          region_index: regionIndex,
          requested_date: requestedDate,
          report_mode: reportMode,
          error: "No TopVisor summary data found in lookback window",
        });
        continue;
      }

      items.push({
        ok: true,
        project_id: projectId,
        region_index: regionIndex,
        requested_date: requestedDate,
        actual_snapshot_date: summaryResult.metrics.actual_snapshot_date,
        fallback_used: summaryResult.fallback_used,
        fallback_days: summaryResult.fallback_days,
        top10_abs: summaryResult.metrics.top10_abs,
        keywords_all: summaryResult.metrics.keywords_all,
        top10_pct: summaryResult.metrics.top10_pct,
      });
    } catch (error) {
      items.push({
        ok: false,
        project_id: projectId,
        region_index: regionIndex,
        requested_date: requestedDate,
        report_mode: reportMode,
        error: normalizeErrorMessage(error),
      });
    }
  }

  const itemsSuccess = items.filter((item) => item.ok).length;
  const itemsFailed = items.length - itemsSuccess;

  const warnings: string[] = [];

  if (reportMode === "latest_available") {
    warnings.push("Some items may use nearest available previous snapshot if requested date had no data.");
  }

  if (itemsFailed > 0) {
    warnings.push("Some portfolio items failed. See item-level errors.");
  }

  return {
    ok: true,
    service: "ai-seo-analyst",
    scenario: "portfolio-summary",
    mode: "portfolio_latest",
    request: {
      requested_date: requestedDate,
      report_mode: reportMode,
      projects_count: projects.length,
    },
    summary: {
      items_total: items.length,
      items_success: itemsSuccess,
      items_failed: itemsFailed,
    },
    items,
    warnings,
  };
}

function getTopvisorConfig(): TopvisorConfig | null {
  const userId = Deno.env.get("TOPVISOR_USER_ID");
  const apiKey = Deno.env.get("TOPVISOR_API_KEY");

  if (!userId || !apiKey) {
    return null;
  }

  return { userId, apiKey };
}

async function findSummaryWithFallback(params: {
  userId: string;
  apiKey: string;
  projectId: number;
  regionIndex: number;
  requestedDate: string;
  reportMode: ReportMode;
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
