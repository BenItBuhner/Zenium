# Dump the Chrome-style per-user browser registration Zenium's NSIS include writes.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label = 'registry'
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path $Out -Force | Out-Null
$log = Join-Path $Out "$Label.txt"

function Dump-Key([string]$Path) {
  "---- $Path ----"
  if (Test-Path $Path) {
    Get-ItemProperty -Path $Path -ErrorAction SilentlyContinue | Format-List | Out-String
    Get-ChildItem -Path $Path -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      "  $($_.PSPath -replace '^Microsoft\.PowerShell\.Core\\Registry::', '')"
      Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue | Format-List | Out-String
    }
  } else {
    "(missing)"
  }
}

$blocks = @(
  (Dump-Key 'HKCU:\Software\RegisteredApplications'),
  (Dump-Key 'HKCU:\Software\Clients\StartMenuInternet\Zenium'),
  (Dump-Key 'HKCU:\Software\Classes\ZeniumHTML'),
  (Dump-Key 'HKCU:\Software\Classes\.htm\OpenWithProgids'),
  (Dump-Key 'HKCU:\Software\Classes\.html\OpenWithProgids'),
  (Dump-Key 'HKCU:\Software\Classes\.pdf\OpenWithProgids')
)
$blocks -join "`n" | Set-Content -Path $log -Encoding UTF8
Write-Output $log
Get-Content $log
