# Install / uninstall a Zenium NSIS build silently and report where it landed.
#   -Action install   -Installer <setup.exe> -Out <dir> [-Label <name>]
#       Runs "<setup.exe> /S", waits for it, finds the install directory through the per-user
#       Uninstall key and writes <Out>/<Label>-install.json. Its "exe" field is the path the
#       installed executable must have (LOCALAPPDATA\Programs\zenium\zenium.exe), whether or not the
#       installer actually wrote it: the smoke harness turns a missing executable into an "install"
#       failure the allowlist can name.
#   -Action uninstall -Out <dir> [-Label <name>]
#       Runs the registered uninstaller with "/currentuser /S _?=<dir>" and reports what is left.
#       Exits 1 when the uninstaller fails; exits 0 when there is nothing to uninstall.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Installer = '',
  [string]$Out = '.',
  [string]$Label = 'installed',
  [string]$Match = 'zenium',
  [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path $Out -Force | Out-Null
$defaultDir = Join-Path $env:LOCALAPPDATA "Programs\$Match"

function Find-UninstallEntry {
  foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
    foreach ($k in Get-ChildItem -Path $hive -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
      if ($p.DisplayName -match $Match -or $p.InstallLocation -match $Match -or $k.PSChildName -match $Match) {
        return [ordered]@{
          key = $k.PSPath -replace '^Microsoft\.PowerShell\.Core\\Registry::', ''
          displayName = $p.DisplayName; displayVersion = $p.DisplayVersion; publisher = $p.Publisher
          installLocation = $p.InstallLocation; uninstallString = $p.UninstallString; quietUninstallString = $p.QuietUninstallString
          displayIcon = $p.DisplayIcon; estimatedSize = $p.EstimatedSize
        }
      }
    }
  }
  return $null
}

# electron-builder's per-user key may carry no InstallLocation: derive the directory from the
# uninstaller path in UninstallString, then fall back to the default per-user location.
function Resolve-InstallDir($entry) {
  if ($entry) {
    if ($entry.installLocation -and (Test-Path $entry.installLocation)) { return $entry.installLocation }
    $u = $entry.uninstallString -replace '^"(.*?)".*$', '$1'
    if ($u -and (Test-Path $u)) { return (Split-Path $u -Parent) }
  }
  if (Test-Path $defaultDir) { return $defaultDir }
  return $null
}

function Get-Binaries($dir) {
  if (-not $dir) { return @() }
  @(Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object { "$($_.Name):$([math]::Round($_.Length / 1MB, 1))MB" })
}

switch ($Action) {
  'install' {
    if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }
    $ver = (Get-Item $Installer).VersionInfo
    $info = [ordered]@{
      installer = (Resolve-Path $Installer).Path
      sizeMB = [math]::Round((Get-Item $Installer).Length / 1MB, 1)
      versionInfo = [ordered]@{ productName = $ver.ProductName; fileVersion = $ver.FileVersion; productVersion = $ver.ProductVersion; company = $ver.CompanyName }
      authenticode = "$((Get-AuthenticodeSignature -FilePath $Installer).Status)"
    }
    $start = Get-Date
    $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
      $info.timedOut = $true
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      $p.WaitForExit()
    }
    $info.exitCode = $p.ExitCode
    $info.durationSeconds = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    # A one-click installer launches the app when it finishes (runAfterFinish); the smoke wants to
    # launch it itself, with its own profile and hooks.
    Start-Sleep -Seconds 3
    $launched = @(Get-Process -Name "$Match*" -ErrorAction SilentlyContinue)
    $info.appProcessesAfterInstall = @($launched | ForEach-Object { [ordered]@{ pid = $_.Id; path = $_.Path } })
    if ($launched.Count) {
      $launched | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    }
    $entry = Find-UninstallEntry
    $info.uninstallEntry = $entry
    $installDir = Resolve-InstallDir $entry
    if (-not $installDir) { $installDir = $defaultDir }
    $info.installDir = $installDir
    $info.installDirExists = Test-Path $installDir
    $info.binaries = Get-Binaries $installDir
    $info.installDirEntries = @(Get-ChildItem -Path $installDir -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)/" } else { "$($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" } })
    $info.installSizeMB = [math]::Round((Get-ChildItem -Path $installDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
    $exe = Join-Path $installDir "$Match.exe"
    $info.exe = $exe
    $info.mainExePresent = Test-Path $exe
    if ($info.mainExePresent) {
      $v = (Get-Item $exe).VersionInfo
      $info.exeVersionInfo = [ordered]@{ productName = $v.ProductName; fileVersion = $v.FileVersion; productVersion = $v.ProductVersion }
    }
    $info.shortcuts = @(Get-ChildItem -Path ([Environment]::GetFolderPath('Programs')), ([Environment]::GetFolderPath('Desktop')) -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $Match } | Select-Object -ExpandProperty FullName)
    $info | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Out "$Label-install.json") -Encoding UTF8
    Write-Output ($info | ConvertTo-Json -Depth 6)
    if ($info.timedOut -or $info.exitCode -ne 0) { exit 1 }
  }
  'uninstall' {
    $entry = Find-UninstallEntry
    $info = [ordered]@{ entryBefore = $entry }
    $file = Join-Path $Out "$Label-uninstall.json"
    Get-Process -Name "$Match*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $installDir = Resolve-InstallDir $entry
    $info.installDir = $installDir
    $uninstaller = $null
    if ($entry) { $uninstaller = $entry.uninstallString -replace '^"(.*?)".*$', '$1' }
    if ((-not $uninstaller -or -not (Test-Path $uninstaller)) -and $installDir) {
      $uninstaller = Get-ChildItem -Path $installDir -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    }
    $info.uninstaller = $uninstaller
    if (-not $uninstaller) {
      $info.note = 'nothing to uninstall (no Uninstall key and no uninstaller on disk)'
      $info | ConvertTo-Json -Depth 6 | Set-Content -Path $file -Encoding UTF8
      Write-Output ($info | ConvertTo-Json -Depth 6)
      break
    }
    Start-Sleep -Seconds 1
    $start = Get-Date
    # QuietUninstallString is "<uninstaller> /currentuser /S"; _?= makes the NSIS uninstaller run in
    # place instead of a copy in %TEMP%, so -Wait really waits (an empty _?= aborts with exit code 2).
    $uninstallArgs = @('/currentuser', '/S')
    if ($installDir) { $uninstallArgs += "_?=$installDir" }
    $info.arguments = $uninstallArgs
    $p = Start-Process -FilePath $uninstaller -ArgumentList $uninstallArgs -PassThru -Wait
    $info.exitCode = $p.ExitCode
    $info.durationSeconds = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    Start-Sleep -Seconds 2
    $info.entryAfter = Find-UninstallEntry
    $info.installDirExists = if ($installDir) { Test-Path $installDir } else { $null }
    # Run in place, the uninstaller cannot delete its own executable; anything else left is a leak.
    if ($info.installDirExists) { $info.installDirLeftovers = @(Get-ChildItem -Path $installDir -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName | Select-Object -First 40) }
    $info.shortcutsLeft = @(Get-ChildItem -Path ([Environment]::GetFolderPath('Programs')), ([Environment]::GetFolderPath('Desktop')) -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $Match } | Select-Object -ExpandProperty FullName)
    $info | ConvertTo-Json -Depth 6 | Set-Content -Path $file -Encoding UTF8
    Write-Output ($info | ConvertTo-Json -Depth 6)
    if ($info.exitCode -ne 0) { exit 1 }
  }
  default { throw "unknown action $Action" }
}
