#Requires -Version 5.1
<#
  BREACH one-shot control for ZCode.  (v2 - dynamic path resolution)

    find     -> locate the ZCode install (no writes)
    install  -> patch zcode.cjs + deploy AGENTS.md
    remove   -> restore both layers and wipe every backup (back to stock)
    status   -> combined view

  What changed vs v1:
    - No hardcoded install path anywhere. The bundle is located by
      tools/zcode-locate.mjs (CLI arg > env > memory > process > registry >
      shortcut > drive sniffing), so any drive letter or portable layout works.
    - The located path is exported as ZCODE_BUNDLE for every child node
      process. In v1 this step was missing: find-bundle succeeded but the
      result never reached the patch tool, which then fell back to its own
      hardcoded default.
    - New -Bundle / -Path overrides for unusual installs.

  This file is deliberately ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI,
  so non-ASCII literals would corrupt under a non-UTF-8 code page. Node tools print
  UTF-8 (Chinese) output; the console encoding is switched below so it renders.

  Examples:
    powershell -ExecutionPolicy Bypass -File breach.ps1 find
    powershell -ExecutionPolicy Bypass -File breach.ps1 install
    powershell -ExecutionPolicy Bypass -File breach.ps1 install -Restart
    powershell -ExecutionPolicy Bypass -File breach.ps1 remove
    powershell -ExecutionPolicy Bypass -File breach.ps1 status
    powershell -ExecutionPolicy Bypass -File breach.ps1 status -Path "E:\Apps\ZCode"
    powershell -ExecutionPolicy Bypass -File breach.ps1 status -Bundle "E:\Apps\ZCode\resources\glm\zcode.cjs"
#>
param(
  [ValidateSet("find", "install", "remove", "status")]
  [string]$Action = "status",
  [switch]$Restart,
  [string]$Path,
  [string]$Bundle
)

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = "Stop"

# node prints UTF-8 (Chinese) output; make it render correctly when launched from cmd.exe too.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolsDir   = Join-Path $Root "tools"
$PatchTool  = Join-Path $ToolsDir "zcode-patch.mjs"
$LocateTool = Join-Path $ToolsDir "zcode-locate.mjs"
$InstallPs1 = Join-Path $ToolsDir "install.ps1"

function Get-NodeExe {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

$NodeExe = Get-NodeExe

function Assert-Prereqs {
  if (-not $NodeExe) { throw "node.exe not found. Install Node.js or add it to PATH." }
  if (-not (Test-Path -LiteralPath $PatchTool))  { throw "missing: $PatchTool" }
  if (-not (Test-Path -LiteralPath $LocateTool)) { throw "missing: $LocateTool" }
  if (-not (Test-Path -LiteralPath $InstallPs1)) { throw "missing: $InstallPs1" }
}

# ---------------------------------------------------------------------------
# Path resolution.
#   Runs the locate tool, parses its KEY=VALUE output, and exports ZCODE_BUNDLE
#   so every child node process inherits the same path. This is the fix for the
#   v1 defect where the detected bundle never reached zcode-patch.mjs.
# ---------------------------------------------------------------------------
function Resolve-ZCode {
  $locArgs = @($LocateTool, "--print")
  if ($Bundle) { $locArgs += @("--bundle", $Bundle) }
  if ($Path)   { $locArgs += @("--path", $Path) }

  $raw = & $NodeExe @locArgs 2>$null
  $rc = $LASTEXITCODE

  $res = @{ BUNDLE = $null; EXE = $null; HOME = $null; SOURCE = $null; WARN = @(); DIAG = @() }
  foreach ($line in @($raw)) {
    if ($null -eq $line) { continue }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { continue }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if ($k -eq "WARN") { $res.WARN += $v; continue }
    if ($k -eq "DIAG") { $res.DIAG += $v; continue }
    if ($res.ContainsKey($k)) { $res[$k] = $v }
  }

  # Nothing located -> the tool printed DIAG= lines; keep them for the caller.
  if (-not $res.BUNDLE -and $rc -ne 0) {
    if (-not $res.DIAG -or $res.DIAG.Count -eq 0) { $res.DIAG = @((@($raw) -join "`n").Trim()) }
  }

  if ($res.BUNDLE) {
    $env:ZCODE_BUNDLE = $res.BUNDLE
    if ($res.EXE)  { $env:ZCODE_EXE = $res.EXE }
    if ($res.HOME) { $env:ZCODE_HOME = $res.HOME }
  }
  $res.Found = [bool]$res.BUNDLE
  $res.ExitCode = $rc
  return $res
}

function Show-NotFound([hashtable]$res) {
  Write-Host ""
  Write-Host "ZCode bundle was NOT located on this machine." -ForegroundColor Red
  if ($res.DIAG -and $res.DIAG.Count -gt 0) {
    Write-Host ""
    foreach ($line in $res.DIAG) { Write-Host ("  " + $line) -ForegroundColor Gray }
    Write-Host ""
  } else {
    Write-Host "Run the locate tool alone for the full diagnosis:" -ForegroundColor Yellow
    Write-Host "  node tools\zcode-locate.mjs --diagnose" -ForegroundColor DarkGray
  }
  Write-Host "Then retry with an explicit path, e.g.:" -ForegroundColor Yellow
  Write-Host "  powershell -File breach.ps1 status -Path `"X:\your\ZCode\dir`"" -ForegroundColor DarkGray
  Write-Host "  powershell -File breach.ps1 status -Bundle `"X:\...\resources\glm\zcode.cjs`"" -ForegroundColor DarkGray
}

function Show-Warnings([hashtable]$res) {
  if ($res.WARN -and $res.WARN.Count -gt 0) {
    foreach ($w in $res.WARN) { Write-Host "[warn] $w" -ForegroundColor Yellow }
  }
}

function Step([string]$n, [string]$text) {
  Write-Host ""
  Write-Host "[$n] $text" -ForegroundColor Cyan
}

function Run-Node([string[]]$NodeArgs) {
  & $NodeExe @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "node $($NodeArgs -join ' ') exited with $LASTEXITCODE" }
}

function Find-ZCodeExe {
  if ($env:ZCODE_EXE -and (Test-Path -LiteralPath $env:ZCODE_EXE)) { return $env:ZCODE_EXE }
  $p = Get-Process -Name "ZCode" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p -and $p.Path -and (Test-Path -LiteralPath $p.Path)) { return $p.Path }
  if ($env:ZCODE_BUNDLE) {
    $parts = $env:ZCODE_BUNDLE -split "[\\/]"
    $idx = [Array]::IndexOf($parts, "resources")
    if ($idx -gt 0) {
      $exe = Join-Path (($parts[0..($idx - 1)] -join "\")) "ZCode.exe"
      if (Test-Path -LiteralPath $exe) { return $exe }
    }
  }
  foreach ($lnk in @("$env:USERPROFILE\Desktop\ZCode.lnk", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\ZCode.lnk")) {
    if (-not (Test-Path -LiteralPath $lnk)) { continue }
    try {
      $t = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath
      if ($t -and (Test-Path -LiteralPath $t)) { return $t }
    } catch { }
  }
  return $null
}

function Restart-ZCode {
  $exe = Find-ZCodeExe
  if (-not $exe) { Write-Host "ZCode executable not found; start it yourself." -ForegroundColor Yellow; return }
  $procs = Get-Process -Name "ZCode" -ErrorAction SilentlyContinue
  if ($procs) {
    Write-Host "Closing ZCode (pid $($procs.Id -join ', '))..." -ForegroundColor Yellow
    $procs | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    Start-Sleep -Seconds 3
    $left = Get-Process -Name "ZCode" -ErrorAction SilentlyContinue
    if ($left) { $left | Stop-Process -Force; Start-Sleep -Seconds 1 }
  }
  Start-Process -FilePath $exe
  Write-Host "ZCode relaunched: $exe" -ForegroundColor Green
}

function Invoke-Find {
  Assert-Prereqs
  Run-Node @($LocateTool, "--diagnose")
}

function Invoke-Install {
  Assert-Prereqs
  $loc = Resolve-ZCode

  Write-Host "== BREACH install ==" -ForegroundColor Green
  Write-Host "bundle : $(if ($loc.Found) { $loc.BUNDLE } else { '(not found)' })"
  Write-Host "source : $($loc.SOURCE)"
  Write-Host "home   : $($loc.HOME)"
  Show-Warnings $loc

  if (-not $loc.Found) { Show-NotFound $loc; throw "cannot install: ZCode bundle not located." }

  Step "1/4" "verify patch anchors (must be unique)"
  Run-Node @($PatchTool, "verify")

  Step "2/4" "apply host patches to zcode.cjs"
  Run-Node @($PatchTool, "apply")
  & $NodeExe --check $env:ZCODE_BUNDLE
  if ($LASTEXITCODE -ne 0) { throw "syntax check FAILED on patched bundle - run: node tools\zcode-patch.mjs revert" }
  Write-Host "syntax check: PASS" -ForegroundColor Green

  Step "3/4" "deploy AGENTS.md payload"
  & $InstallPs1 -Action install

  Step "4/4" "done"
  if ($Restart) {
    Restart-ZCode
  } else {
    Write-Host "Fully quit ZCode and relaunch it. Add -Restart to do it automatically." -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "Verify by behavior, not by passphrase - send a task and read the log:" -ForegroundColor DarkGray
  Write-Host "  ~/.zcode/cli/rollout/model-io-sess_<id>.jsonl   (field: reasoningText)" -ForegroundColor DarkGray
}

function Invoke-Remove {
  Assert-Prereqs
  $loc = Resolve-ZCode

  Write-Host "== BREACH remove ==" -ForegroundColor Yellow
  Write-Host "bundle : $(if ($loc.Found) { $loc.BUNDLE } else { '(not found)' })"
  Show-Warnings $loc

  Step "1/4" "restore zcode.cjs"
  if ($loc.Found) {
    $bundlePath = $loc.BUNDLE
    $bak = $bundlePath + ".breach.bak"
    if (Test-Path -LiteralPath $bak) {
      Run-Node @($PatchTool, "revert")
    } else {
      Write-Host "  no usable backup - falling back to reverse-patch restore" -ForegroundColor Yellow
      Run-Node @($PatchTool, "restore")
    }
  } else {
    Write-Host "  bundle not located; skipping host layer (nothing to restore)." -ForegroundColor Yellow
    Show-NotFound $loc
  }

  Step "2/4" "wipe patch backups"
  if ($loc.Found) {
    $bundlePath = $loc.BUNDLE
    foreach ($suffix in @(".breach.bak", ".breach.bak.meta.json", ".breach.bak.superseded", ".breach.bak.contaminated", ".pre-restore.bak")) {
      $f = $bundlePath + $suffix
      if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Host "  removed $f" }
    }
  }

  Step "3/4" "revert AGENTS.md payload"
  & $InstallPs1 -Action revert
  $zHome = if ($env:ZCODE_HOME) { $env:ZCODE_HOME } else { Join-Path $env:USERPROFILE ".zcode" }
  $opsBak = Join-Path $zHome "AGENTS.md.ops.bak"
  if (Test-Path -LiteralPath $opsBak) { Remove-Item -LiteralPath $opsBak -Force; Write-Host "  removed $opsBak" }

  Step "4/4" "clean leftovers"
  foreach ($d in @("plugin-workspace\ops-conventions", "plugin-workspace\legacy-ops")) {
    $p = Join-Path $zHome $d
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force; Write-Host "  removed $p" }
  }
  Write-Host "  (empty plugin-workspace folder is harmless; ZCode recreates it)" -ForegroundColor DarkGray

  Write-Host ""
  Write-Host "Removed. Everything is back to stock." -ForegroundColor Green
  if ($Restart) { Restart-ZCode } else { Write-Host "Restart ZCode to load the original bundle." -ForegroundColor Yellow }
}

function Invoke-Status {
  Assert-Prereqs
  $loc = Resolve-ZCode
  $exe = Find-ZCodeExe

  Write-Host "== BREACH status ==" -ForegroundColor Cyan
  Write-Host "node   : $NodeExe"
  Write-Host "zcode  : $(if ($exe) { $exe } else { '(not found)' })"
  Write-Host "bundle : $(if ($loc.Found) { $loc.BUNDLE } else { '(not found)' })"
  Write-Host "source : $($loc.SOURCE)"
  Write-Host "home   : $($loc.HOME)"
  Show-Warnings $loc

  if ($loc.Found) {
    Step "1/2" "host patches"
    Run-Node @($PatchTool, "status")
  } else {
    Step "1/2" "host patches"
    Write-Host "  skipped: bundle not located." -ForegroundColor Yellow
    Show-NotFound $loc
  }

  Step "2/2" "AGENTS.md payload"
  & $InstallPs1 -Action status

  Write-Host ""
  $procs = Get-Process -Name "ZCode" -ErrorAction SilentlyContinue
  if ($procs) {
    Write-Host "ZCode is RUNNING (pid $($procs.Id -join ', ')) - disk changes need a relaunch." -ForegroundColor Yellow
  } else {
    Write-Host "ZCode is not running - next launch loads the current state." -ForegroundColor Green
  }
}

switch ($Action) {
  "find"    { Invoke-Find }
  "install" { Invoke-Install }
  "remove"  { Invoke-Remove }
  "status"  { Invoke-Status }
}