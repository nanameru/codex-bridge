<#
.SYNOPSIS
  Issue #143: 旧OpenCode専用 model_catalog_json を診断・移行・復元します。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-doctor.ps1
  powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-doctor.ps1 -Action apply -Port 8790
  powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-doctor.ps1 -Action restore
#>
[CmdletBinding()]
param(
    [ValidateSet('diagnose', 'apply', 'restore')]
    [string]$Action = 'diagnose',
    [ValidateRange(1, 65535)]
    [int]$Port = 8790,
    [string]$CodexHome,
    [switch]$Json
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$doctor = Join-Path (Split-Path -Parent $PSScriptRoot) 'catalog_doctor.py'
$python = $null
foreach ($candidate in @(@('py', '-3'), @('python'), @('python3'))) {
    if (Get-Command $candidate[0] -ErrorAction SilentlyContinue) {
        $prefix = @($candidate | Select-Object -Skip 1)
        & $candidate[0] @prefix -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) { $python = $candidate; break }
    }
}
if (-not $python) {
    Write-Error 'Python 3.11以上が見つかりません。設定は変更していません。'
    exit 2
}
if ($CodexHome) { $env:CODEX_HOME = $CodexHome }
$env:PYTHONUTF8 = '1'
$arguments = @($python | Select-Object -Skip 1) + @($doctor, $Action, '--port', "$Port")
if ($Json) { $arguments += '--json' }
& $python[0] @arguments
exit $LASTEXITCODE
