# Dump the Chrome-style per-user browser registration Zenium's NSIS include writes.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Label = 'registry'
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path $Out -Force | Out-Null
$log = Join-Path $Out "$Label.txt"
$keys = @(
  'HKCU\Software\RegisteredApplications',
  'HKCU\Software\Clients\StartMenuInternet\Zenium',
  'HKCU\Software\Classes\ZeniumHTML',
  'HKCU\Software\Classes\.htm\OpenWithProgids',
  'HKCU\Software\Classes\.html\OpenWithProgids',
  'HKCU\Software\Classes\.pdf\OpenWithProgids'
)
$chunks = foreach ($k in $keys) {
  "==== $k ===="
  & reg.exe query $k /s 2>&1 | Out-String
}
Set-Content -Path $log -Value ($chunks -join "`n") -Encoding UTF8
Write-Output $log
Get-Content $log
