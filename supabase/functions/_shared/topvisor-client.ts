const TOPVISOR_BASE_URL = "https://api.topvisor.com/v2/json";

export type TopvisorSummaryRequest = {
  project_id: number;
  region_index: number;
  date: string;
};

export type TopvisorSummaryMetrics = {
  actual_snapshot_date: string;
  top10_abs: number;
  keywords_all: number;
  top10_pct: number;
};

export type TopvisorProjectRegionMetadata = {
  region_index: number;
  region_name: string;
};

export type TopvisorProjectMetadata = {
  project_id: number;
  project_name: string | null;
  site: string | null;
  display_name: string;
  regions: TopvisorProjectRegionMetadata[];
};

type TopvisorClientConfig = {
  userId: string;
  apiKey: string;
};

async function topvisorPost(
  config: TopvisorClientConfig,
  path: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${TOPVISOR_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Id": config.userId,
      "Authorization": `bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  let json: Record<string, unknown>;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`TopVisor API returned non-JSON response. HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`TopVisor API HTTP ${response.status}: ${extractApiError(json)}`);
  }

  const errors = json.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`TopVisor API error: ${extractApiError(json)}`);
  }

  return json;
}

export async function fetchTopvisorProjects(
  config: TopvisorClientConfig,
): Promise<TopvisorProjectMetadata[]> {
  const response = await topvisorPost(config, "/get/projects_2/projects", {
    fields: ["id", "name", "site"],
    show_searchers_and_regions: 1,
  });

  const result = response.result;

  if (!Array.isArray(result)) {
    return [];
  }

  return result
    .map((project) => normalizeProjectMetadata(project))
    .filter((project): project is TopvisorProjectMetadata => project !== null);
}

function normalizeProjectMetadata(project: unknown): TopvisorProjectMetadata | null {
  if (!project || typeof project !== "object") {
    return null;
  }

  const rawProject = project as Record<string, unknown>;
  const projectId = Number(rawProject.id);

  if (!Number.isFinite(projectId)) {
    return null;
  }

  const projectName = toNullableString(rawProject.name);
  const site = toNullableString(rawProject.site);
  const displayName = projectName || site || `Project ${projectId}`;
  const regions = extractProjectRegions(rawProject);

  return {
    project_id: projectId,
    project_name: projectName,
    site,
    display_name: displayName,
    regions,
  };
}
export async function fetchTopvisorSummaryForDate(
  config: TopvisorClientConfig,
  request: TopvisorSummaryRequest,
): Promise<Record<string, unknown>> {
  const payload = {
    project_id: Number(request.project_id),
    region_index: Number(request.region_index),
    dates: [request.date, request.date],
    show_tops: 1,
    show_dynamics: 1,
  };

  const response = await topvisorPost(config, "/get/positions_2/summary", payload);
  const result = response.result;

  if (!result || typeof result !== "object") {
    return {};
  }

  return result as Record<string, unknown>;
}

export function extractSummaryMetrics(
  summary: Record<string, unknown>,
  requestedDate: string,
): TopvisorSummaryMetrics | null {
  const tops = Array.isArray(summary.tops) ? summary.tops : [];
  const dynamics = Array.isArray(summary.dynamics) ? summary.dynamics : [];

  if (tops.length === 0 && dynamics.length === 0) {
    return null;
  }

  const latestTop = pickLatestObject(tops);
  const latestDynamic = pickLatestObject(dynamics);

  const top10Abs = toIntSafe(latestTop["1_10"]);
  const keywordsAllFromTops = sumTopBuckets(latestTop);
  const keywordsAllFromDynamic = toIntSafe(latestDynamic.all);
  const keywordsAll = keywordsAllFromTops > 0 ? keywordsAllFromTops : keywordsAllFromDynamic;

  if (keywordsAll <= 0) {
    return null;
  }

  const actualDate = String(
    latestDynamic.date ||
    latestDynamic.check_date ||
    latestTop.date ||
    latestTop.check_date ||
    requestedDate
  ).trim();

  if (actualDate && actualDate !== requestedDate) {
    return null;
  }

  const top10Pct = roundTo((top10Abs / keywordsAll) * 100, 4);

  return {
    actual_snapshot_date: actualDate,
    top10_abs: top10Abs,
    keywords_all: keywordsAll,
    top10_pct: top10Pct,
  };
}

function pickLatestObject(items: unknown[]): Record<string, unknown> {
  const item = items[items.length - 1];

  if (!item || typeof item !== "object") {
    return {};
  }

  return item as Record<string, unknown>;
}

function sumTopBuckets(topObj: Record<string, unknown>): number {
  return (
    toIntSafe(topObj["1_10"]) +
    toIntSafe(topObj["11_30"]) +
    toIntSafe(topObj["31_50"]) +
    toIntSafe(topObj["51_100"]) +
    toIntSafe(topObj["101_10000"])
  );
}

function extractProjectRegions(project: Record<string, unknown>): TopvisorProjectRegionMetadata[] {
  const regions = new Map<number, TopvisorProjectRegionMetadata>();

  function visit(value: unknown, keyHint = ""): void {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, keyHint);
      }
      return;
    }

    const obj = value as Record<string, unknown>;
    const keyLooksLikeRegion = keyHint.toLowerCase().includes("region");

    if (keyLooksLikeRegion) {
      const regionIndex = Number(obj.index ?? obj.region_index ?? obj.id);
      const regionName = toNullableString(obj.name ?? obj.region_name ?? obj.title);

      if (Number.isFinite(regionIndex) && regionName) {
        regions.set(regionIndex, {
          region_index: regionIndex,
          region_name: regionName,
        });
      }
    }

    for (const [key, child] of Object.entries(obj)) {
      visit(child, key);
    }
  }

  visit(project);

  return Array.from(regions.values());
}
function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = repairMojibake(String(value).trim());
  return text.length > 0 ? text : null;
}

function repairMojibake(value: string): string {
  if (!/[ÐÑ]/.test(value)) {
    return value;
  }

  try {
    const bytes = Uint8Array.from(Array.from(value), (char) => char.charCodeAt(0) & 255);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return value;
  }
}

function toIntSafe(value: unknown): number {
  const parsed = parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function extractApiError(json: Record<string, unknown>): string {
  if (typeof json.message === "string") return json.message;
  if (typeof json.error === "string") return json.error;

  if (Array.isArray(json.errors)) {
    return json.errors
      .map((error) => {
        if (error && typeof error === "object" && "message" in error) {
          return String((error as { message: unknown }).message);
        }

        return JSON.stringify(error);
      })
      .join("; ");
  }

  return "unknown API error";
}









