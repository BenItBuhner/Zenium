# Install / locate / uninstall a Zenium NSIS build.
#   -Action install   -Installer <setup.exe> -Out <dir> [-Silent] [-Label <name>]
#       Runs the installer (silently with /S, or visibly while taking screenshots every 700 ms),
#       waits for it, finds the install location through the per-user Uninstall key and writes
#       <Out>/<Label>-install.json with the executable path.
#   -Action uninstall -Out <dir> [-Label <name>]
#       Runs "Uninstall <name>.exe /S _?=<dir>" from the Uninstall key and reports what is left.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Installer = '',
  [string]$Out = '.',
  [string]$Label = 'install',
  [switch]$Silent,
  [string]$Match = 'zen',
  [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path $Out -Force | Out-Null

function Find-UninstallEntry {
  foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
    foreach ($k in Get-ChildItem -Path $hive -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
      if ($p.DisplayName -match $Match -or $p.InstallLocation -match $Match -or $k.PSChildName -match $Match) {
        return [ordered]@{
          key = $k.PSPath -replace '^Microsoft\.PowerShell\.Core\\Registry::', ''
          displayName = $p.DisplayName; displayVersion = $p.DisplayVersion; publisher = $p.Publisher
          installLocation = $p.InstallLocation; uninstallString = $p.UninstallString; quietUninstallString = $p.QuietUninstallString
          displayIcon = $p.DisplayIcon; estimatedSize = $p.EstimatedSize; installDate = $p.InstallDate
          noModify = $p.NoModify; noRepair = $p.NoRepair
        }
      }
    }
  }
  return $null
}

function Resolve-InstallDir($entry) {
  if (-not $entry) { return $null }
  if ($entry.installLocation -and (Test-Path $entry.installLocation)) { return $entry.installLocation }
  $u = $entry.uninstallString -replace '^"(.*?)".*$', '$1'
  if ($u -and (Test-Path $u)) { return (Split-Path $u -Parent) }
  $guess = Join-Path $env:LOCALAPPDATA 'Programs\zen-chromium'
  if (Test-Path $guess) { return $guess }
  return $null
}

switch ($Action) {
  'install' {
    if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }
    $info = [ordered]@{ installer = (Resolve-Path $Installer).Path; silent = [bool]$Silent; sizeMB = [math]::Round((Get-Item $Installer).Length / 1MB, 1) }
    $sig = Get-AuthenticodeSignature -FilePath $Installer
    $info.authenticode = [ordered]@{ status = "$($sig.Status)"; statusMessage = $sig.StatusMessage; signer = "$($sig.SignerCertificate.Subject)" }
    $zone = Get-Content -Path $Installer -Stream Zone.Identifier -ErrorAction SilentlyContinue
    $info.markOfTheWeb = if ($zone) { ($zone -join ' | ') } else { 'none (no Zone.Identifier stream)' }
    $ver = (Get-Item $Installer).VersionInfo
    $info.versionInfo = [ordered]@{ productName = $ver.ProductName; fileVersion = $ver.FileVersion; productVersion = $ver.ProductVersion; company = $ver.CompanyName; description = $ver.FileDescription; copyright = $ver.LegalCopyright }
    $start = Get-Date
    $shots = @()
    if ($Silent) {
      $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
    } else {
      $p = Start-Process -FilePath $Installer -PassThru
    }
    $i = 0
    while (-not $p.HasExited -and ((Get-Date) - $start).TotalSeconds -lt $TimeoutSeconds) {
      if (-not $Silent) {
        $i++
        $file = Join-Path $Out ("{0}-installer-{1:D2}.png" -f $Label, $i)
        try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'win-screenshot.ps1') -Path $file | Out-Null; $shots += $file } catch {}
        Start-Sleep -Milliseconds 700
      } else {
        Start-Sleep -Milliseconds 500
      }
    }
    if (-not $p.HasExited) { $info.timedOut = $true; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    $p.WaitForExit()
    $info.exitCode = $p.ExitCode
    $info.durationSeconds = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    $info.installerScreenshots = $shots
    # A visible one-click installer launches the app when it finishes: give it a moment and record it.
    Start-Sleep -Seconds 4
    $launched = @(Get-Process -Name "$Match*" -ErrorAction SilentlyContinue)
    $info.appProcessesAfterInstall = @($launched | ForEach-Object { [ordered]@{ pid = $_.Id; path = $_.Path; title = $_.MainWindowTitle } })
    if ($launched.Count -and -not $Silent) {
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline -and -not (Get-Process -Name "$Match*" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) { Start-Sleep -Milliseconds 500 }
      Start-Sleep -Seconds 4
      $file = Join-Path $Out "$Label-auto-launched-after-install.png"
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'win-screenshot.ps1') -Path $file | Out-Null
      $info.autoLaunchScreenshot = $file
      $info.autoLaunchedWindowTitles = @(Get-Process -Name "$Match*" -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle } | Where-Object { $_ })
      Get-Process -Name "$Match*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    }
    $entry = Find-UninstallEntry
    $info.uninstallEntry = $entry
    # electron-builder's per-user key carries no InstallLocation: derive the directory from the
    # uninstaller path in UninstallString.
    $installDir = Resolve-InstallDir $entry
    $info.installDir = $installDir
    $exe = $null
    if ($installDir) {
      $exe = Get-ChildItem -Path $installDir -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^Uninstall' } | Select-Object -First 1 -ExpandProperty FullName
      $info.installDirEntries = @(Get-ChildItem -Path $installDir -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)/" } else { "$($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" } })
      $info.installSizeMB = [math]::Round((Get-ChildItem -Path $installDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
      $info.mainExePresent = Test-Path (Join-Path $installDir "$Match.exe")
    }
    if (-not $exe) {
      $guess = Join-Path $env:LOCALAPPDATA 'Programs'
      $exe = Get-ChildItem -Path $guess -Recurse -Filter "$Match*.exe" -Depth 2 -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^Uninstall' } | Select-Object -First 1 -ExpandProperty FullName
    }
    $info.exe = $exe
    if ($exe) {
      $v = (Get-Item $exe).VersionInfo
      $info.exeVersionInfo = [ordered]@{ productName = $v.ProductName; fileVersion = $v.FileVersion; productVersion = $v.ProductVersion; company = $v.CompanyName; description = $v.FileDescription }
      $esig = Get-AuthenticodeSignature -FilePath $exe
      $info.exeAuthenticode = "$($esig.Status)"
    }
    $info | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Out "$Label-install.json") -Encoding UTF8
    Write-Output ($info | ConvertTo-Json -Depth 6)
  }
  'uninstall' {
    $entry = Find-UninstallEntry
    $info = [ordered]@{ entryBefore = $entry }
    if (-not $entry) { Write-Output 'no uninstall entry found'; $info | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out "$Label-uninstall.json"); break }
    $uninstaller = $entry.uninstallString -replace '^"(.*?)".*$', '$1'
    $installDir = Resolve-InstallDir $entry
    if (-not (Test-Path $uninstaller) -and $installDir) { $uninstaller = Get-ChildItem -Path $installDir -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    $info.uninstaller = $uninstaller
    $info.installDir = $installDir
    Get-Process -Name "$Match*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
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
    Start-Sleep -Seconds 3
    $info.entryAfter = Find-UninstallEntry
    $info.installDirExists = if ($installDir) { Test-Path $installDir } else { $null }
    if ($info.installDirExists) { $info.installDirLeftovers = @(Get-ChildItem -Path $installDir -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName | Select-Object -First 40) }
    $info.shortcutsLeft = @(Get-ChildItem -Path ([Environment]::GetFolderPath('Programs')), ([Environment]::GetFolderPath('Desktop')) -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $Match } | Select-Object -ExpandProperty FullName)
    $info.appDataLeft = @(@((Join-Path $env:APPDATA 'Zen'), (Join-Path $env:LOCALAPPDATA 'zen-chromium-updater')) | Where-Object { Test-Path $_ })
    $info | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Out "$Label-uninstall.json") -Encoding UTF8
    Write-Output ($info | ConvertTo-Json -Depth 6)
  }
  default { throw "unknown action $Action" }
}
