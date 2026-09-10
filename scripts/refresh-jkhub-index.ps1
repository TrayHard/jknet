# Rebuilds the JKHub catalogue index that ships inside the launcher.
#
# Source: the listing pages of every leaf category of jkhub.org, crawled by the
# same code the launcher uses (`jkhub::index::crawl`).
# Output:
#   src-tauri/resources/jkhub/index-ja.json   the Jedi Academy catalogue
#   src-tauri/resources/jkhub/index-jo.json   the Jedi Outcast catalogue
#
# Both files land in `resources/jkhub/`, which `bundle.resources` of
# `tauri.conf.json` already carries as a folder. They are what the **Browse
# JKHub** tab searches on a machine that has never crawled. Run this before a
# release, then commit the two files.
#
# Run `scripts/refresh-jkhub-categories.ps1` first: the crawl reads the bundled
# category tree to know which categories exist, so a stale tree ships a
# catalogue missing whatever category the site added since.
#
# The crawl costs one request per listing page, paced at one every 300 ms by
# the launcher's own limiter: about 150 for Jedi Academy and about 35 for Jedi
# Outcast, roughly a minute for the pair. Do not run it in a loop: jkhub.org is
# another project's server.
#
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts/refresh-jkhub-index.ps1
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
$test = 'jkhub::index::tests::live_rebuild_the_bundled_indexes'

if (-not (Test-Path -LiteralPath $coreDir)) {
    throw "Core folder not found: $coreDir"
}

# A terminal opened before Rust was installed does not have cargo on PATH.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path -LiteralPath $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) {
    $env:PATH = "$cargoBin;$env:PATH"
}

Write-Host "Crawling the JKHub catalogue of both games."
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
        throw "The crawl failed with exit code $LASTEXITCODE. The indexes were not replaced."
    }
}
finally {
    Pop-Location
}

Get-ChildItem -LiteralPath $outDir -Filter 'index-*.json' |
    ForEach-Object { Write-Host ("  {0}  {1} bytes" -f $_.Name, $_.Length) }

Write-Host "Done. Commit the two files with the change that needed them."
