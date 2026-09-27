# Generates the raster brand assets from the master logo.
#
# Source: public/jknet_logo.png (846x846, opaque background).
# Output:
#   src-tauri/icons/source.png       1024x1024, input for `npm run tauri icon`
#   public/brand/jknet-logo-64.png   favicon
#   public/brand/jknet-logo-128.png  title bar and small marks
#   public/brand/jknet-logo-256.png  onboarding brand panel and larger marks
#   public/brand/jknet-logo-512.png  spare size for future surfaces
#   web/public/brand/jknet-logo-{64,128,256}.png
#                                    the same marks for the web app
#   web/public/icons/icon-180.png    Apple touch icon of the web app
#   web/public/icons/icon-192.png    manifest icon
#   web/public/icons/icon-512.png    manifest icon
#   web/public/icons/icon-512-maskable.png
#                                    manifest icon, purpose maskable: the logo
#                                    in the inner 80 % on the brand background,
#                                    so a round or squircle mask cuts no part
#                                    of the mark
#
# Every output is written as Format32bppArgb so the Tauri icon generator, which
# refuses non-RGBA input, accepts source.png. The background of the source is
# opaque and stays that way: no colour keying is attempted.
#
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts/make-brand-assets.ps1
# `-WebOnly` writes the web app's files alone and leaves the launcher's as
# they are.

[CmdletBinding()]
param(
    [switch] $WebOnly
)

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
# `-Inset` below 1 draws the logo that much smaller, centred on `-Background`:
# the safe zone of a maskable icon.
function Write-ScaledPng {
    param(
        [System.Drawing.Image] $Image,
        [int] $Side,
        [string] $Path,
        [double] $Inset = 1.0,
        [System.Drawing.Color] $Background = [System.Drawing.Color]::Transparent
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
            $inner = [int][Math]::Round($Side * $Inset)
            $offset = [int][Math]::Floor(($Side - $inner) / 2)
            if ($inner -lt $Side) {
                $graphics.Clear($Background)
                $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
            }
            $rect = New-Object System.Drawing.Rectangle($offset, $offset, $inner, $inner)
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

    if (-not $WebOnly) {
        Write-ScaledPng -Image $source -Side 1024 -Path (Join-Path $repoRoot 'src-tauri\icons\source.png')

        foreach ($side in 64, 128, 256, 512) {
            Write-ScaledPng -Image $source -Side $side -Path (Join-Path $repoRoot ('public\brand\jknet-logo-{0}.png' -f $side))
        }
    }

    # --- slice: web app ---
    foreach ($side in 64, 128, 256) {
        Write-ScaledPng -Image $source -Side $side -Path (Join-Path $repoRoot ('web\public\brand\jknet-logo-{0}.png' -f $side))
    }
    foreach ($side in 180, 192, 512) {
        Write-ScaledPng -Image $source -Side $side -Path (Join-Path $repoRoot ('web\public\icons\icon-{0}.png' -f $side))
    }
    $brand = [System.Drawing.Color]::FromArgb(255, $corner.R, $corner.G, $corner.B)
    Write-ScaledPng -Image $source -Side 512 -Inset 0.8 -Background $brand -Path (Join-Path $repoRoot 'web\public\icons\icon-512-maskable.png')
} finally {
    $source.Dispose()
    $sourceStream.Dispose()
}

Write-Host 'Done. Regenerate the app icons with: npm run tauri icon src-tauri/icons/source.png'
