# dsh-3d-model-studio — install helper
#
# Prepares a distribution tarball for the bundle install performed by the
# Harness itself. This script deliberately does NOT touch the profile: the
# profile's package.json / cordis.patch.yml are owned by the plugin manager.
#
#   1. installs the package's runtime dependencies into this checkout (needed
#      by the regression tests and by `scripts/preflight.ps1`),
#   2. packs `dist/dsh-3d-model-studio-<version>.tgz`,
#   3. prints the exact plugin_manager call that installs it.
#
# A tarball install (rather than a directory link) is what puts the runtime
# dependencies into the profile, so the source directory can later be moved or
# deleted without breaking the installed plugin.
#
# Usage:
#   pwsh -NoProfile -File .\scripts\install.ps1
#   pwsh -NoProfile -File .\scripts\install.ps1 -SkipDeps     # reuse existing node_modules
[CmdletBinding()]
param(
  [switch]$SkipDeps
)

$ErrorActionPreference = 'Stop'

if (-not $PackageRoot) {
  $PackageRoot = Split-Path -Parent $PSScriptRoot
}

Write-Host "package root: $PackageRoot"

if (-not $SkipDeps) {
  Write-Host "installing runtime dependencies (three, FBX exporter, optional canvas)..."
  Push-Location $PackageRoot
  try {
    npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

$distDir = Join-Path $PackageRoot 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Get-ChildItem -Path $distDir -Filter '*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "packing tarball..."
Push-Location $PackageRoot
try {
  npm pack --pack-destination $distDir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm pack failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$tarball = Get-ChildItem -Path $distDir -Filter '*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $tarball) { throw "no tarball was produced in $distDir" }

Write-Host ""
Write-Host "tarball: $($tarball.FullName) ($([Math]::Round($tarball.Length / 1KB)) KB)"
Write-Host ""
Write-Host "Install it in the Harness (do not edit the profile by hand):"
Write-Host ""
Write-Host "  plugin_manager action=install_bundle target=`"$($tarball.FullName)`""
Write-Host ""
Write-Host "Then restart DSH so the Host half and the client bundle load the new generation."
Write-Host "If an older dsh-3d-model-preview bundle is still enabled, disable it so only one"
Write-Host "3D document preview claims .glb/.gltf/... (both register with the same priority)."
