# Re-run SWE-EVO harness via WSL for an ablation experiment's predictions.jsonl files.
# Usage:
#   pwsh -File scripts/rerun-ablation-harness-wsl.ps1 -ExperimentRoot <path>
#   pwsh -File scripts/rerun-ablation-harness-wsl.ps1 -ExperimentRoot <path> -MaxWorkers 2

param(
  [Parameter(Mandatory = $true)]
  [string]$ExperimentRoot,
  [string]$OutRoot = '',
  [int]$MaxWorkers = 2,
  [switch]$SkipCompleted
)

function ConvertTo-WslPath([string]$WinPath) {
  $full = [System.IO.Path]::GetFullPath($WinPath)
  if ($full -match '^([A-Za-z]):\\(.*)$') {
    $drive = $Matches[1].ToLowerInvariant()
    $rest = ($Matches[2] -replace '\\', '/')
    return "/mnt/$drive/$rest"
  }
  return $full -replace '\\', '/'
}

$ErrorActionPreference = 'Continue'
$scaffold = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $scaffold
$sweEvoRoot = if ($env:NEWIDE_SWE_EVO_ROOT) {
  $env:NEWIDE_SWE_EVO_ROOT
} else {
  Join-Path $workspaceRoot 'SWE-EVO'
}
$wslPython = if ($env:NEWIDE_SWE_EVO_WSL_PYTHON) {
  $env:NEWIDE_SWE_EVO_WSL_PYTHON
} else {
  ConvertTo-WslPath (Join-Path $sweEvoRoot 'SWE-bench\.venv-swebench\bin\python')
}

if (-not $OutRoot) {
  $OutRoot = Join-Path $ExperimentRoot 'harness-wsl'
}

$env:NEWIDE_SWE_EVO_PYTHON = if ($env:NEWIDE_SWE_EVO_PYTHON) { $env:NEWIDE_SWE_EVO_PYTHON } else { 'wsl' }
$env:NEWIDE_SWE_EVO_WSL_DISTRO = if ($env:NEWIDE_SWE_EVO_WSL_DISTRO) { $env:NEWIDE_SWE_EVO_WSL_DISTRO } else { 'Ubuntu' }
$env:NEWIDE_SWE_EVO_WSL_PYTHON = $wslPython
$env:NEWIDE_SWE_EVO_ROOT = ($sweEvoRoot -replace '\\', '/')

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
$logPath = Join-Path $OutRoot 'batch.log'
$summaryPath = Join-Path $OutRoot 'batch-summary.jsonl'

$preds = @(Get-ChildItem (Join-Path $ExperimentRoot 'B*\eval\*\predictions.jsonl') -File | Sort-Object FullName)
"[(Get-Date).ToString('o')] found $($preds.Count) predictions -> $OutRoot" | Tee-Object -FilePath $logPath -Append

$ok = 0
$fail = 0
$skip = 0

foreach ($pred in $preds) {
  $runId = $pred.Directory.Name
  $runOut = Join-Path $OutRoot $runId
  $marker = Join-Path $runOut 'harness.ok'
  $failMarker = Join-Path $runOut 'harness.fail'
  if ($SkipCompleted -and (Test-Path $marker)) {
    $skip++
    "[$((Get-Date).ToString('HH:mm:ss'))] SKIP $runId" | Tee-Object -FilePath $logPath -Append
    continue
  }

  "[$((Get-Date).ToString('HH:mm:ss'))] START $runId" | Tee-Object -FilePath $logPath -Append
  Push-Location $scaffold
  try {
    pnpm eval:sweevo-harness -- --predictions $pred.FullName --run-id $runId --out-root $OutRoot --max-workers $MaxWorkers
    $code = $LASTEXITCODE
  } catch {
    $code = 1
    $_ | Out-String | Tee-Object -FilePath $logPath -Append
  } finally {
    Pop-Location
  }

  $row = [ordered]@{
    run_id = $runId
    predictions = $pred.FullName
    exit_code = $code
    finished_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  ($row | ConvertTo-Json -Compress) | Add-Content -Path $summaryPath -Encoding utf8

  if ($code -eq 0) {
    $ok++
    New-Item -ItemType File -Force -Path $marker | Out-Null
    if (Test-Path $failMarker) { Remove-Item $failMarker -Force }
    "[$((Get-Date).ToString('HH:mm:ss'))] OK $runId" | Tee-Object -FilePath $logPath -Append
  } else {
    $fail++
    New-Item -ItemType File -Force -Path $failMarker | Out-Null
    "[$((Get-Date).ToString('HH:mm:ss'))] FAIL $runId exit=$code" | Tee-Object -FilePath $logPath -Append
  }
}

"[(Get-Date).ToString('o')] done ok=$ok fail=$fail skip=$skip total=$($preds.Count)" | Tee-Object -FilePath $logPath -Append
