# Bundles src/ + lib/ into a single self-contained HTML file that runs from file://,
# and renders the reader guide to PDF.
#
#   .\build.ps1
#
# Outputs:
#   dist\Ankylosis-Study.html          the viewer (one file, no dependencies)
#   dist\How-to-use-this-viewer.pdf    the illustrated guide for readers

param([string]$Root = $PSScriptRoot)

$src  = Join-Path $Root "src"
$lib  = Join-Path $Root "lib"
$dist = Join-Path $Root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# ---------------------------------------------------------------- viewer ----

$html = [IO.File]::ReadAllText((Join-Path $src "index.html"))
$css  = [IO.File]::ReadAllText((Join-Path $src "styles.css"))
$app  = [IO.File]::ReadAllText((Join-Path $src "app.js"))
$dp   = [IO.File]::ReadAllText((Join-Path $lib "dicomParser.min.js"))
$jll  = [IO.File]::ReadAllText((Join-Path $lib "lossless.cjs"))

# strip dev-only lines
$app = ($app -split "`r?`n" | Where-Object { $_ -notmatch '/\*\[dev\]\*/' }) -join "`r`n"

function Replace-Block([string]$text, [string]$name, [string]$replacement) {
  $pattern = "(?s)<!--\[$name\]-->.*?<!--\[/$name\]-->"
  return [regex]::Replace($text, $pattern, { param($m) $replacement })
}

$html = Replace-Block $html "styles" "<style>`r`n$css`r`n</style>"
$html = Replace-Block $html "libs" @"
<script>
$dp
</script>
<script>var module = { exports: {} }; var exports = module.exports;</script>
<script>
$jll
</script>
<script>var losslessLib = module.exports; module = undefined; exports = undefined;</script>
"@
$html = Replace-Block $html "app" "<script>`r`n$app`r`n</script>"

$viewerOut = Join-Path $dist "Ankylosis-Study.html"
[IO.File]::WriteAllText($viewerOut, $html, (New-Object Text.UTF8Encoding $false))
Write-Host ("built {0}  ({1:N1} KB)" -f (Split-Path $viewerOut -Leaf), ((Get-Item $viewerOut).Length / 1KB))

if ($html -match 'src="')      { Write-Host "  WARNING: external src= still present" }
if ($html -match '__study')    { Write-Host "  WARNING: dev hook still present" }

# ----------------------------------------------------------------- guide ----

$guideSrc = Join-Path $src "guide.html"
if (-not (Test-Path $guideSrc)) { return }

$guide = [IO.File]::ReadAllText($guideSrc)
foreach ($img in @(@{ tag = 'AXIAL'; file = 'axial.jpg' }, @{ tag = 'SAGITTAL'; file = 'sagittal.jpg' })) {
  $p = Join-Path $Root "assets\$($img.file)"
  if (Test-Path $p) {
    $uri = "data:image/jpeg;base64," + [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))
  } else {
    # Sample renders are not distributed with the repo - see README.
    $svg = "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='400'>" +
           "<rect width='300' height='400' fill='#1b1b20'/>" +
           "<text x='150' y='195' fill='#6a6a74' font-family='sans-serif' font-size='15' text-anchor='middle'>" +
           "$($img.tag) EXAMPLE</text>" +
           "<text x='150' y='218' fill='#4e4e57' font-family='sans-serif' font-size='11' text-anchor='middle'>" +
           "add assets/$($img.file)</text></svg>"
    $uri = "data:image/svg+xml;base64," + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($svg))
    Write-Host "  NOTE: assets\$($img.file) not found - guide will show a placeholder"
  }
  $guide = $guide.Replace("{{$($img.tag)}}", $uri)
}
if ($guide -match '\{\{') { Write-Host "  WARNING: unreplaced placeholder in guide" }

$guideHtml = Join-Path $dist "How-to-use-this-viewer.html"
[IO.File]::WriteAllText($guideHtml, $guide, (New-Object Text.UTF8Encoding $false))

# Render to PDF with whichever Chromium browser is installed.
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$guidePdf = Join-Path $dist "How-to-use-this-viewer.pdf"
if ($browser) {
  $tmpProfile = Join-Path $env:TEMP ("ankylosis-pdf-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  & $browser --headless=new --disable-gpu --no-first-run --no-default-browser-check `
             --user-data-dir="$tmpProfile" --no-pdf-header-footer `
             --print-to-pdf="$guidePdf" "file:///$($guideHtml -replace '\\','/')" | Out-Null
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $tmpProfile -Recurse -Force -ErrorAction SilentlyContinue

  if (Test-Path $guidePdf) {
    Write-Host ("built {0}  ({1:N1} KB)" -f (Split-Path $guidePdf -Leaf), ((Get-Item $guidePdf).Length / 1KB))
    Remove-Item -LiteralPath $guideHtml -Force
  } else {
    Write-Host "  WARNING: PDF render failed - open dist\How-to-use-this-viewer.html and print it manually"
  }
} else {
  Write-Host "  NOTE: no Chrome/Edge found - open dist\How-to-use-this-viewer.html and print to PDF manually"
}
