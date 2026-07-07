create table if not exists topvisor_scope_cache (
  cache_key text primary key,
  cache_date date not null,
  expires_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
