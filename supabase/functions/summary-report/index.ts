import {
  extractSummaryMetrics,
  fetchTopvisorProjects,
  fetchTopvisorSummaryForDate,
  type TopvisorProjectMetadata,
} from "../_shared/topvisor-client.ts";
import { buildPortfolioMarkdownReport } from "../_shared/report-writer.ts";
import { readTopvisorScopeCache, writeTopvisorScopeCache, type ScopeCacheStatus } from "../_shared/scope-cache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-demo-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DEFAULT_LOOKBACK_DAYS = 14;

type ReportMode = "strict" | "latest_available";
type ReportFocus = "overview" | "problem_projects" | "stale_data_projects" | "critical_top10_projects" | "attention_queue";
type Top10Level = "critical" | "weak" | "normal" | "strong" | "unknown";

type SummaryReportBody = {
  project_id?: unknown;
  region_index?: unknown;
  date?: string;
  mode?: "mock" | "strict" | "latest_available" | "portfolio_latest" | "portfolio_insights" | "portfolio_report" | "portfolio_report_auto" | "portfolio_snapshot_build";
  report_mode?: ReportMode;
  report_focus?: unknown;
  force_refresh_scope?: unknown;
  batch_size?: unknown;
  cursor?: unknown;
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
  project_name?: string | null;
  site?: string | null;
  display_name?: string;
  region_index: unknown;
  region_name?: string;
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

type PortfolioScopeCacheState = {
  enabled: boolean;
  status: ScopeCacheStatus;
  cache_key: string;
  cache_date: string;
  expires_at: string | null;
};

type PortfolioGroupItem = {
  project_id: unknown;
  display_name: string;
  site?: string | null;
  region_index: unknown;
  region_name?: string;
  top10_pct?: number | null;
  actual_snapshot_date?: string | null;
  fallback_used?: boolean;
  fallback_days?: number | null;
};

type PortfolioGroups = {
  top10_above_50: PortfolioGroupItem[];
  top10_20_50: PortfolioGroupItem[];
  top10_10_20: PortfolioGroupItem[];
  top10_below_10: PortfolioGroupItem[];
  stale_or_missing_data: PortfolioGroupItem[];
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

  if (body.mode === "portfolio_latest" || body.mode === "portfolio_insights" || body.mode === "portfolio_report" || body.mode === "portfolio_report_auto" || body.mode === "portfolio_snapshot_build") {
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

    let response;

    try {
      response = body.mode === "portfolio_snapshot_build"
        ? await buildPortfolioSnapshotBuildResponse(config, body)
        : body.mode === "portfolio_report_auto"
          ? await buildPortfolioAutoReportResponse(config, body)
          : body.mode === "portfolio_report"
            ? await buildPortfolioReportResponse(config, body)
            : body.mode === "portfolio_insights"
              ? await buildPortfolioInsightsResponse(config, body)
              : await buildPortfolioLatestResponse(config, body);
    } catch (error) {
      return Response.json({ ok: false, error: normalizeErrorMessage(error) }, { status: 500, headers: corsHeaders });
    }

    const responseBody = JSON.stringify(response);

    return new Response(responseBody, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(responseBody).length),
        "Connection": "close",
      },
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
    return "Invalid mode. Expected strict, latest_available, mock, portfolio_latest, portfolio_insights, portfolio_report, portfolio_report_auto, or portfolio_snapshot_build";
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

  if (body.mode === "portfolio_report_auto" || body.mode === "portfolio_snapshot_build") {
    return null;
  }

  if (!Array.isArray(body.projects)) {
    return "Missing or invalid projects. Expected array";
  }

  if (body.projects.length === 0) {
    return "Projects array must not be empty";
  }

  return null;
}

export function normalizeReportFocus(value: unknown): ReportFocus {
  if (value === "problem_projects" || value === "stale_data_projects" || value === "critical_top10_projects" || value === "attention_queue") {
    return value;
  }

  return "overview";
}

export function buildAutoPortfolioProjects(projects: TopvisorProjectMetadata[]) {
  const generatedProjects: PortfolioProjectInput[] = [];
  let skippedProjectsCount = 0;
  const warnings: string[] = [];

  for (const project of projects) {
    const usableRegions = (project.regions || []).filter((region) => Number.isFinite(Number(region.region_index)) && !!region.region_name);

    if (usableRegions.length === 0) {
      skippedProjectsCount += 1;
      continue;
    }

    for (const region of usableRegions) {
      generatedProjects.push({
        project_id: project.project_id,
        region_index: region.region_index,
      });
    }
  }

  if (skippedProjectsCount > 0) {
    warnings.push(`Skipped ${skippedProjectsCount} project(s) without usable region metadata.`);
  }

  if (generatedProjects.length === 0) {
    warnings.push("No usable project-region pairs were generated from Topvisor metadata.");
  }

  return {
    projects: generatedProjects,
    skippedProjectsCount,
    warnings,
    projectsCount: projects.length,
  };
}

async function buildPortfolioAutoReportResponse(config: TopvisorConfig, body: SummaryReportBody) {
  const requestedDate = String(body.date);
  const reportMode: ReportMode = body.report_mode || "latest_available";
  const reportFocus = normalizeReportFocus(body.report_focus);
  const snapshotCacheKey = `daily_portfolio_snapshot:${requestedDate}:${reportMode}`;
  const snapshotCacheDate = requestedDate;

  const snapshotCacheResult = await readTopvisorScopeCache({
    cacheKey: snapshotCacheKey,
    cacheDate: snapshotCacheDate,
  });

  if (snapshotCacheResult.entry && snapshotCacheResult.available) {
    const snapshotPayload = snapshotCacheResult.entry.payload as Record<string, unknown>;
    const reportPayload = {
      request: {
        requested_date: requestedDate,
        report_mode: reportMode,
        report_focus: reportFocus,
        projects_count: Number(snapshotPayload.scope_metadata?.project_region_pairs_total ?? 0),
      },
      summary: snapshotPayload.summary,
      scenario_blocks: snapshotPayload.scenario_blocks,
      portfolio_groups: snapshotPayload.portfolio_groups,
      warnings: snapshotPayload.warnings,
      scope_metadata: snapshotPayload.scope_metadata,
    };
    const reportResult = await buildPortfolioMarkdownReport(reportPayload, reportFocus);

    return {
      ok: true,
      service: "ai-seo-analyst",
      scenario: "portfolio-report-auto",
      mode: "portfolio_report_auto",
      report_focus: reportFocus,
      report_source: "cached_snapshot",
      snapshot_cache: {
        enabled: true,
        status: "hit" as ScopeCacheStatus,
        cache_key: snapshotCacheKey,
        cache_date: snapshotCacheDate,
        expires_at: snapshotCacheResult.entry.expires_at,
      },
      scope_cache: {
        enabled: true,
        status: (snapshotPayload.scope_metadata?.scope_cache_status as ScopeCacheStatus) || "unavailable_live_fallback",
        cache_key: (snapshotPayload.scope_metadata?.scope_cache_key as string) || "daily_project_scope",
        cache_date: (snapshotPayload.scope_metadata?.scope_cache_date as string) || requestedDate,
        expires_at: (snapshotPayload.scope_metadata?.scope_cache_expires_at as string) || null,
      },
      request: reportPayload.request,
      summary: snapshotPayload.summary,
      report: reportResult.report,
      llm: reportResult.llm,
      warnings: reportResult.warnings,
      auto_scope: {
        source: "daily_project_scope",
        projects_total: Number(snapshotPayload.scope_metadata?.projects_total ?? 0),
        project_region_pairs_total: Number(snapshotPayload.scope_metadata?.project_region_pairs_total ?? 0),
        project_region_pairs_processed: Number(snapshotPayload.scope_metadata?.project_region_pairs_processed ?? 0),
        items_success: Number(snapshotPayload.summary?.items_success ?? 0),
        items_failed: Number(snapshotPayload.summary?.items_failed ?? 0),
        items_without_data: Number(snapshotPayload.summary?.items_without_data ?? 0),
      },
      portfolio_groups: snapshotPayload.portfolio_groups,
    };
  }

  const buildCacheKey = `daily_portfolio_snapshot_build:${requestedDate}:${reportMode}`;
  const buildCacheResult = await readTopvisorScopeCache({
    cacheKey: buildCacheKey,
    cacheDate: snapshotCacheDate,
  });
  const partialState = buildCacheResult.entry?.payload as Record<string, unknown> | undefined;
  const progress = partialState ? {
    processed: Number(partialState.processed ?? 0),
    total: Number(partialState.total ?? 0),
    cursor: Number(partialState.cursor ?? 0),
    next_cursor: partialState.done ? null : Number(partialState.cursor ?? 0),
    done: Boolean(partialState.done),
  } : null;

  return {
    ok: true,
    mode: "portfolio_report_auto",
    status: "snapshot_not_ready",
    next_action: "run portfolio_snapshot_build",
    report_focus: reportFocus,
    snapshot_cache: {
      enabled: true,
      status: "miss",
      cache_key: snapshotCacheKey,
      cache_date: snapshotCacheDate,
      expires_at: null,
    },
    build_payload_example: {
      mode: "portfolio_snapshot_build",
      date: requestedDate,
      report_mode: reportMode,
      batch_size: 5,
      cursor: 0,
      force_refresh_scope: false,
    },
    ...(progress ? { build_progress: progress } : {}),
  };
}

async function buildPortfolioSnapshotBuildResponse(config: TopvisorConfig, body: SummaryReportBody) {
  const requestedDate = String(body.date);
  const reportMode: ReportMode = body.report_mode || "latest_available";
  const reportFocus = normalizeReportFocus(body.report_focus);
  const forceRefreshScope = Boolean(body.force_refresh_scope);
  const batchSize = clampBatchSize(body.batch_size);
  const cursor = normalizeCursor(body.cursor);
  const snapshotCacheKey = `daily_portfolio_snapshot:${requestedDate}:${reportMode}`;
  const buildCacheKey = `daily_portfolio_snapshot_build:${requestedDate}:${reportMode}`;
  const cacheDate = requestedDate;

  const scopeCacheResult = await getDailyProjectScope(config, { forceRefresh: forceRefreshScope });
  const autoPortfolioProjects = buildAutoPortfolioProjects(scopeCacheResult.projects);
  const total = autoPortfolioProjects.projects.length;
  const start = Math.min(cursor, total);
  const end = Math.min(total, start + batchSize);
  const batchProjects = autoPortfolioProjects.projects.slice(start, end);

  let mergedItems: PortfolioInsightItem[] = [];
  let mergedWarnings: string[] = [];
  let processed = 0;
  let done = total === 0;
  let partialState = undefined as Record<string, unknown> | undefined;
  const shouldResetBuildState = forceRefreshScope && cursor === 0;

  const buildCacheResult = await readTopvisorScopeCache({
    cacheKey: buildCacheKey,
    cacheDate,
  });

  if (buildCacheResult.entry && buildCacheResult.available && !shouldResetBuildState) {
    partialState = buildCacheResult.entry.payload as Record<string, unknown>;
    mergedItems = Array.isArray(partialState.items) ? partialState.items as PortfolioInsightItem[] : [];
    mergedWarnings = Array.isArray(partialState.warnings) ? partialState.warnings as string[] : [];
    processed = Number(partialState.processed ?? 0);
    done = Boolean(partialState.done);
  }

  if (batchProjects.length > 0 && !done) {
    const batchBody: SummaryReportBody = {
      ...body,
      projects: batchProjects,
    };
    const batchInsights = await buildPortfolioInsightsResponse(config, batchBody);
    mergedItems = [...mergedItems, ...batchInsights.items];
    mergedWarnings = [...mergedWarnings, ...batchInsights.warnings];
    processed = Math.max(processed, end);
    done = end >= total;
  } else if (!done && total === 0) {
    done = true;
  }

  const nextCursor = done ? total : end;
  const finalScopeMetadata = {
    scope_cache_status: scopeCacheResult.status,
    scope_cache_key: scopeCacheResult.cacheKey,
    scope_cache_date: scopeCacheResult.cacheDate,
    scope_cache_expires_at: scopeCacheResult.expiresAt,
    projects_total: autoPortfolioProjects.projectsCount,
    project_region_pairs_total: autoPortfolioProjects.projects.length,
    project_region_pairs_processed: processed,
    items_success: 0,
    items_failed: 0,
    items_without_data: 0,
  };

  const partialPayload = {
    items: mergedItems,
    warnings: mergedWarnings,
    cursor: nextCursor,
    processed,
    total,
    done,
    scope_metadata: finalScopeMetadata,
  };

  await writeTopvisorScopeCache({
    cacheKey: buildCacheKey,
    cacheDate,
    payload: partialPayload,
  });

  if (done) {
    const finalItems = mergedItems.map((item) => addPortfolioFlags(item));
    const finalSummary = buildPortfolioInsightsSummary(finalItems);
    const finalPayload = {
      items: finalItems,
      summary: finalSummary,
      scenario_blocks: buildScenarioBlocks(finalItems, finalSummary),
      portfolio_groups: buildPortfolioGroups(finalItems),
      warnings: mergedWarnings,
      scope_metadata: {
        ...finalScopeMetadata,
        items_success: finalSummary.items_success,
        items_failed: finalSummary.items_failed,
        items_without_data: finalSummary.items_without_data,
      },
    };

    await writeTopvisorScopeCache({
      cacheKey: snapshotCacheKey,
      cacheDate,
      payload: finalPayload,
    });

    return {
      ok: true,
      mode: "portfolio_snapshot_build",
      status: "snapshot_ready",
      report_focus: reportFocus,
      processed,
      total,
      cursor: start,
      next_cursor: null,
      done: true,
      batch_size: batchSize,
      batch_processed: batchProjects.length,
      snapshot_cache: {
        enabled: true,
        status: "miss_refreshed",
        cache_key: snapshotCacheKey,
        cache_date: cacheDate,
        expires_at: null,
      },
      scope_cache: {
        enabled: true,
        status: scopeCacheResult.status,
        cache_key: scopeCacheResult.cacheKey,
        cache_date: scopeCacheResult.cacheDate,
        expires_at: scopeCacheResult.expiresAt,
      },
    };
  }

  return {
    ok: true,
    mode: "portfolio_snapshot_build",
    status: "snapshot_building",
    report_focus: reportFocus,
    processed,
    total,
    cursor: start,
    next_cursor: nextCursor,
    done: false,
    batch_size: batchSize,
    batch_processed: batchProjects.length,
    snapshot_cache: {
      enabled: true,
      status: "miss",
      cache_key: buildCacheKey,
      cache_date: cacheDate,
      expires_at: null,
    },
    scope_cache: {
      enabled: true,
      status: scopeCacheResult.status,
      cache_key: scopeCacheResult.cacheKey,
      cache_date: scopeCacheResult.cacheDate,
      expires_at: scopeCacheResult.expiresAt,
    },
  };
}

async function buildPortfolioReportResponse(config: TopvisorConfig, body: SummaryReportBody) {
  const reportFocus = normalizeReportFocus(body.report_focus);
  const insightsResponse = await buildPortfolioInsightsResponse(config, body);

  const reportResult = await buildPortfolioMarkdownReport({
    request: {
      ...insightsResponse.request,
      report_focus: reportFocus,
    },
    summary: insightsResponse.summary,
    scenario_blocks: insightsResponse.scenario_blocks,
    warnings: insightsResponse.warnings,
  }, reportFocus);

  return {
    ok: true,
    service: "ai-seo-analyst",
    scenario: "portfolio-report",
    mode: "portfolio_report",
    request: {
      ...insightsResponse.request,
      report_focus: reportFocus,
    },
    summary: insightsResponse.summary,
    report: reportResult.report,
    llm: reportResult.llm,
    warnings: reportResult.warnings,
  };
}

async function buildPortfolioLatestResponse(config: TopvisorConfig, body: SummaryReportBody) {
  const requestedDate = String(body.date);
  const reportMode: ReportMode = body.report_mode || "latest_available";
  const projects = body.projects || [];
  const metadataLoadResult = await loadProjectMetadataMap(config);
  const metadataByProjectId = metadataLoadResult.metadataByProjectId;

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

  const enrichedItems = items.map((item) => addProjectMetadataToItem(item, metadataByProjectId));
  const itemsSuccess = enrichedItems.filter((item) => item.ok).length;
  const itemsFailed = enrichedItems.length - itemsSuccess;

  const warnings: string[] = [];

  if (reportMode === "latest_available") {
    warnings.push("Some items may use nearest available previous snapshot if requested date had no data.");
  }

  if (itemsFailed > 0) {
    warnings.push("Some portfolio items failed. See item-level errors.");
  }

  if (metadataLoadResult.warning) {
    warnings.push(metadataLoadResult.warning);
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
      items_total: enrichedItems.length,
      items_success: itemsSuccess,
      items_failed: itemsFailed,
    },
    items: enrichedItems,
    warnings,
  };
}

async function buildPortfolioInsightsResponse(config: TopvisorConfig, body: SummaryReportBody) {
  const latestResponse = await buildPortfolioLatestResponse(config, body);
  const insightItems = latestResponse.items
    .map((item) => addPortfolioFlags(item))
    .sort(compareInsightItems);

  const insightsSummary = buildPortfolioInsightsSummary(insightItems);

  return {
    ok: true,
    service: "ai-seo-analyst",
    scenario: "portfolio-insights",
    mode: "portfolio_insights",
    request: latestResponse.request,
    summary: insightsSummary,
    scenario_blocks: buildScenarioBlocks(insightItems, insightsSummary),
    items: insightItems,
    warnings: [
      "This is a demo-MVP analytical layer. It identifies signals, not SEO causes.",
      "Scenario blocks are based on simple MVP heuristics and do not explain SEO causes.",
      ...latestResponse.warnings,
    ],
  };
}

async function loadProjectMetadataMap(config: TopvisorConfig): Promise<{
  metadataByProjectId: Map<number, TopvisorProjectMetadata>;
  warning: string | null;
}> {
  try {
    const projects = await fetchTopvisorProjects({
      userId: config.userId,
      apiKey: config.apiKey,
    });

    return {
      metadataByProjectId: new Map(projects.map((project) => [project.project_id, project])),
      warning: null,
    };
  } catch {
    return {
      metadataByProjectId: new Map(),
      warning: "Project metadata could not be loaded. Using project_id as display name.",
    };
  }
}

async function getDailyProjectScope(config: TopvisorConfig, options: { forceRefresh?: boolean }) {
  const cacheDate = new Date().toISOString().slice(0, 10);
  const cacheKey = "daily_project_scope";
  const forceRefresh = Boolean(options.forceRefresh);

  if (!forceRefresh) {
    const cacheResult = await readTopvisorScopeCache({ cacheKey, cacheDate });
    if (cacheResult.entry && cacheResult.available) {
      const payload = cacheResult.entry.payload as { projects?: TopvisorProjectMetadata[] };
      return {
        projects: Array.isArray(payload.projects) ? payload.projects : [],
        status: "hit" as ScopeCacheStatus,
        cacheKey,
        cacheDate,
        expiresAt: cacheResult.entry.expires_at,
        warnings: cacheResult.warning ? [cacheResult.warning] : [],
      };
    }
  }

  const metadataLoadResult = await loadProjectMetadataMap(config);
  const projects = Array.from(metadataLoadResult.metadataByProjectId.values());
  const normalizedProjects = projects.map((project) => ({
    ...project,
    regions: (project.regions || []).filter((region) => Number.isFinite(Number(region.region_index)) && !!region.region_name),
  }));
  const payload = { projects: normalizedProjects };

  const writeResult = await writeTopvisorScopeCache({ cacheKey, cacheDate, payload });
  const warnings = [
    ...(metadataLoadResult.warning ? [metadataLoadResult.warning] : []),
    ...(writeResult.warning ? [writeResult.warning] : []),
  ];

  return {
    projects: normalizedProjects,
    status: writeResult.ok ? "miss_refreshed" as ScopeCacheStatus : "unavailable_live_fallback",
    cacheKey,
    cacheDate,
    expiresAt: writeResult.expiresAt,
    warnings,
  };
}

function getProjectMetadata(
  projectId: unknown,
  metadataByProjectId: Map<number, TopvisorProjectMetadata>,
): TopvisorProjectMetadata {
  const numericProjectId = Number(projectId);

  if (Number.isFinite(numericProjectId)) {
    const metadata = metadataByProjectId.get(numericProjectId);

    if (metadata) {
      return metadata;
    }
  }

  const fallbackProjectId = String(projectId ?? "unknown");

  return {
    project_id: Number.isFinite(numericProjectId) ? numericProjectId : 0,
    project_name: null,
    site: null,
    display_name: `Project ${fallbackProjectId}`,
    regions: [],
  };
}
function getRegionName(regionIndex: unknown, metadata: TopvisorProjectMetadata): string {
  const numericRegionIndex = Number(regionIndex);

  if (Number.isFinite(numericRegionIndex)) {
    const region = metadata.regions.find((item) => item.region_index === numericRegionIndex);

    if (region) {
      return region.region_name;
    }
  }

  return `Region ${String(regionIndex ?? "unknown")}`;
}

function addProjectMetadataToItem(
  item: PortfolioItem,
  metadataByProjectId: Map<number, TopvisorProjectMetadata>,
): PortfolioItem {
  const metadata = getProjectMetadata(item.project_id, metadataByProjectId);

  return {
    ...item,
    project_name: metadata.project_name,
    site: metadata.site,
    display_name: metadata.display_name,
    region_name: getRegionName(item.region_index, metadata),
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

function buildPortfolioInsightsSummary(items: PortfolioInsightItem[]) {
  const top10Values = items
    .filter((item) => item.ok && Number.isFinite(Number(item.top10_pct)))
    .map((item) => Number(item.top10_pct));

  const avgTop10Pct = top10Values.length > 0
    ? roundTo(top10Values.reduce((sum, value) => sum + value, 0) / top10Values.length, 4)
    : null;

  const minTop10Pct = top10Values.length > 0 ? Math.min(...top10Values) : null;
  const maxTop10Pct = top10Values.length > 0 ? Math.max(...top10Values) : null;

  const itemsSuccess = items.filter((item) => item.ok).length;
  const itemsFailed = items.length - itemsSuccess;
  const itemsWithFallback = items.filter((item) => item.ok && item.fallback_used === true).length;
  const itemsWithoutData = items.filter((item) => !item.flags.has_data).length;
  const itemsNeedingAttention = items.filter((item) => item.flags.needs_attention).length;

  return {
    items_total: items.length,
    items_success: itemsSuccess,
    items_failed: itemsFailed,
    avg_top10_pct: avgTop10Pct,
    min_top10_pct: minTop10Pct,
    max_top10_pct: maxTop10Pct,
    items_with_fallback: itemsWithFallback,
    items_without_data: itemsWithoutData,
    items_needing_attention: itemsNeedingAttention,
  };
}

function buildScenarioBlocks(items: PortfolioInsightItem[], summary: {
  items_total: number;
  items_success: number;
  items_failed: number;
  avg_top10_pct: number | null;
  min_top10_pct: number | null;
  max_top10_pct: number | null;
  items_with_fallback: number;
  items_without_data: number;
  items_needing_attention: number;
}) {
  return {
    portfolio_health_summary: buildPortfolioHealthSummary(items, summary),
    problem_projects: items
      .filter((item) => item.flags.needs_attention)
      .sort(compareProblemProjects)
      .slice(0, 5)
      .map(toScenarioBlockItem),
    stale_data_projects: items
      .filter((item) => !item.flags.has_fresh_data)
      .sort(compareStaleDataProjects)
      .slice(0, 5)
      .map(toScenarioBlockItem),
    critical_top10_projects: items
      .filter((item) => item.ok && item.flags.top10_level === "critical")
      .sort((a, b) => Number(a.top10_pct) - Number(b.top10_pct))
      .slice(0, 5)
      .map(toScenarioBlockItem),
    attention_queue: items
      .filter((item) => item.flags.needs_attention)
      .sort(compareProblemProjects)
      .slice(0, 10)
      .map(toScenarioBlockItem),
  };
}

function buildPortfolioHealthSummary(items: PortfolioInsightItem[], summary: {
  items_total: number;
  items_success: number;
  items_failed: number;
  avg_top10_pct: number | null;
  items_with_fallback: number;
  items_without_data: number;
  items_needing_attention: number;
}) {
  const criticalTop10Count = items.filter((item) => item.flags.top10_level === "critical").length;

  let status = "stable";

  if (summary.items_success === 0) {
    status = "unknown";
  } else if (summary.items_failed > 0 || (summary.avg_top10_pct !== null && summary.avg_top10_pct < 10)) {
    status = "critical";
  } else if (summary.items_needing_attention > 0) {
    status = "attention_required";
  }

  const shortSignals: string[] = [];

  if (summary.items_without_data > 0) {
    shortSignals.push(`${summary.items_without_data} project has no valid data.`);
  }

  if (summary.items_with_fallback > 0) {
    shortSignals.push(`${summary.items_with_fallback} project used fallback data.`);
  }

  if (criticalTop10Count > 0) {
    shortSignals.push(`${criticalTop10Count} project has critical TOP-10 level.`);
  }

  if (shortSignals.length === 0) {
    shortSignals.push("No critical MVP signals detected.");
  }

  return {
    status,
    items_total: summary.items_total,
    items_success: summary.items_success,
    items_failed: summary.items_failed,
    avg_top10_pct: summary.avg_top10_pct,
    items_needing_attention: summary.items_needing_attention,
    items_without_data: summary.items_without_data,
    items_with_fallback: summary.items_with_fallback,
    short_signals: shortSignals,
  };
}

function toScenarioBlockItem(item: PortfolioInsightItem) {
  return {
    project_id: item.project_id,
    project_name: item.project_name ?? null,
    site: item.site ?? null,
    display_name: item.display_name ?? `Project ${String(item.project_id ?? "unknown")}`,
    region_index: item.region_index,
    region_name: item.region_name ?? `Region ${String(item.region_index ?? "unknown")}`,
    ok: item.ok,
    error: item.error,
    top10_pct: item.top10_pct ?? null,
    top10_level: item.flags.top10_level,
    has_fresh_data: item.flags.has_fresh_data,
    data_staleness_days: item.flags.data_staleness_days,
    actual_snapshot_date: item.actual_snapshot_date ?? null,
    attention_reasons: buildAttentionReasons(item),
  };
}

function buildAttentionReasons(item: PortfolioInsightItem): string[] {
  const reasons: string[] = [];

  if (!item.flags.has_data) {
    reasons.push("no_data");
  }

  if (!item.flags.has_fresh_data && item.flags.has_data) {
    reasons.push("stale_data");
  }

  if (item.flags.top10_level === "critical") {
    reasons.push("critical_top10");
  }

  if (item.flags.top10_level === "weak") {
    reasons.push("weak_top10");
  }

  return reasons;
}

function compareProblemProjects(a: PortfolioInsightItem, b: PortfolioInsightItem): number {
  const aFailed = a.ok === false ? 1 : 0;
  const bFailed = b.ok === false ? 1 : 0;

  if (aFailed !== bFailed) {
    return bFailed - aFailed;
  }

  const levelRank: Record<Top10Level, number> = {
    critical: 4,
    weak: 3,
    normal: 2,
    strong: 1,
    unknown: 0,
  };

  const aRank = levelRank[a.flags.top10_level];
  const bRank = levelRank[b.flags.top10_level];

  if (aRank !== bRank) {
    return bRank - aRank;
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

function compareStaleDataProjects(a: PortfolioInsightItem, b: PortfolioInsightItem): number {
  const aFailed = a.ok === false ? 1 : 0;
  const bFailed = b.ok === false ? 1 : 0;

  if (aFailed !== bFailed) {
    return bFailed - aFailed;
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

function buildPortfolioGroups(items: PortfolioInsightItem[]): PortfolioGroups {
  const groups: PortfolioGroups = {
    top10_above_50: [],
    top10_20_50: [],
    top10_10_20: [],
    top10_below_10: [],
    stale_or_missing_data: [],
  };

  for (const item of items) {
    if (!item.ok || !Number.isFinite(Number(item.top10_pct)) || !item.flags.has_data) {
      groups.stale_or_missing_data.push(toPortfolioGroupItem(item));
      continue;
    }

    const top10Pct = Number(item.top10_pct);
    if (top10Pct >= 50) {
      groups.top10_above_50.push(toPortfolioGroupItem(item));
    } else if (top10Pct >= 20) {
      groups.top10_20_50.push(toPortfolioGroupItem(item));
    } else if (top10Pct >= 10) {
      groups.top10_10_20.push(toPortfolioGroupItem(item));
    } else {
      groups.top10_below_10.push(toPortfolioGroupItem(item));
    }
  }

  return groups;
}

function toPortfolioGroupItem(item: PortfolioInsightItem): PortfolioGroupItem {
  return {
    project_id: item.project_id,
    display_name: item.display_name ?? `Project ${String(item.project_id ?? "unknown")}`,
    site: item.site ?? null,
    region_index: item.region_index,
    region_name: item.region_name ?? `Region ${String(item.region_index ?? "unknown")}`,
    top10_pct: Number.isFinite(Number(item.top10_pct)) ? Number(item.top10_pct) : null,
    actual_snapshot_date: item.actual_snapshot_date ?? null,
    fallback_used: item.fallback_used ?? false,
    fallback_days: item.fallback_days ?? null,
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

function clampBatchSize(value: unknown): number {
  const numericValue = Number(value ?? 5);
  if (!Number.isFinite(numericValue)) {
    return 5;
  }

  return Math.min(10, Math.max(1, Math.round(numericValue)));
}

function normalizeCursor(value: unknown): number {
  const numericValue = Number(value ?? 0);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.round(numericValue));
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





























