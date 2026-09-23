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
#
# Both actions read the default-browser registration build/installer.nsh writes for the user
# (ci-08) – the Chrome-style set Settings > Apps > Default apps lists a browser from – and judge
# it: after the install every key and value has to be there and point at the installed executable
# ("registrationProblems" in the JSON, exit 1 when any); after the uninstall every one of them has
# to be gone and no document type may still name the ProgID ("registrationLeftovers", exit 1 when
# any). The user's own http/https choice (UserChoice) is Windows's and is neither written nor read.
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

# --- Default-browser registration (build/installer.nsh registerDefaultBrowser) -----------------
# The names the installer uses: PRODUCT_NAME and APP_ID from electron-builder.yml, the ProgID and
# the document types of installer.nsh (its forEachExtension list; keep in step with it).
$ProductName = 'Zenium'
$ProgId = 'ZeniumHTML'
$AppUserModelId = 'io.github.benitbuhner.zenium'
$ClientKey = "Software\Clients\StartMenuInternet\$ProductName"
$CapabilitiesKey = "$ClientKey\Capabilities"
$ProgIdKey = "Software\Classes\$ProgId"
$Extensions = @('.htm', '.html', '.shtml', '.xht', '.xhtml', '.mhtml', '.mht', '.svg', '.webp', '.avif', '.pdf')

# The values named in `$names` under `$path` of the user's hive ('' for the key's default value),
# or $null when the key is not there. A value that is not there reads as $null; the key's value
# names come along as "(names)", so a value set to an empty string ("URL Protocol") can be told
# from a missing one.
function Read-UserKey([string]$path, [string[]]$names) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  if (-not $k) { return $null }
  try {
    $o = [ordered]@{}
    foreach ($n in $names) {
      $label = if ($n -eq '') { '(default)' } else { $n }
      $o[$label] = $k.GetValue($n, $null)
    }
    $o['(names)'] = @($k.GetValueNames())
    return $o
  } finally { $k.Close() }
}

# The registration as it stands, read from HKCU (the per-user installer's SHELL_CONTEXT): what
# RegisteredApplications says, the browser client key, its Capabilities, the ProgID, and every
# document type's OpenWithProgids and default ProgID. HKLM's RegisteredApplications entry is read
# too, for the record only (an /allusers install would write there; the smoke's does not).
function Get-BrowserRegistration {
  $reg = [ordered]@{
    registeredApplications = $null
    hklmRegisteredApplications = $null
    client = Read-UserKey $ClientKey @('')
    clientOpenCommand = Read-UserKey "$ClientKey\shell\open\command" @('')
    clientDefaultIcon = Read-UserKey "$ClientKey\DefaultIcon" @('')
    clientInstallInfo = Read-UserKey "$ClientKey\InstallInfo" @('IconsVisible', 'ReinstallCommand', 'HideIconsCommand', 'ShowIconsCommand')
    capabilities = Read-UserKey $CapabilitiesKey @('ApplicationName', 'ApplicationDescription', 'ApplicationIcon')
    startMenu = Read-UserKey "$CapabilitiesKey\StartMenu" @('StartMenuInternet')
    urlAssociations = Read-UserKey "$CapabilitiesKey\URLAssociations" @('http', 'https')
    fileAssociations = Read-UserKey "$CapabilitiesKey\FileAssociations" $Extensions
    progId = Read-UserKey $ProgIdKey @('', 'FriendlyTypeName', 'AppUserModelID', 'URL Protocol')
    progIdApplication = Read-UserKey "$ProgIdKey\Application" @('ApplicationName', 'ApplicationDescription', 'ApplicationIcon', 'AppUserModelID')
    progIdOpenCommand = Read-UserKey "$ProgIdKey\shell\open\command" @('')
    progIdDefaultIcon = Read-UserKey "$ProgIdKey\DefaultIcon" @('')
    documentTypes = [ordered]@{}
  }
  $ra = Read-UserKey 'Software\RegisteredApplications' @($ProductName)
  if ($ra) { $reg.registeredApplications = $ra[$ProductName] }
  $lm = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Software\RegisteredApplications')
  if ($lm) { try { $reg.hklmRegisteredApplications = $lm.GetValue($ProductName, $null) } finally { $lm.Close() } }
  foreach ($ext in $Extensions) {
    $openWith = Read-UserKey "Software\Classes\$ext\OpenWithProgids" @()
    $class = Read-UserKey "Software\Classes\$ext" @('')
    $reg.documentTypes[$ext] = [ordered]@{
      openWithLists = [bool]($openWith -and ($openWith['(names)'] -contains $ProgId))
      default = if ($class) { $class['(default)'] } else { $null }
    }
  }
  return $reg
}

# What is wrong with a registration that should be complete and point at `$exe`: one line per
# miss, empty when the installer left the set installer.nsh describes.
function Test-BrowserRegistered($reg, [string]$exe) {
  $problems = New-Object System.Collections.ArrayList
  # `$key` is the values read off one key ($null when the key is missing), `$checks` the value
  # label -> expected value pairs; a missing key is one line, each value off its own.
  $expect = {
    param([string]$where, $key, [hashtable]$checks)
    if ($null -eq $key) { [void]$problems.Add("HKCU\$where is missing"); return }
    foreach ($label in $checks.Keys) {
      $actual = $key[$label]
      if ($actual -ne $checks[$label]) {
        $shown = if ($null -eq $actual) { '<missing>' } else { "'$actual'" }
        [void]$problems.Add("HKCU\$where $label is $shown, expected '$($checks[$label])'")
      }
    }
  }
  if ($reg.registeredApplications -ne $CapabilitiesKey) {
    $shown = if ($null -eq $reg.registeredApplications) { '<missing>' } else { "'$($reg.registeredApplications)'" }
    [void]$problems.Add("HKCU\Software\RegisteredApplications $ProductName is $shown, expected '$CapabilitiesKey'")
  }
  & $expect $ClientKey $reg.client @{ '(default)' = $ProductName }
  & $expect "$ClientKey\shell\open\command" $reg.clientOpenCommand @{ '(default)' = "`"$exe`"" }
  & $expect "$ClientKey\DefaultIcon" $reg.clientDefaultIcon @{ '(default)' = "$exe,0" }
  & $expect "$ClientKey\InstallInfo" $reg.clientInstallInfo @{ 'IconsVisible' = 1 }
  & $expect $CapabilitiesKey $reg.capabilities @{ 'ApplicationName' = $ProductName; 'ApplicationIcon' = "$exe,0" }
  if ($reg.capabilities -and -not $reg.capabilities['ApplicationDescription']) { [void]$problems.Add("HKCU\$CapabilitiesKey ApplicationDescription is empty") }
  & $expect "$CapabilitiesKey\StartMenu" $reg.startMenu @{ 'StartMenuInternet' = $ProductName }
  & $expect "$CapabilitiesKey\URLAssociations" $reg.urlAssociations @{ 'http' = $ProgId; 'https' = $ProgId }
  $fileChecks = @{}
  foreach ($ext in $Extensions) { $fileChecks[$ext] = $ProgId }
  & $expect "$CapabilitiesKey\FileAssociations" $reg.fileAssociations $fileChecks
  & $expect $ProgIdKey $reg.progId @{ '(default)' = "$ProductName HTML Document"; 'FriendlyTypeName' = "$ProductName HTML Document"; 'AppUserModelID' = $AppUserModelId }
  if ($reg.progId -and ($reg.progId['(names)'] -notcontains 'URL Protocol')) { [void]$problems.Add("HKCU\$ProgIdKey lacks the 'URL Protocol' value") }
  & $expect "$ProgIdKey\Application" $reg.progIdApplication @{ 'ApplicationName' = $ProductName; 'AppUserModelID' = $AppUserModelId }
  & $expect "$ProgIdKey\shell\open\command" $reg.progIdOpenCommand @{ '(default)' = "`"$exe`" `"%1`"" }
  & $expect "$ProgIdKey\DefaultIcon" $reg.progIdDefaultIcon @{ '(default)' = "$exe,0" }
  foreach ($ext in $Extensions) {
    if (-not $reg.documentTypes[$ext].openWithLists) { [void]$problems.Add("HKCU\Software\Classes\$ext\OpenWithProgids does not list $ProgId") }
  }
  return @($problems.ToArray())
}

# What a removed registration still holds: one line per leftover, empty when the uninstaller took
# everything installer.nsh's unregisterDefaultBrowser names and no document type still points at
# the ProgID.
function Test-BrowserUnregistered($reg) {
  $left = @()
  if ($null -ne $reg.registeredApplications) { $left += "RegisteredApplications\$ProductName is still '$($reg.registeredApplications)'" }
  foreach ($pair in @(@('client', $ClientKey), @('capabilities', $CapabilitiesKey), @('urlAssociations', "$CapabilitiesKey\URLAssociations"), @('progId', $ProgIdKey), @('progIdOpenCommand', "$ProgIdKey\shell\open\command"))) {
    if ($reg[$pair[0]]) { $left += "HKCU\$($pair[1]) is still there" }
  }
  foreach ($ext in $Extensions) {
    $t = $reg.documentTypes[$ext]
    if ($t.openWithLists) { $left += "Software\Classes\$ext\OpenWithProgids still lists $ProgId" }
    if ($t.default -eq $ProgId) { $left += "Software\Classes\$ext still defaults to $ProgId" }
  }
  return @($left)
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
    $info.binaries = @(Get-Binaries $installDir)
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
    # The default-browser registration (ci-08): every key and value of installer.nsh's set, the
    # commands and icons pointing at the installed executable.
    $info.registration = Get-BrowserRegistration
    $info.registrationProblems = @(Test-BrowserRegistered $info.registration $exe)
    $info | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Out "$Label-install.json") -Encoding UTF8
    Write-Output ($info | ConvertTo-Json -Depth 6)
    if ($info.timedOut -or $info.exitCode -ne 0 -or $info.registrationProblems.Count -gt 0) { exit 1 }
  }
  'uninstall' {
    $entry = Find-UninstallEntry
    $info = [ordered]@{ entryBefore = $entry; registrationBefore = Get-BrowserRegistration }
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
    # The default-browser registration after the uninstall (ci-08): nothing of it left.
    $info.registrationAfter = Get-BrowserRegistration
    $info.registrationLeftovers = @(Test-BrowserUnregistered $info.registrationAfter)
    $info | ConvertTo-Json -Depth 6 | Set-Content -Path $file -Encoding UTF8
    Write-Output ($info | ConvertTo-Json -Depth 6)
    if ($info.exitCode -ne 0 -or $info.registrationLeftovers.Count -gt 0) { exit 1 }
  }
  default { throw "unknown action $Action" }
}
