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
type Top10Level = "critical" | "weak" | "normal" | "strong" | "unknown";

type SummaryReportBody = {
  project_id?: unknown;
  region_index?: unknown;
  date?: string;
  mode?: "mock" | "strict" | "latest_available" | "portfolio_latest" | "portfolio_insights";
  report_mode?: ReportMode;
  projects?: PortfolioProjectInput[];
};

type PortfolioProjectInput = {
  project_id?: unknown;
  region_index?: unknown;
};

type TopvisorConfig = {
  userId: string;
  apiKey: string;
};

type PortfolioItem = {
  ok: boolean;
  project_id: unknown;
  region_index: unknown;
  requested_date: string;
  report_mode?: ReportMode;
  actual_snapshot_date?: string;
  fallback_used?: boolean;
  fallback_days?: number;
  top10_abs?: number;
  keywords_all?: number;
  top10_pct?: number;
  error?: string;
};

type PortfolioFlags = {
  has_data: boolean;
  has_fresh_data: boolean;
  needs_attention: boolean;
  data_staleness_days: number | null;
  top10_level: Top10Level;
};

type PortfolioInsightItem = PortfolioItem & {
  flags: PortfolioFlags;
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

  if (body.mode === "portfolio_latest" || body.mode === "portfolio_insights") {
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

    const response = body.mode === "portfolio_insights"
      ? await buildPortfolioInsightsResponse(config, body)
      : await buildPortfolioLatestResponse(config, body);

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
    return "Invalid mode. Expected strict, latest_available, mock, portfolio_latest, or portfolio_insights";
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

  const items: PortfolioItem[] = [];

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

async function buildPortfolioInsightsResponse(config: TopvisorConfig, body: SummaryReportBody) {
  const latestResponse = await buildPortfolioLatestResponse(config, body);
  const insightItems = latestResponse.items
    .map((item) => addPortfolioFlags(item))
    .sort(compareInsightItems);

  const top10Values = insightItems
    .filter((item) => item.ok && Number.isFinite(Number(item.top10_pct)))
    .map((item) => Number(item.top10_pct));

  const avgTop10Pct = top10Values.length > 0
    ? roundTo(top10Values.reduce((sum, value) => sum + value, 0) / top10Values.length, 4)
    : null;

  const minTop10Pct = top10Values.length > 0 ? Math.min(...top10Values) : null;
  const maxTop10Pct = top10Values.length > 0 ? Math.max(...top10Values) : null;

  const itemsSuccess = insightItems.filter((item) => item.ok).length;
  const itemsFailed = insightItems.length - itemsSuccess;
  const itemsWithFallback = insightItems.filter((item) => item.ok && item.fallback_used === true).length;
  const itemsWithoutData = insightItems.filter((item) => !item.flags.has_data).length;
  const itemsNeedingAttention = insightItems.filter((item) => item.flags.needs_attention).length;

  return {
    ok: true,
    service: "ai-seo-analyst",
    scenario: "portfolio-insights",
    mode: "portfolio_insights",
    request: latestResponse.request,
    summary: {
      items_total: insightItems.length,
      items_success: itemsSuccess,
      items_failed: itemsFailed,
      avg_top10_pct: avgTop10Pct,
      min_top10_pct: minTop10Pct,
      max_top10_pct: maxTop10Pct,
      items_with_fallback: itemsWithFallback,
      items_without_data: itemsWithoutData,
      items_needing_attention: itemsNeedingAttention,
    },
    items: insightItems,
    warnings: [
      "This is a demo-MVP analytical layer. It identifies signals, not SEO causes.",
      ...latestResponse.warnings,
    ],
  };
}

function addPortfolioFlags(item: PortfolioItem): PortfolioInsightItem {
  const hasData = item.ok === true && Number(item.keywords_all) > 0;
  const dataStalenessDays = hasData
    ? item.fallback_used === true
      ? Number(item.fallback_days || 0)
      : 0
    : null;

  const hasFreshData = hasData && dataStalenessDays === 0;
  const top10Level = classifyTop10Level(hasData ? item.top10_pct : null);

  const needsAttention =
    item.ok === false ||
    !hasFreshData ||
    top10Level === "critical" ||
    top10Level === "weak";

  return {
    ...item,
    flags: {
      has_data: hasData,
      has_fresh_data: hasFreshData,
      needs_attention: needsAttention,
      data_staleness_days: dataStalenessDays,
      top10_level: top10Level,
    },
  };
}

function classifyTop10Level(value: unknown): Top10Level {
  if (value === null || value === undefined || value === "") {
    return "unknown";
  }

  const top10Pct = Number(value);

  if (!Number.isFinite(top10Pct)) {
    return "unknown";
  }

  if (top10Pct < 10) {
    return "critical";
  }

  if (top10Pct < 30) {
    return "weak";
  }

  if (top10Pct < 60) {
    return "normal";
  }

  return "strong";
}

function compareInsightItems(a: PortfolioInsightItem, b: PortfolioInsightItem): number {
  const aFailed = a.ok === false ? 1 : 0;
  const bFailed = b.ok === false ? 1 : 0;

  if (aFailed !== bFailed) {
    return bFailed - aFailed;
  }

  const aNeedsAttention = a.flags.needs_attention ? 1 : 0;
  const bNeedsAttention = b.flags.needs_attention ? 1 : 0;

  if (aNeedsAttention !== bNeedsAttention) {
    return bNeedsAttention - aNeedsAttention;
  }

  const aStaleness = a.flags.data_staleness_days ?? -1;
  const bStaleness = b.flags.data_staleness_days ?? -1;

  if (aStaleness !== bStaleness) {
    return bStaleness - aStaleness;
  }

  const aTop10 = Number.isFinite(Number(a.top10_pct)) ? Number(a.top10_pct) : Number.POSITIVE_INFINITY;
  const bTop10 = Number.isFinite(Number(b.top10_pct)) ? Number(b.top10_pct) : Number.POSITIVE_INFINITY;

  return aTop10 - bTop10;
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

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error || "Unknown error");
}

