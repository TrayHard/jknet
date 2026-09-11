# Rebuilds the engine icons in public/brand/engines/ from the upstream projects.
#
# One file per engine, named after the engine id in src-tauri/src/engines.rs, so
# the frontend finds it by convention: public/brand/engines/<engineId>.png.
#
#   Engine id   Source (branch master)                                Frame used
#   openjk      JACoders/OpenJK    shared/icons/PNG/mp128.png          128x128 PNG
#   eternaljk   eternalcodes/EternalJK shared/icons/icon.ico           128x128 of 6
#   taystjk     taysta/TaystJK     shared/icons/TaystJK_Icon1_1024.png 1024x1024 PNG
#   jamme       entdark/jaMME      codemp/win32/icon.ico               32x32 of 2
#   jk2mv       mvdevs/jk2mv       res/org.mvdevs.jk2mv.256.png        256x256 PNG
#
# The EternalJK file also carries a 256x256 frame, but System.Drawing hands
# back the 128x128 one for a 256 px request; 128 px is the target anyway, so
# that frame is copied without resampling at all.
#
# Every output is Format32bppArgb, so an icon with a transparent background
# stays transparent over the card. The target side is 128 px, but the script
# never upscales: jaMME ships no frame larger than 32x32, and blowing it up to
# 128 would only bake in the blur the browser would otherwise apply once.
#
# All five projects are GPL-2.0. The About card on the Settings screen names
# every project and links to its repository.
#
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts/make-engine-icons.ps1
#
# -SourceDir uses files already on disk instead of downloading them; the names
# are the ones in the table below. -DryRun prints the plan and writes nothing.

[CmdletBinding()]
param(
    [string] $SourceDir,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoRoot 'public\brand\engines'

# Longest side of an output file. Sources smaller than this keep their size.
$targetSide = 128

$sources = @(
    [pscustomobject]@{
        Id   = 'openjk'
        File = 'openjk-mp128.png'
        Url  = 'https://raw.githubusercontent.com/JACoders/OpenJK/master/shared/icons/PNG/mp128.png'
    }
    [pscustomobject]@{
        Id   = 'eternaljk'
        File = 'eternaljk-icon.ico'
        Url  = 'https://raw.githubusercontent.com/eternalcodes/EternalJK/master/shared/icons/icon.ico'
    }
    [pscustomobject]@{
        Id   = 'taystjk'
        File = 'taystjk-icon1-1024.png'
        Url  = 'https://raw.githubusercontent.com/taysta/TaystJK/master/shared/icons/TaystJK_Icon1_1024.png'
    }
    [pscustomobject]@{
        Id   = 'jamme'
        File = 'jamme-icon.ico'
        Url  = 'https://raw.githubusercontent.com/entdark/jaMME/master/codemp/win32/icon.ico'
    }
    [pscustomobject]@{
        Id   = 'jk2mv'
        File = 'jk2mv-256.png'
        Url  = 'https://raw.githubusercontent.com/mvdevs/jk2mv/master/res/org.mvdevs.jk2mv.256.png'
    }
)

# Reads a source file as a bitmap. An .ico carries several frames, so the
# largest one is asked for by name: System.Drawing hands back the frame closest
# to the requested size, which is the biggest one the file has when nothing
# matches 256 px.
function Read-SourceBitmap {
    param([string] $Path)

    if ([System.IO.Path]::GetExtension($Path) -ieq '.ico') {
        $icon = New-Object System.Drawing.Icon($Path, (New-Object System.Drawing.Size(256, 256)))
        try {
            # ToBitmap applies the AND mask of an old 4- or 8-bit frame, so a
            # 32x32 icon from 2013 arrives with an alpha channel too.
            return $icon.ToBitmap()
        } finally {
            $icon.Dispose()
        }
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $stream = New-Object System.IO.MemoryStream(, $bytes)
    return [System.Drawing.Image]::FromStream($stream)
}

# Writes a square PNG of the given side with the alpha channel preserved.
function Write-ScaledPng {
    param(
        [System.Drawing.Image] $Image,
        [int] $Side,
        [string] $Path
    )

    $target = New-Object System.Drawing.Bitmap($Side, $Side, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $target.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($target)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        # TileFlipXY keeps the bicubic kernel from sampling transparent pixels
        # outside the bitmap and haloing the border.
        $attributes = New-Object System.Drawing.Imaging.ImageAttributes
        try {
            $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $rect = New-Object System.Drawing.Rectangle(0, 0, $Side, $Side)
            $graphics.DrawImage($Image, $rect, 0, 0, $Image.Width, $Image.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        } finally {
            $attributes.Dispose()
        }
    } finally {
        $graphics.Dispose()
    }

    $target.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $target.Dispose()
}

if ($DryRun) {
    Write-Host "Would write into $outputDir"
    foreach ($source in $sources) {
        $from = if ($SourceDir) { Join-Path $SourceDir $source.File } else { $source.Url }
        Write-Host ("  {0}.png  <- {1}" -f $source.Id, $from)
    }
    return
}

if (-not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$downloads = $null
if (-not $SourceDir) {
    $downloads = Join-Path ([System.IO.Path]::GetTempPath()) ('jknet-engine-icons-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $downloads -Force | Out-Null
}

try {
    foreach ($source in $sources) {
        if ($SourceDir) {
            $path = Join-Path $SourceDir $source.File
            if (-not (Test-Path -LiteralPath $path)) {
                throw "Source not found: $path"
            }
        } else {
            $path = Join-Path $downloads $source.File
            Write-Host ("Downloading {0}" -f $source.Url)
            Invoke-WebRequest -Uri $source.Url -OutFile $path -UseBasicParsing
        }

        $image = Read-SourceBitmap -Path $path
        try {
            # Never upscale: a 32x32 icon stretched to 128 px is blur baked
            # into a file, and the browser would scale it anyway.
            $side = [Math]::Min($targetSide, [Math]::Min($image.Width, $image.Height))
            $output = Join-Path $outputDir ('{0}.png' -f $source.Id)
            Write-ScaledPng -Image $image -Side $side -Path $output
            Write-Host ("  {0,-10} {1}x{2} -> {3} px  {4} bytes" -f $source.Id, $image.Width, $image.Height, $side, (Get-Item -LiteralPath $output).Length)
        } finally {
            $image.Dispose()
        }
    }
} finally {
    if ($downloads -and (Test-Path -LiteralPath $downloads)) {
        Remove-Item -LiteralPath $downloads -Recurse -Force
    }
}

Write-Host 'Done.'
