<#
.SYNOPSIS
  Windowsで既存Bridgeを残したまま、公式モデル対応routerを起動してカタログを移行します。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\catalog-setup.ps1 -BridgePort 10100
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$RouterPort = 8790,
    [ValidateRange(1, 65535)]
    [int]$BridgePort = 10100,
    [string]$CodexHome
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($RouterPort -eq $BridgePort) {
    throw 'RouterPortとBridgePortには別のポートを指定してください。'
}

$repository = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$required = @(
    (Join-Path $repository 'src\model-router.mjs')
    (Join-Path $repository 'src\live-catalog.mjs')
    (Join-Path $repository 'scripts\catalog_doctor.py')
    (Join-Path $PSScriptRoot 'catalog-doctor.ps1')
)
foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "必要なファイルがありません。最新のIssue #143ブランチを取得してください: $path"
    }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js 22.16以上が見つかりません。' }
$nodeVersionText = (& $nodeCommand.Path --version 2>$null)
try {
    $nodeVersion = [version](([string]$nodeVersionText).Trim().TrimStart('v'))
} catch {
    throw "Node.jsのバージョンを確認できません: $nodeVersionText"
}
if ($nodeVersion -lt [version]'22.16') {
    throw "Node.js 22.16以上が必要です（現在: $nodeVersionText）。"
}

$python = $null
foreach ($candidate in @(@('py', '-3'), @('python'), @('python3'))) {
    if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
    $prefix = @($candidate | Select-Object -Skip 1)
    $resolved = & $candidate[0] @prefix -c 'import sys,tomllib; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $resolved) {
        $python = ([string]$resolved).Trim()
        break
    }
}
if (-not $python) { throw 'Python 3.11以上が見つかりません。' }

$effectiveHome = if ($CodexHome) {
    (Resolve-Path -LiteralPath $CodexHome).Path
} elseif ($env:CODEX_HOME) {
    (Resolve-Path -LiteralPath $env:CODEX_HOME).Path
} else {
    Join-Path $HOME '.codex'
}
if (-not (Test-Path -LiteralPath (Join-Path $effectiveHome 'config.toml') -PathType Leaf)) {
    throw "config.tomlが見つかりません: $effectiveHome"
}

function Get-LocalHealth([int]$Port) {
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
    } catch {
        return $null
    }
}

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $Port)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

if (-not (Get-LocalHealth $BridgePort)) {
    throw "既存Bridgeが 127.0.0.1:$BridgePort で応答しません。Bridgeを先に起動してください。"
}

$health = Get-LocalHealth $RouterPort
$startedRouter = $false
$routerProcess = $null
if ($null -ne $health) {
    if ($health.live_catalog -ne $true) {
        throw "ポート$RouterPortで動いているrouterが動的カタログに対応していません。"
    }
    Write-Host "既存routerを再利用します: http://127.0.0.1:$RouterPort"
} else {
    if (Test-LocalPort $RouterPort) {
        throw "ポート$RouterPortは別のプロセスが使用しています。設定は変更していません。"
    }

    $unifiedCatalog = Join-Path $effectiveHome 'unified-model-catalog.json'
    if (-not (Test-Path -LiteralPath $unifiedCatalog -PathType Leaf)) {
        $prepare = & $python -c 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); import unified_config; print(unified_config.prepare(Path(sys.argv[2]), Path(sys.argv[3])))' (Join-Path $repository 'scripts') $effectiveHome $repository
        if ($LASTEXITCODE -ne 0) {
            throw 'unified-model-catalog.jsonを作成できませんでした。models_cache.jsonとmodel-catalog.jsonを確認してください。設定は変更していません。'
        }
        Write-Host "統合カタログを作成しました: $prepare"
    }

    $stateRoot = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA 'codex-bridge'
    } else {
        Join-Path ([System.IO.Path]::GetTempPath()) 'codex-bridge'
    }
    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $stdout = Join-Path $stateRoot "model-router-$RouterPort.log"
    $stderr = Join-Path $stateRoot "model-router-$RouterPort.stderr.log"

    $oldRouterPort = [Environment]::GetEnvironmentVariable('ROUTER_PORT', 'Process')
    $oldBridgeBase = [Environment]::GetEnvironmentVariable('BRIDGE_BASE', 'Process')
    $oldCodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
    $oldPython = [Environment]::GetEnvironmentVariable('CODEX_BRIDGE_PYTHON', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('ROUTER_PORT', "$RouterPort", 'Process')
        [Environment]::SetEnvironmentVariable('BRIDGE_BASE', "http://127.0.0.1:$BridgePort/v1", 'Process')
        [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_PYTHON', $python, 'Process')
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $effectiveHome, 'Process')
        $routerProcess = Start-Process -FilePath $nodeCommand.Path -ArgumentList 'src/model-router.mjs' -WorkingDirectory $repository -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        $startedRouter = $true
    } finally {
        [Environment]::SetEnvironmentVariable('ROUTER_PORT', $oldRouterPort, 'Process')
        [Environment]::SetEnvironmentVariable('BRIDGE_BASE', $oldBridgeBase, 'Process')
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $oldCodexHome, 'Process')
        [Environment]::SetEnvironmentVariable('CODEX_BRIDGE_PYTHON', $oldPython, 'Process')
    }

    Set-Content -LiteralPath (Join-Path $stateRoot "model-router-$RouterPort.pid") -Value $routerProcess.Id -Encoding ascii
    Write-Host "routerを起動しました: PID $($routerProcess.Id) / log $stdout"
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($routerProcess.HasExited) {
            throw "routerが起動直後に終了しました（exit $($routerProcess.ExitCode)）。ログ: $stderr"
        }
        $health = Get-LocalHealth $RouterPort
        if ($null -ne $health) { break }
    }
}

if ($null -eq $health) {
    if ($startedRouter -and $routerProcess) { Stop-Process -Id $routerProcess.Id -ErrorAction SilentlyContinue }
    throw 'routerのhealth確認がタイムアウトしました。設定は変更していません。'
}
$ready = $null -ne $health.catalog_auth -and $health.catalog_auth.ready -eq $true
if ($health.live_catalog -ne $true -or -not $ready) {
    if ($startedRouter -and $routerProcess) { Stop-Process -Id $routerProcess.Id -ErrorAction SilentlyContinue }
    throw 'routerがCodex認証を確認できません。Codexへログイン済みか、同じCODEX_HOMEかを確認してください。設定は変更していません。'
}

$doctorArgs = @{
    Action = 'apply'
    Port = $RouterPort
    CodexHome = $effectiveHome
}
& (Join-Path $PSScriptRoot 'catalog-doctor.ps1') @doctorArgs
if ($LASTEXITCODE -ne 0) {
    throw "カタログ移行に失敗しました。設定はcatalog-doctorの安全確認で停止しています。ログ: $stderr"
}

Write-Host ''
Write-Host "移行完了: 既存Bridge 127.0.0.1:$BridgePort / router 127.0.0.1:$RouterPort"
Write-Host 'Codexデスクトップをタスクトレイまで完全終了してから起動し直し、/modelでGPT-6.1 Solを確認してください。'
Write-Host 'routerはPIDファイルのプロセスとして残ります。Windows再起動後はこのスクリプトを再実行してください。'
