# Generates the raster brand assets from the master logo.
#
# Source: public/jknet_logo.png (846x846, opaque background).
# Output:
#   src-tauri/icons/source.png       1024x1024, input for `npm run tauri icon`
#   public/brand/jknet-logo-64.png   favicon
#   public/brand/jknet-logo-128.png  title bar and small marks
#   public/brand/jknet-logo-256.png  onboarding brand panel and larger marks
#   public/brand/jknet-logo-512.png  spare size for future surfaces
#
# Every output is written as Format32bppArgb so the Tauri icon generator, which
# refuses non-RGBA input, accepts source.png. The background of the source is
# opaque and stays that way: no colour keying is attempted.
#
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts/make-brand-assets.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repoRoot 'public\jknet_logo.png'

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Master logo not found: $sourcePath"
}

# Read the file into memory first: Image.FromFile keeps a lock on the file for
# the lifetime of the object, and the master logo must stay writable.
$sourceBytes = [System.IO.File]::ReadAllBytes($sourcePath)
$sourceStream = New-Object System.IO.MemoryStream(, $sourceBytes)
$source = [System.Drawing.Image]::FromStream($sourceStream)

# Rescales the source into a square of the given side and writes a PNG.
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

        # Wrap mode TileFlipXY keeps the bicubic kernel from sampling
        # transparent pixels outside the bitmap and haloing the border.
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

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $target.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $target.Dispose()

    Write-Host ("  {0,4} px  {1}" -f $Side, (Resolve-Path -LiteralPath $Path).Path)
}

try {
    $corner = ([System.Drawing.Bitmap] $source).GetPixel(0, 0)
    $cornerHex = '#{0:X2}{1:X2}{2:X2}' -f $corner.R, $corner.G, $corner.B

    Write-Host "Source: $sourcePath"
    Write-Host ("  {0}x{1}, {2}, top-left pixel {3} (alpha {4})" -f $source.Width, $source.Height, $source.PixelFormat, $cornerHex, $corner.A)
    Write-Host 'Writing:'

    Write-ScaledPng -Image $source -Side 1024 -Path (Join-Path $repoRoot 'src-tauri\icons\source.png')

    foreach ($side in 64, 128, 256, 512) {
        Write-ScaledPng -Image $source -Side $side -Path (Join-Path $repoRoot ('public\brand\jknet-logo-{0}.png' -f $side))
    }
} finally {
    $source.Dispose()
    $sourceStream.Dispose()
}

Write-Host 'Done. Regenerate the app icons with: npm run tauri icon src-tauri/icons/source.png'
