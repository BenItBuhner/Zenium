# Lists the 7z coder ("Method") of every entry in the app payload ($PLUGINSDIR\app-<arch>.7z) that an
# electron-builder NSIS installer carries, using the runner's own 7-Zip.
#   payload-listing.ps1 -Installer <setup.exe> -Out <base path without extension>
# Writes <Out>.txt (human readable, with a per-method summary) and <Out>.json (entries).
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Scratch = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Scratch) { $Scratch = Join-Path ($(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP })) 'nsis-payload' }
$sevenZip = @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe', 'C:\ProgramData\chocolatey\bin\7z.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sevenZip) { $sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source }
if (-not $sevenZip) { throw 'no 7-Zip on this runner' }
$banner = (& $sevenZip | Select-Object -First 2 | Where-Object { $_ -match '7-Zip' }) -join ' '

if (Test-Path $Scratch) { Remove-Item -Path $Scratch -Recurse -Force }
New-Item -ItemType Directory -Path $Scratch -Force | Out-Null
& $sevenZip x -y "-o$Scratch" $Installer '$PLUGINSDIR\app-*.7z' | Out-Null
$inner = Get-ChildItem -Path $Scratch -Recurse -Filter 'app-*.7z' | Select-Object -First 1
if (-not $inner) {
  & $sevenZip x -y "-o$Scratch" $Installer | Out-Null
  $inner = Get-ChildItem -Path $Scratch -Recurse -Filter 'app-*.7z' | Select-Object -First 1
}
if (-not $inner) { throw "no app-*.7z inside $Installer" }

$lines = & $sevenZip l -slt $inner.FullName
$archiveMethod = ''
$entries = @()
$cur = $null
$inEntries = $false
foreach ($l in $lines) {
  if (-not $inEntries) {
    if ($l -match '^Method = (.*)$') { $archiveMethod = $Matches[1] }
    if ($l -match '^-{5,}$') { $inEntries = $true }
    continue
  }
  if ($l -match '^Path = (.*)$') {
    if ($cur) { $entries += $cur }
    $cur = [ordered]@{ path = $Matches[1]; size = 0; packed = 0; method = ''; isDir = $false }
  } elseif ($cur -and $l -match '^Size = (\d+)$') { $cur.size = [long]$Matches[1] }
  elseif ($cur -and $l -match '^Packed Size = (\d+)$') { $cur.packed = [long]$Matches[1] }
  elseif ($cur -and $l -match '^Method = (.*)$') { $cur.method = $Matches[1] }
  elseif ($cur -and $l -match '^Folder = \+') { $cur.isDir = $true }
  elseif ($cur -and $l -match '^Attributes = (.*)$' -and $Matches[1] -match '^D') { $cur.isDir = $true }
}
if ($cur) { $entries += $cur }

$files = @($entries | Where-Object { -not $_.isDir })
$report = @()
$report += "installer: $Installer ($([math]::Round((Get-Item $Installer).Length / 1MB, 1)) MB)"
$report += "payload: $($inner.Name) ($([math]::Round($inner.Length / 1MB, 1)) MB), archive-level Method = $archiveMethod"
$report += "listed with: $banner"
$report += "entries: $($entries.Count) ($($files.Count) files)"
$report += ''
$report += 'Per method:'
foreach ($g in ($files | Group-Object -Property method | Sort-Object -Property Count -Descending)) {
  $names = @($g.Group | ForEach-Object { $_.path })
  $shown = if ($names.Count -le 12) { $names -join ', ' } else { ($names[0..11] -join ', ') + ", ... ($($names.Count) files)" }
  $report += "  $($g.Name): $($g.Count) files: $shown"
}
$report += ''
$report += 'Method | Size | Path'
foreach ($e in ($files | Sort-Object -Property path)) { $report += "$($e.method) | $($e.size) | $($e.path)" }
$report | Set-Content -Path "$Out.txt" -Encoding UTF8
[ordered]@{ installer = $Installer; payload = $inner.Name; archiveMethod = $archiveMethod; sevenZip = $banner; entries = $entries } | ConvertTo-Json -Depth 4 | Set-Content -Path "$Out.json" -Encoding UTF8
$report | Select-Object -First ($report.IndexOf('Method | Size | Path')) | ForEach-Object { Write-Output $_ }
Remove-Item -Path $Scratch -Recurse -Force -ErrorAction SilentlyContinue
