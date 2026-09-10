# Rebuilds the JKHub category snapshots that ship inside the launcher.
#
# Source: the public pages of jkhub.org, walked by the same code the launcher
# uses (`jkhub::source::crawl_tree`).
# Output:
#   src-tauri/resources/jkhub/categories-ja.json   the Jedi Academy tree
#   src-tauri/resources/jkhub/categories-jo.json   the Jedi Outcast tree
#
# Both files are registered in `bundle.resources` of `tauri.conf.json` and are
# what the tab renders from on a machine whose cache is empty. Run this before
# a release, then commit the two files.
#
# The walk costs about twenty requests per game, paced at one every 300 ms by
# the launcher's own limiter, and takes under a minute. Do not run it in a
# loop: jkhub.org is another project's server.
#
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts/refresh-jkhub-categories.ps1
#
# -DryRun prints the command and the target files and changes nothing.

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$coreDir = Join-Path $repoRoot 'src-tauri'
$outDir = Join-Path $coreDir 'resources\jkhub'
$test = 'jkhub::snapshot::tests::live_rebuild_the_bundled_snapshots'

if (-not (Test-Path -LiteralPath $coreDir)) {
    throw "Core folder not found: $coreDir"
}

# A terminal opened before Rust was installed does not have cargo on PATH.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path -LiteralPath $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) {
    $env:PATH = "$cargoBin;$env:PATH"
}

Write-Host "Walking the JKHub category tree of both games."
Write-Host "  test:   $test"
Write-Host "  output: $outDir"

if ($DryRun) {
    Write-Host "Dry run: cargo test --lib -- --ignored --nocapture $test (in $coreDir)"
    exit 0
}

Push-Location $coreDir
try {
    & cargo test --lib -- --ignored --nocapture $test
    if ($LASTEXITCODE -ne 0) {
        throw "The walk failed with exit code $LASTEXITCODE. The snapshots were not replaced."
    }
}
finally {
    Pop-Location
}

Get-ChildItem -LiteralPath $outDir -Filter 'categories-*.json' |
    ForEach-Object { Write-Host ("  {0}  {1} bytes" -f $_.Name, $_.Length) }

Write-Host "Done. Commit the two files with the change that needed them."
