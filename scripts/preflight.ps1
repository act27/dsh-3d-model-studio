# dsh-3d-model-studio — preflight checks
#
# Verifies the parts that break silently: required files present, JavaScript
# syntax valid, the engine chunk registers the expected exports, and the
# runtime dependencies resolve from this checkout.
#
# Usage:
#   pwsh -NoProfile -File .\scripts\preflight.ps1
#   pwsh -NoProfile -File .\scripts\preflight.ps1 -Check     # exit 1 on failure
[CmdletBinding()]
param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

if (-not $PackageRoot) {
  $PackageRoot = Split-Path -Parent $PSScriptRoot
}

$failures = New-Object System.Collections.Generic.List[string]

function Test-Pass([string]$Name, [string]$Detail) {
  Write-Host ("OK   {0,-42} {1}" -f $Name, $Detail) -ForegroundColor Green
}
function Test-Fail([string]$Name, [string]$Detail) {
  Write-Host ("FAIL {0,-42} {1}" -f $Name, $Detail) -ForegroundColor Red
  $failures.Add("$Name — $Detail")
}

# ---- 1) Required files ----
$required = @(
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'lib/index.js',
  'lib/convert.js',
  'lib/convert-worker.mjs',
  'lib/kit/env.js',
  'lib/kit/load.js',
  'lib/kit/textures.js',
  'lib/kit/index.js',
  'client/client.js',
  'client/client.three.js',
  'scripts/build-engine.mjs',
  'README.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md'
)
$missing = @()
foreach ($file in $required) {
  if (-not (Test-Path (Join-Path $PackageRoot $file))) { $missing += $file }
}
if ($missing.Count -eq 0) {
  Test-Pass 'required files' "$($required.Count) present"
} else {
  Test-Fail 'required files' "missing: $($missing -join ', ')"
}

# ---- 2) Manifest ----
try {
  $manifest = Get-Content (Join-Path $PackageRoot 'package.json') -Raw | ConvertFrom-Json
  $bundlePatch = $manifest.dsh.bundle.patch
  $clientPlatform = $manifest.dsh.client.platform
  if ($manifest.name -eq 'dsh-3d-model-studio' -and $bundlePatch -and $clientPlatform -eq 'web') {
    Test-Pass 'manifest' "$($manifest.name)@$($manifest.version) bundle=$bundlePatch client=$clientPlatform"
  } else {
    Test-Fail 'manifest' 'name/dsh.bundle.patch/dsh.client.platform are not what install_bundle expects'
  }
  $declared = @($manifest.files)
  foreach ($needed in @('client/client.js', 'client/client.three.js', 'lib/index.js', 'cordis.patch.yml')) {
    if ($declared -notcontains $needed) { Test-Fail 'files list' "$needed is not listed in package.json files" }
  }
} catch {
  Test-Fail 'manifest' $_.Exception.Message
}

# ---- 3) JavaScript syntax ----
$syntaxTargets = @(
  'lib/index.js',
  'lib/convert.js',
  'lib/convert-worker.mjs',
  'lib/kit/env.js',
  'lib/kit/load.js',
  'lib/kit/textures.js',
  'lib/kit/index.js',
  'client/client.js',
  'scripts/build-engine.mjs',
  'tests/plugin.test.mjs',
  'tests/client.test.mjs'
)
$syntaxFailures = @()
foreach ($file in $syntaxTargets) {
  $full = Join-Path $PackageRoot $file
  if (-not (Test-Path $full)) { continue }
  & node --check $full 2>$null
  if ($LASTEXITCODE -ne 0) { $syntaxFailures += $file }
}
if ($syntaxFailures.Count -eq 0) {
  Test-Pass 'JavaScript syntax' "$($syntaxTargets.Count) files parse"
} else {
  Test-Fail 'JavaScript syntax' ($syntaxFailures -join ', ')
}

# ---- 4) Engine chunk registration ----
$chunkVerifier = Join-Path $PackageRoot 'scripts/verify-chunk.mjs'
if (Test-Path $chunkVerifier) {
  $chunkResult = & node $chunkVerifier 2>&1
  if ($LASTEXITCODE -eq 0) {
    Test-Pass 'engine chunk' "$($chunkResult | Select-Object -Last 1)"
  } else {
    Test-Fail 'engine chunk' "$($chunkResult | Select-Object -Last 1)"
  }
} else {
  Test-Fail 'engine chunk' 'scripts/verify-chunk.mjs is missing'
}

# ---- 5) Runtime dependencies ----
$dependencyChecks = @(
  @{ Name = 'three'; File = 'node_modules/three/package.json' },
  @{ Name = '@comfyorg/fbx-exporter-three'; File = 'node_modules/@comfyorg/fbx-exporter-three/package.json' }
)
# NB: the loop variable must not be `$check` — PowerShell variable names are
# case-insensitive, so it would alias the [switch]$Check parameter above and
# fail with "cannot convert Hashtable to SwitchParameter".
foreach ($dependency in $dependencyChecks) {
  $full = Join-Path $PackageRoot $dependency.File
  if (Test-Path $full) {
    $version = (Get-Content $full -Raw | ConvertFrom-Json).version
    Test-Pass "dependency $($dependency.Name)" $version
  } else {
    Test-Fail "dependency $($dependency.Name)" 'not installed — run scripts/install.ps1'
  }
}
$canvasPath = Join-Path $PackageRoot 'node_modules/@napi-rs/canvas/package.json'
if (Test-Path $canvasPath) {
  Test-Pass 'optional dependency @napi-rs/canvas' ((Get-Content $canvasPath -Raw | ConvertFrom-Json).version)
} else {
  Write-Host "WARN optional dependency @napi-rs/canvas is absent — textured models export with textures stripped" -ForegroundColor Yellow
}

# ---- 6) Distribution tarball ----
$tarball = Get-ChildItem -Path (Join-Path $PackageRoot 'dist') -Filter '*.tgz' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -ne $tarball) {
  Test-Pass 'distribution tarball' "$($tarball.Name) ($([Math]::Round($tarball.Length / 1KB)) KB)"
} else {
  Write-Host "WARN no dist/*.tgz yet — run scripts/install.ps1 before installing the bundle" -ForegroundColor Yellow
}

Write-Host ""
if ($failures.Count -eq 0) {
  Write-Host "PREFLIGHT OK" -ForegroundColor Green
} else {
  Write-Host "PREFLIGHT FAILED ($($failures.Count))" -ForegroundColor Red
  foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
  if ($Check) { exit 1 }
}
