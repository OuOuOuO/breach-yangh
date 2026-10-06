#Requires -Version 5.1
<#
  ZCode working-conventions deployer (v4)

  Deploys the operator working-conventions file to ~/.zcode/AGENTS.md.

  Channels:
    AGENTS.md          -> the only effective channel. Verified across four live rounds.
    plugin-workspace   -> NOT a ZCode load path. Verified: staged plugin content never
                          appears in the model context. Off by default; install also
                          removes any stale copy. See targets/zcode/verification.md.

  This script is deliberately ASCII-only: Windows PowerShell 5.1 reads .ps1 files as
  ANSI, so non-ASCII literals here would corrupt under a non-UTF-8 code page. Payload
  content is read from disk as UTF-8 and written back as UTF-8 (no BOM).

  Usage:
    powershell -File install.ps1 -Action status
    powershell -File install.ps1 -Action install
    powershell -File install.ps1 -Action install -WithPlugin   (inert until marketplace-installed)
    powershell -File install.ps1 -Action revert
#>
param(
  [ValidateSet("status", "install", "revert")]
  [string]$Action = "status",
  [switch]$WithPlugin
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$Payload   = Join-Path $RepoRoot "payloads\zcode-agents.md"
$PluginSrc = Join-Path $RepoRoot "plugin"

$ZcodeHome = if ($env:ZCODE_HOME) { $env:ZCODE_HOME } else { Join-Path $env:USERPROFILE ".zcode" }
$Target    = Join-Path $ZcodeHome "AGENTS.md"
$Backup    = "$Target.ops.bak"
$PluginDst = Join-Path $ZcodeHome "plugin-workspace\ops-conventions"

# v1 artifacts, removed on install/revert
$LegacyPlugin = Join-Path $ZcodeHome "plugin-workspace\legacy-ops"

$SizeLimitKB = 100

function Read-Utf8([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
}

function Write-Utf8([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-ZcodeProc {
  Get-Process -Name "ZCode" -ErrorAction SilentlyContinue
}

function Show-Status {
  Write-Host "== ZCode working conventions ==" -ForegroundColor Cyan
  Write-Host "ZCODE_HOME : $ZcodeHome"
  Write-Host "payload    : $Payload"
  Write-Host "             exists: $(Test-Path -LiteralPath $Payload)"

  $payloadText = Read-Utf8 $Payload
  $text = Read-Utf8 $Target
  Write-Host "target     : $Target"
  if ($null -eq $text) {
    Write-Host "state      : NOT DEPLOYED (target absent)" -ForegroundColor Yellow
  } else {
    $kb = [math]::Round((Get-Item -LiteralPath $Target).Length / 1KB, 1)
    $same = ($text.Trim() -eq $payloadText.Trim())
    $color = if ($same) { "Green" } else { "Yellow" }
    Write-Host "state      : $(if ($same) { 'DEPLOYED (matches payload)' } else { 'DIFFERENT from payload (edited or foreign)' })" -ForegroundColor $color
    Write-Host "size       : $kb KB / limit ${SizeLimitKB} KB" -ForegroundColor $(if ($kb -lt $SizeLimitKB) { "Gray" } else { "Red" })
  }

  Write-Host "backup     : $(if (Test-Path -LiteralPath $Backup) { $Backup } else { '(none)' })"
  $inert = @($PluginDst, $LegacyPlugin) | Where-Object { Test-Path -LiteralPath $_ }
  if ($inert.Count -gt 0) {
    Write-Host "inert dir  : $($inert -join ', ')" -ForegroundColor Yellow
    Write-Host "             (plugin-workspace is not a load path; run install to remove)" -ForegroundColor DarkGray
  } else {
    Write-Host "inert dir  : (none)" -ForegroundColor Green
  }

  if (Get-ZcodeProc) {
    Write-Host "process    : RUNNING - fully quit and relaunch ZCode to load disk changes" -ForegroundColor Yellow
  } else {
    Write-Host "process    : not running - next launch will load the file" -ForegroundColor Green
  }
}

function Invoke-Install {
  if (-not (Test-Path -LiteralPath $Payload)) { throw "payload not found: $Payload" }
  $body = Read-Utf8 $Payload

  # Feature string = payload's first line. Distinguishes the user's own AGENTS.md from a
  # payload this tool deployed earlier. Only the former should ever be backed up —
  # otherwise a remove() restores our own stale version instead of deleting it.
  $feature = ($body -split "`n")[0].Trim()

  $existing = Read-Utf8 $Target
  if ($null -ne $existing -and $existing.Trim() -ne $body.Trim()) {
    if ($feature -and $existing.Contains($feature)) {
      Write-Host "existing AGENTS.md is a previous payload version - not backing it up" -ForegroundColor DarkGray
    } else {
      Write-Utf8 $Backup $existing
      Write-Host "backed up user's own AGENTS.md -> $Backup" -ForegroundColor Yellow
    }
  }

  Write-Utf8 $Target $body
  $kb = [math]::Round((Get-Item -LiteralPath $Target).Length / 1KB, 1)
  Write-Host "wrote payload -> $Target ($kb KB)" -ForegroundColor Green

  foreach ($dir in @($PluginDst, $LegacyPlugin)) {
    if (Test-Path -LiteralPath $dir) {
      Remove-Item -LiteralPath $dir -Recurse -Force
      Write-Host "removed inert dir -> $dir" -ForegroundColor Yellow
    }
  }

  if ($WithPlugin) {
    if (Test-Path -LiteralPath $PluginSrc) {
      Copy-Item -LiteralPath $PluginSrc -Destination $PluginDst -Recurse -Force
      Write-Host "plugin staged -> $PluginDst" -ForegroundColor Yellow
      Write-Host "  (inert: ZCode does not load plugin-workspace. Install it through the" -ForegroundColor DarkGray
      Write-Host "   marketplace first, otherwise this stays a no-op.)" -ForegroundColor DarkGray
    } else {
      Write-Host "plugin source missing: $PluginSrc" -ForegroundColor Yellow
    }
  }

  Write-Host ""
  if (Get-ZcodeProc) {
    Write-Host "NEXT: fully quit and relaunch ZCode. Test by behavior, not by passphrase." -ForegroundColor Cyan
  } else {
    Write-Host "NEXT: launch ZCode in a new session. Test by behavior, not by passphrase." -ForegroundColor Cyan
  }
}

function Invoke-Revert {
  $body = Read-Utf8 $Payload
  $feature = if ($body) { ($body -split "`n")[0].Trim() } else { "" }
  $existing = Read-Utf8 $Target
  $isOurs = ($null -ne $existing -and $feature -and $existing.Contains($feature))

  if (Test-Path -LiteralPath $Backup) {
    $saved = Read-Utf8 $Backup
    $savedIsOurs = ($feature -and $saved -and $saved.Contains($feature))
    if ($savedIsOurs) {
      # The backup is one of our own earlier payloads, not the user's file.
      if ($isOurs) { Remove-Item -LiteralPath $Target -Force; Write-Host "removed deployed AGENTS.md (backup was a stale payload)" -ForegroundColor Green }
      Remove-Item -LiteralPath $Backup -Force
      Write-Host "discarded stale payload backup" -ForegroundColor DarkGray
    } else {
      Write-Utf8 $Target $saved
      Remove-Item -LiteralPath $Backup -Force
      Write-Host "restored user's original AGENTS.md from backup" -ForegroundColor Green
    }
  } elseif ($isOurs) {
    Remove-Item -LiteralPath $Target -Force
    Write-Host "removed deployed AGENTS.md (no backup existed)" -ForegroundColor Green
  } elseif ($null -ne $existing) {
    Write-Host "AGENTS.md is not ours - left untouched" -ForegroundColor Yellow
  } else {
    Write-Host "nothing to revert" -ForegroundColor DarkGray
  }

  foreach ($dir in @($PluginDst, $LegacyPlugin)) {
    if (Test-Path -LiteralPath $dir) {
      Remove-Item -LiteralPath $dir -Recurse -Force
      Write-Host "removed -> $dir" -ForegroundColor Green
    }
  }
}

switch ($Action) {
  "status" { Show-Status }
  "install" { Invoke-Install; Write-Host ""; Show-Status }
  "revert" { Invoke-Revert; Write-Host ""; Show-Status }
}
