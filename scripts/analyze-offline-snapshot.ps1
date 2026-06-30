[CmdletBinding()]
param(
    [Parameter()]
    [string]$Date = '2026-06-29',

    [Parameter()]
    [string]$ScopePath = '.\local-data\project_scope.csv',

    [Parameter()]
    [string]$DailyPath = '.\local-data\data_daily.csv'
)

function Convert-NumericValue {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $null
    }

    $normalized = ([string]$Value).Trim().Replace(',', '.')
    return [double]$normalized
}

function Get-EffectiveSnapshotDate {
    param([Parameter(Mandatory = $true)][psobject]$Row)

    $checkDateActual = [string]$Row.check_date_actual
    if (-not [string]::IsNullOrWhiteSpace($checkDateActual)) {
        return [datetime]::ParseExact($checkDateActual, 'yyyy-MM-dd', $null)
    }

    return [datetime]::ParseExact([string]$Row.snapshot_date, 'yyyy-MM-dd', $null)
}

$requestedDate = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)

$scopeRows = @(Import-Csv -Path $ScopePath | Where-Object {
        $_.is_active -eq '1' -and -not [string]::IsNullOrWhiteSpace($_.row_key)
    })

$dailyRows = @(Import-Csv -Path $DailyPath | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_.row_key)
    })

$dailyRowsByKey = @{}
foreach ($dailyRow in $dailyRows) {
    if (-not $dailyRowsByKey.ContainsKey([string]$dailyRow.row_key)) {
        $dailyRowsByKey[[string]$dailyRow.row_key] = New-Object System.Collections.Generic.List[object]
    }

    $dailyRowsByKey[[string]$dailyRow.row_key].Add($dailyRow)
}

$matchedRows = New-Object System.Collections.Generic.List[object]
$missingRows = New-Object System.Collections.Generic.List[object]
$distribution = @{}

foreach ($scopeRow in $scopeRows) {
    $rowKey = [string]$scopeRow.row_key
    $candidates = @()

    if ($dailyRowsByKey.ContainsKey($rowKey)) {
        $candidates = @($dailyRowsByKey[$rowKey] | Where-Object {
                $snapshotDate = [datetime]::ParseExact([string]$_.snapshot_date, 'yyyy-MM-dd', $null)
                $effectiveSnapshotDate = Get-EffectiveSnapshotDate $_

                $snapshotDate -le $requestedDate -and $effectiveSnapshotDate -le $requestedDate
            })
    }

    if ($candidates.Count -gt 0) {
        $selected = $candidates |
            Sort-Object -Property @{ Expression = { Get-EffectiveSnapshotDate $_ }; Descending = $true }, @{ Expression = { [datetime]::Parse([string]$_.load_ts) }; Descending = $true } |
            Select-Object -First 1

        $effectiveSnapshotDate = Get-EffectiveSnapshotDate $selected
        $effectiveSnapshotDateString = $effectiveSnapshotDate.ToString('yyyy-MM-dd')

        $selected | Add-Member -NotePropertyName 'effective_snapshot_date' -NotePropertyValue $effectiveSnapshotDateString -Force
        $selected | Add-Member -NotePropertyName 'top10_abs_num' -NotePropertyValue (Convert-NumericValue $selected.top10_abs) -Force
        $selected | Add-Member -NotePropertyName 'keywords_all_num' -NotePropertyValue (Convert-NumericValue $selected.keywords_all) -Force
        $selected | Add-Member -NotePropertyName 'top10_pct_num' -NotePropertyValue (Convert-NumericValue $selected.top10_pct) -Force

        $matchedRows.Add($selected)

        if (-not $distribution.ContainsKey($effectiveSnapshotDateString)) {
            $distribution[$effectiveSnapshotDateString] = 0
        }

        $distribution[$effectiveSnapshotDateString] += 1
    }
    else {
        $missingRows.Add([pscustomobject]@{
                project_id = [string]$scopeRow.project_id
                project_name = [string]$scopeRow.project_name_api
                region_name = [string]$scopeRow.region_name_api
                search_engine = [string]$scopeRow.search_engine
                row_key = [string]$scopeRow.row_key
            })
    }
}

$summary = [ordered]@{
    requested_date = $Date
    active_scope_rows = $scopeRows.Count
    matched_latest_rows = $matchedRows.Count
    missing_rows = $missingRows.Count
    unique_project_id = @($scopeRows | Select-Object -ExpandProperty project_id -Unique).Count
    unique_project_region = @($scopeRows | ForEach-Object { "{0}|{1}" -f $_.project_id, $_.region_name_api } | Select-Object -Unique).Count
    yandex_rows = @($scopeRows | Where-Object { $_.search_engine -eq 'Yandex' }).Count
    google_rows = @($scopeRows | Where-Object { $_.search_engine -eq 'Google' }).Count
}

Write-Host 'SUMMARY'
$summary | ConvertTo-Json -Depth 4
Write-Host ''
Write-Host 'MATCHED SNAPSHOT DATE DISTRIBUTION'
$distributionRows = foreach ($entry in ($distribution.GetEnumerator() | Sort-Object Key)) {
    [pscustomobject]@{
        snapshot_date = $entry.Key
        rows = $entry.Value
    }
}

if ($distributionRows.Count -gt 0) {
    $distributionRows | Format-Table -AutoSize
}
else {
    Write-Host 'No matched rows.'
}

Write-Host ''
Write-Host 'MISSING ACTIVE ROWS'
if ($missingRows.Count -gt 0) {
    $missingRows | Format-Table -AutoSize
}
else {
    Write-Host 'No missing rows.'
}
