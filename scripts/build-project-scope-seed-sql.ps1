[CmdletBinding()]
param(
    [Parameter()]
    [string]$ScopePath = '.\local-data\project_scope.csv',

    [Parameter()]
    [string]$OutputPath = '.\local-data\topvisor_project_scope_seed.sql',

    [Parameter()]
    [string]$ScopeSource = 'local_csv_seed'
)

function Escape-SqlString {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return $null }
    return "'" + $Value.Replace("'", "''") + "'"
}

function Convert-EmptyToNull {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value -or [string]::IsNullOrEmpty($Value.Trim())) { return 'null' }
    return Escape-SqlString $Value.Trim()
}

function Assert-ValidSearchEngine {
    param([string]$Value)
    if ($Value -ne 'Yandex' -and $Value -ne 'Google') {
        throw "Invalid search_engine value '$Value'. Must be 'Yandex' or 'Google'."
    }
}

$rows = Import-Csv -Path $ScopePath
$totalRows = $rows.Count

# Filter active rows
$activeRows = @($rows | Where-Object { $_.is_active -eq '1' })
$activeCount = $activeRows.Count

$valueLines = @()
$yandexCount = 0
$googleCount = 0
$uniqueKeys = @{}

foreach ($row in $activeRows) {
    $rowKey = [string]$row.row_key
    $searchEngine = [string]$row.search_engine

    # Validate required fields
    if ([string]::IsNullOrWhiteSpace($rowKey)) {
        throw "row_key is empty for row with project_id=$($row.project_id)"
    }
    Assert-ValidSearchEngine $searchEngine

    # Validate and parse numeric fields
    $projectId = [long]::Parse($row.project_id)
    $regionIndex = [int]::Parse($row.region_index)
    $searcherKey = [int]::Parse($row.searcher_key)

    # Map and escape text fields
    $projectName = Convert-EmptyToNull ([string]$row.project_name_api)
    $site = Convert-EmptyToNull ([string]$row.site_api)
    $regionKey = Convert-EmptyToNull ([string]$row.region_key)
    $regionName = Convert-EmptyToNull ([string]$row.region_name_api)
    $escapedRowKey = Escape-SqlString $rowKey
    $escapedSearchEngine = Escape-SqlString $searchEngine
    $escapedScopeSource = Escape-SqlString $ScopeSource

    # Count by search engine
    if ($searchEngine -eq 'Yandex') { $yandexCount++ }
    elseif ($searchEngine -eq 'Google') { $googleCount++ }

    # Track unique row_key
    $uniqueKeys[$rowKey] = $true

    $valueLines += "($projectId, $projectName, $site, $regionIndex, $regionKey, $regionName, $searcherKey, $escapedSearchEngine, $escapedRowKey, true, $escapedScopeSource)"
}

$sql = @"
begin;

insert into public.topvisor_project_scope (
    project_id,
    project_name,
    site,
    region_index,
    region_key,
    region_name,
    searcher_key,
    search_engine,
    row_key,
    is_active,
    scope_source
)
values
$($valueLines -join ",
")
on conflict (row_key) do update set
    project_id = excluded.project_id,
    project_name = excluded.project_name,
    site = excluded.site,
    region_index = excluded.region_index,
    region_key = excluded.region_key,
    region_name = excluded.region_name,
    searcher_key = excluded.searcher_key,
    search_engine = excluded.search_engine,
    is_active = excluded.is_active,
    scope_source = excluded.scope_source,
    updated_at = now();

commit;

-- Verification: total active rows
select count(*) from public.topvisor_project_scope where is_active = true;

-- Verification: rows by search engine
select search_engine, count(*) from public.topvisor_project_scope where is_active = true group by search_engine order by search_engine;
"@

# Write output
$OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
[System.IO.File]::WriteAllText($OutputPath, $sql, [System.Text.Encoding]::UTF8)

# Summary
Write-Host "=== Seed SQL Build Summary ==="
Write-Host "Source path:           $ScopePath"
Write-Host "Output path:           $OutputPath"
Write-Host "Total CSV rows:        $totalRows"
Write-Host "Active rows (is_active=1): $activeCount"
Write-Host "Generated SQL rows:    $($valueLines.Count)"
Write-Host "Unique row_key count:  $($uniqueKeys.Count)"
Write-Host "Yandex rows:           $yandexCount"
Write-Host "Google rows:           $googleCount"