# Packages the study folders into anonymised, batched zips for distribution.
#
#   .\prepare-batches.ps1 -Source "E:\dicom\train_images" -Out "E:\study-out"
#
# Produces two folders, so there is no way to mix them up:
#
#   <Out>\SEND-TO-DOCTORS\   everything the readers get - upload this whole folder
#   <Out>\KEEP-PRIVATE\      the case mapping - never leaves your machine
#
# Entries are written straight from the source files, so no second copy of the
# images is ever made on disk.

param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$BatchSize = 20,
  [int]$Seed = 20260918
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path $Source)) { throw "Source not found: $Source" }
$sendDir = Join-Path $Out "SEND-TO-DOCTORS"
$privDir = Join-Path $Out "KEEP-PRIVATE"
New-Item -ItemType Directory -Force -Path $sendDir, $privDir | Out-Null

Write-Host "scanning $Source ..."
$studies = Get-ChildItem $Source -Directory | ForEach-Object {
  $files = Get-ChildItem $_.FullName -File -Filter *.dcm
  if ($files.Count -gt 0) {
    [pscustomobject]@{
      Original = $_.Name
      Path     = $_.FullName
      Files    = $files
      Count    = $files.Count
      Bytes    = ($files | Measure-Object -Property Length -Sum).Sum
    }
  }
}

if (-not $studies) { throw "No folders containing .dcm files were found under $Source" }
Write-Host ("found {0} studies, {1:N1} GB total" -f $studies.Count, (($studies | Measure-Object -Property Bytes -Sum).Sum / 1GB))

# Shuffle so the case number carries no information about the original ordering.
$rnd = New-Object System.Random($Seed)
$shuffled = $studies | Sort-Object { $rnd.Next() }

$width = [Math]::Max(3, "$($shuffled.Count)".Length)
$i = 0
$mapping = foreach ($s in $shuffled) {
  $i++
  $caseId = "Case-" + $i.ToString("D$width")
  $s | Add-Member -NotePropertyName CaseId -NotePropertyValue $caseId -Force
  $s | Add-Member -NotePropertyName Batch  -NotePropertyValue ([Math]::Ceiling($i / $BatchSize)) -Force
  [pscustomobject]@{
    case_id         = $caseId
    original_folder = $s.Original
    batch           = $s.Batch
    slice_count     = $s.Count
    size_mb         = [Math]::Round($s.Bytes / 1MB, 1)
  }
}

$mapPath = Join-Path $privDir "PRIVATE-case-mapping.csv"
$mapping | Export-Csv -Path $mapPath -NoTypeInformation -Encoding UTF8
Write-Host "wrote $mapPath"

$batches = $shuffled | Group-Object Batch | Sort-Object { [int]$_.Name }
foreach ($b in $batches) {
  $zipPath = Join-Path $sendDir ("CASES-batch-{0}.zip" -f $b.Name)
  if (Test-Path $zipPath) { Write-Host "skip (exists): $zipPath"; continue }

  $tmp = "$zipPath.partial"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }

  Write-Host ("building batch {0}: {1} cases ..." -f $b.Name, $b.Count)
  $zip = [System.IO.Compression.ZipFile]::Open($tmp, 'Create')
  try {
    foreach ($s in $b.Group) {
      foreach ($f in $s.Files) {
        $entryName = "CASES/$($s.CaseId)/$($f.Name)"
        # DICOM pixel data is already compressed, so deflate would only cost time
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $zip, $f.FullName, $entryName, [System.IO.Compression.CompressionLevel]::NoCompression)
      }
      Write-Host ("  {0}  <-  {1}  ({2} slices)" -f $s.CaseId, $s.Original, $s.Count)
    }
  } finally { $zip.Dispose() }

  Move-Item $tmp $zipPath
  Write-Host ("  -> {0} ({1:N2} GB)" -f (Split-Path $zipPath -Leaf), ((Get-Item $zipPath).Length / 1GB))
}

$viewer = Join-Path $PSScriptRoot "dist\Ankylosis-Study.html"
if (Test-Path $viewer) {
  Copy-Item $viewer (Join-Path $sendDir "Ankylosis-Study.html") -Force
} else {
  Write-Host "NOTE: dist\Ankylosis-Study.html not found - run build.ps1 first"
}

$guide = Join-Path $PSScriptRoot "dist\How-to-use-this-viewer.pdf"
if (Test-Path $guide) {
  Copy-Item $guide (Join-Path $sendDir "How to use this viewer.pdf") -Force
} else {
  Write-Host "NOTE: dist\How-to-use-this-viewer.pdf not found - run build.ps1 first"
}

Write-Host ""
Write-Host "=================================================================="
Write-Host "  UPLOAD THIS FOLDER:   $sendDir"
Get-ChildItem $sendDir | ForEach-Object {
  Write-Host ("      {0,-26} {1,8:N2} GB" -f $_.Name, ($_.Length / 1GB))
}
Write-Host ""
Write-Host "  NEVER UPLOAD:         $privDir"
Write-Host "      PRIVATE-case-mapping.csv  - the only link back to the"
Write-Host "      original studies. Keep it on your own machine."
Write-Host "=================================================================="
