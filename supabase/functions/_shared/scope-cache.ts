const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_KEY = "daily_project_scope";

type ScopeCacheEntry = {
  cache_key: string;
  cache_date: string;
  expires_at: string;
  payload: Record<string, unknown>;
};

export type ScopeCacheStatus = "hit" | "miss_refreshed" | "unavailable_live_fallback";

export type ScopeCacheReadResult = {
  entry: ScopeCacheEntry | null;
  available: boolean;
  warning: string | null;
};

export type ScopeCacheWriteResult = {
  ok: boolean;
  warning: string | null;
  expiresAt: string;
};

export async function readTopvisorScopeCache(params?: {
  cacheKey?: string;
  cacheDate?: string;
}): Promise<ScopeCacheReadResult> {
  const config = getSupabaseRestConfig();

  if (!config) {
    return {
      entry: null,
      available: false,
      warning: "Supabase cache is unavailable. Using live Topvisor scope discovery.",
    };
  }

  const cacheKey = params?.cacheKey || DEFAULT_CACHE_KEY;
  const cacheDate = params?.cacheDate || getTodayYmd();

  try {
    const url = new URL(`${config.url}/rest/v1/topvisor_scope_cache`);
    url.searchParams.set("select", "cache_key,cache_date,expires_at,payload");
    url.searchParams.set("cache_key", `eq.${cacheKey}`);
    url.searchParams.set("cache_date", `eq.${cacheDate}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return {
        entry: null,
        available: false,
        warning: "Supabase cache read failed. Using live Topvisor scope discovery.",
      };
    }

    const result = await response.json();
    const entry = Array.isArray(result) && result.length > 0 ? result[0] as ScopeCacheEntry : null;

    if (!entry) {
      return {
        entry: null,
        available: true,
        warning: null,
      };
    }

    const expiresAt = new Date(entry.expires_at);
    const isFresh = Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now();

    return {
      entry: isFresh ? entry : null,
      available: true,
      warning: isFresh ? null : "Cached scope is expired. Refreshing from Topvisor.",
    };
  } catch {
    return {
      entry: null,
      available: false,
      warning: "Supabase cache read failed. Using live Topvisor scope discovery.",
    };
  }
}

export async function writeTopvisorScopeCache(params: {
  cacheKey?: string;
  cacheDate?: string;
  payload: Record<string, unknown>;
}): Promise<ScopeCacheWriteResult> {
  const config = getSupabaseRestConfig();

  if (!config) {
    return {
      ok: false,
      warning: "Supabase cache is unavailable. Using live Topvisor scope discovery.",
      expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
    };
  }

  const cacheKey = params.cacheKey || DEFAULT_CACHE_KEY;
  const cacheDate = params.cacheDate || getTodayYmd();
  const expiresAt = new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString();

  try {
    const url = new URL(`${config.url}/rest/v1/topvisor_scope_cache`);
    url.searchParams.set("on_conflict", "cache_key");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal, resolution=merge-duplicates",
      },
      body: JSON.stringify({
        cache_key: cacheKey,
        cache_date: cacheDate,
        expires_at: expiresAt,
        payload: params.payload,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      return {
        ok: false,
        warning: "Supabase cache write failed. Using live Topvisor scope discovery.",
        expiresAt,
      };
    }

    return {
      ok: true,
      warning: null,
      expiresAt,
    };
  } catch {
    return {
      ok: false,
      warning: "Supabase cache write failed. Using live Topvisor scope discovery.",
      expiresAt,
    };
  }
}

export function getSupabaseRestConfig(): { url: string; key: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = resolveSupabaseSecretKey();

  if (!url || !key) {
    return null;
  }

  return { url: url.replace(/\/+$/, ""), key };
}

function resolveSupabaseSecretKey(): string | null {
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysRaw) {
    try {
      const secretKeys = JSON.parse(secretKeysRaw) as Record<string, string | undefined>;
      const defaultKey = secretKeys.default || secretKeys.service_role || secretKeys.service_role_key;
      if (defaultKey) {
        return defaultKey;
      }
    } catch {
      // Ignore malformed JSON and fall back to legacy env vars.
    }
  }

  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE") || Deno.env.get("SUPABASE_SERVICE_KEY");
}

function getTodayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
