# Windows OS-integration facts for a Zenium build: registry (RegisteredApplications, Classes,
# Uninstall, App Paths, URL associations, notification registrations), Start Menu / Desktop
# shortcuts with their AppUserModelIDs, Get-StartApps, OS/display/session facts.
#   -Out <dir> -Label <name>            write <dir>/<Label>-facts.json (+ .txt summary)
#   -Snapshot <file>                    write a registry key-name snapshot for later diffing
#   -DiffAgainst <file>                 include the keys that appeared since that snapshot
param(
  [string]$Out = '.',
  [string]$Label = 'facts',
  [string]$Snapshot = '',
  [string]$DiffAgainst = '',
  [string]$Match = 'zen'
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path $Out -Force | Out-Null

function Get-ChildNames([string]$path) {
  try { return @(Get-ChildItem -Path $path -ErrorAction Stop | ForEach-Object { $_.PSChildName }) } catch { return @() }
}

function Get-Props([string]$path) {
  try {
    $p = Get-ItemProperty -Path $path -ErrorAction Stop
    $h = [ordered]@{}
    foreach ($prop in $p.PSObject.Properties) {
      if ($prop.Name -like 'PS*') { continue }
      $h[$prop.Name] = "$($prop.Value)"
    }
    return $h
  } catch { return $null }
}

$snapshotPaths = @(
  'HKCU:\Software',
  'HKCU:\Software\Classes',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths',
  'HKCU:\Software\Clients\StartMenuInternet',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings',
  'HKCU:\Software\Classes\AppUserModelId',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\Clients\StartMenuInternet',
  'HKLM:\SOFTWARE\Classes\AppUserModelId'
)

if ($Snapshot) {
  $snap = [ordered]@{}
  foreach ($p in $snapshotPaths) { $snap[$p] = Get-ChildNames $p }
  $snap['HKCU:\Software\RegisteredApplications'] = @((Get-Props 'HKCU:\Software\RegisteredApplications').Keys)
  $snap['HKLM:\SOFTWARE\RegisteredApplications'] = @((Get-Props 'HKLM:\SOFTWARE\RegisteredApplications').Keys)
  $snap | ConvertTo-Json -Depth 4 | Set-Content -Path $Snapshot -Encoding UTF8
  Write-Output "snapshot written to $Snapshot"
  return
}

$facts = [ordered]@{}
$facts.label = $Label
$facts.capturedAt = (Get-Date).ToString('o')

# --- OS, session, display -----------------------------------------------------------------------
$nt = Get-Props 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$facts.os = [ordered]@{
  productName = $nt.ProductName; displayVersion = $nt.DisplayVersion; currentBuild = $nt.CurrentBuild; ubr = $nt.UBR
  editionId = $nt.EditionId; installationType = $nt.InstallationType; osVersion = [Environment]::OSVersion.VersionString
  is64 = [Environment]::Is64BitOperatingSystem; arch = $env:PROCESSOR_ARCHITECTURE; user = $env:USERNAME
  userInteractive = [Environment]::UserInteractive; session = (& query session 2>$null | Out-String).Trim()
}
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  $facts.display = [ordered]@{
    screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ device = $_.DeviceName; primary = $_.Primary; bounds = "$($_.Bounds)"; workingArea = "$($_.WorkingArea)"; bitsPerPixel = $_.BitsPerPixel } })
    dpiX = $g.DpiX; dpiY = $g.DpiY
    virtualScreen = "$([System.Windows.Forms.SystemInformation]::VirtualScreen)"
  }
  $g.Dispose()
} catch { $facts.display = @{ error = "$_" } }
$facts.theme = Get-Props 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$facts.smartScreen = [ordered]@{
  explorer = Get-Props 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer'
  policies = Get-Props 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'
  appInstallControl = Get-Props 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SmartScreen'
}
$facts.userChoice = [ordered]@{
  http = Get-Props 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
  https = Get-Props 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
  html = Get-Props 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.html\UserChoice'
}

# --- Registry facts -----------------------------------------------------------------------------
$reg = [ordered]@{}
$ra = Get-Props 'HKCU:\Software\RegisteredApplications'
$reg.registeredApplicationsHKCU = $ra
$reg.registeredApplicationsHKCUMatching = @($ra.Keys | Where-Object { $_ -match $Match -or $ra[$_] -match $Match })
$raM = Get-Props 'HKLM:\SOFTWARE\RegisteredApplications'
$reg.registeredApplicationsHKLMMatching = @($raM.Keys | Where-Object { $_ -match $Match -or $raM[$_] -match $Match })
$reg.classesHKCUMatching = @(Get-ChildNames 'HKCU:\Software\Classes' | Where-Object { $_ -match $Match })
$reg.classesApplicationsMatching = @(Get-ChildNames 'HKCU:\Software\Classes\Applications' | Where-Object { $_ -match $Match })
$reg.startMenuInternetHKCU = @(Get-ChildNames 'HKCU:\Software\Clients\StartMenuInternet')
$reg.startMenuInternetHKLM = @(Get-ChildNames 'HKLM:\SOFTWARE\Clients\StartMenuInternet')
$reg.appPathsHKCUMatching = @(Get-ChildNames 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths' | Where-Object { $_ -match $Match })
$reg.runHKCU = Get-Props 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$reg.notificationSettingsHKCU = @(Get-ChildNames 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings')
$reg.notificationSettingsMatching = @()
foreach ($k in $reg.notificationSettingsHKCU) {
  if ($k -match $Match) { $reg.notificationSettingsMatching += [ordered]@{ key = $k; values = Get-Props "HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$k" } }
}
$reg.appUserModelIdHKCU = @(Get-ChildNames 'HKCU:\Software\Classes\AppUserModelId' | Where-Object { $_ -match $Match })
$reg.softwareHKCUMatching = @(Get-ChildNames 'HKCU:\Software' | Where-Object { $_ -match $Match })
$reg.softwareHKCUMatchingValues = @()
foreach ($k in $reg.softwareHKCUMatching) { $reg.softwareHKCUMatchingValues += [ordered]@{ key = $k; values = Get-Props "HKCU:\Software\$k" } }

$uninstall = @()
foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  foreach ($name in Get-ChildNames $hive) {
    $p = Get-Props "$hive\$name"
    if (-not $p) { continue }
    $blob = ($p.Values -join ' ')
    if ($name -match $Match -or $blob -match $Match) { $uninstall += [ordered]@{ hive = $hive; key = $name; values = $p } }
  }
}
$reg.uninstallEntriesMatching = $uninstall

# Keys that appeared since the pre-install snapshot.
if ($DiffAgainst -and (Test-Path $DiffAgainst)) {
  $before = Get-Content -Raw $DiffAgainst | ConvertFrom-Json
  $diff = [ordered]@{}
  foreach ($p in $snapshotPaths) {
    $now = Get-ChildNames $p
    $old = @($before.$p)
    $new = @($now | Where-Object { $old -notcontains $_ })
    if ($new.Count) { $diff[$p] = $new }
  }
  $nowRa = @((Get-Props 'HKCU:\Software\RegisteredApplications').Keys)
  $newRa = @($nowRa | Where-Object { @($before.'HKCU:\Software\RegisteredApplications') -notcontains $_ })
  if ($newRa.Count) { $diff['HKCU:\Software\RegisteredApplications (values)'] = $newRa }
  $reg.newKeysSinceSnapshot = $diff
}
$facts.registry = $reg

# --- Shortcuts and Start apps ----------------------------------------------------------------------
$shortcuts = @()
$roots = @(
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonPrograms'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
$shell = New-Object -ComObject Shell.Application
$wsh = New-Object -ComObject WScript.Shell
foreach ($root in $roots) {
  if (-not $root -or -not (Test-Path $root)) { continue }
  foreach ($lnk in Get-ChildItem -Path $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue) {
    $target = ''
    try { $target = $wsh.CreateShortcut($lnk.FullName).TargetPath } catch {}
    if ($lnk.Name -notmatch $Match -and $target -notmatch $Match) { continue }
    $sc = $wsh.CreateShortcut($lnk.FullName)
    $aumid = $null; $toastClsid = $null
    try {
      $folder = $shell.Namespace($lnk.DirectoryName)
      $item = $folder.ParseName($lnk.Name)
      $aumid = $item.ExtendedProperty('System.AppUserModel.ID')
      $toastClsid = $item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID')
    } catch {}
    $shortcuts += [ordered]@{
      path = $lnk.FullName; target = $sc.TargetPath; arguments = $sc.Arguments; workingDirectory = $sc.WorkingDirectory
      icon = $sc.IconLocation; description = $sc.Description; appUserModelId = "$aumid"; toastActivatorClsid = "$toastClsid"
    }
  }
}
$facts.shortcuts = $shortcuts
try { $facts.startApps = @(Get-StartApps | Where-Object { $_.Name -match $Match -or $_.AppID -match $Match } | ForEach-Object { [ordered]@{ name = $_.Name; appId = $_.AppID } }) } catch { $facts.startApps = @{ error = "$_" } }

# --- Install locations ------------------------------------------------------------------------------
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs'),
  $env:ProgramFiles,
  ${env:ProgramFiles(x86)}
)
$installs = @()
foreach ($c in $candidates) {
  if (-not $c -or -not (Test-Path $c)) { continue }
  foreach ($d in Get-ChildItem -Path $c -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $Match }) {
    $exe = Get-ChildItem -Path $d.FullName -Filter *.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    $size = (Get-ChildItem -Path $d.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $installs += [ordered]@{ dir = $d.FullName; exes = @($exe); sizeMB = [math]::Round($size / 1MB, 1) }
  }
}
$facts.installDirs = $installs
$facts.appDataDirs = @(
  @((Join-Path $env:APPDATA 'Zen'), (Join-Path $env:LOCALAPPDATA 'Zen'), (Join-Path $env:LOCALAPPDATA 'zen-chromium-updater'), (Join-Path $env:APPDATA 'zen-chromium')) |
    Where-Object { Test-Path $_ } | ForEach-Object { [ordered]@{ dir = $_; entries = @(Get-ChildItem $_ -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) } }
)
$facts.processes = @(Get-Process -Name 'zen*' -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ pid = $_.Id; name = $_.ProcessName; wsMB = [math]::Round($_.WorkingSet64 / 1MB, 1) } })

# --- Microsoft Defender: is real-time protection on, and did it remove anything of ours? -----------
# (An unsigned Electron installer is a classic false-positive target; a missing zen.exe after an
# install that reported success points here.)
$defender = [ordered]@{}
try {
  $st = Get-MpComputerStatus -ErrorAction Stop
  $defender.status = [ordered]@{
    antivirusEnabled = $st.AntivirusEnabled; realTimeProtectionEnabled = $st.RealTimeProtectionEnabled
    antispywareEnabled = $st.AntispywareEnabled; isTamperProtected = $st.IsTamperProtected
    signatureVersion = $st.AntivirusSignatureVersion; signatureAge = $st.AntivirusSignatureAge
  }
} catch { $defender.status = @{ error = "$_" } }
try {
  $defender.threats = @(Get-MpThreatDetection -ErrorAction Stop | ForEach-Object {
    [ordered]@{ threatId = $_.ThreatID; resources = @($_.Resources); action = $_.ActionSuccess; initialDetectionTime = "$($_.InitialDetectionTime)"; processName = $_.ProcessName }
  })
} catch { $defender.threats = @{ error = "$_" } }
try {
  $defender.threatCatalog = @(Get-MpThreat -ErrorAction Stop | ForEach-Object { [ordered]@{ threatId = $_.ThreatID; name = $_.ThreatName; severity = $_.SeverityID; resources = @($_.Resources) } })
} catch { $defender.threatCatalog = @{ error = "$_" } }
try {
  # 1116 = malware detected, 1117 = action taken, 1015/1116/1117/1118/1119/5007 are the usual suspects.
  $defender.events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; Id = @(1006, 1007, 1008, 1015, 1116, 1117, 1118, 1119) } -MaxEvents 40 -ErrorAction Stop |
    ForEach-Object { [ordered]@{ time = $_.TimeCreated.ToString('o'); id = $_.Id; message = ($_.Message -replace '\s+', ' ').Substring(0, [math]::Min(700, ($_.Message -replace '\s+', ' ').Length)) } })
} catch { $defender.events = @{ error = "$_" } }
try {
  $defender.exclusions = [ordered]@{ paths = @((Get-MpPreference -ErrorAction Stop).ExclusionPath); processes = @((Get-MpPreference -ErrorAction Stop).ExclusionProcess) }
} catch { $defender.exclusions = @{ error = "$_" } }
$facts.defender = $defender

# --- Shell / OOBE state of the interactive session -----------------------------------------------
$facts.shell = [ordered]@{
  explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  oobeProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(msoobe|CloudExperienceHost.*|WWAHost|OOBE.*|LogonUI|UserOOBEBroker)$' } | ForEach-Object { "$($_.ProcessName):$($_.Id)" })
  oobeInProgress = $(try { (Get-ItemProperty 'HKLM:\SYSTEM\Setup' -ErrorAction Stop).OOBEInProgress } catch { $null })
  foregroundWindow = $(try {
    Add-Type -Namespace SmokeFg -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);' -ErrorAction Stop
    $h = [SmokeFg.U]::GetForegroundWindow(); $t = New-Object System.Text.StringBuilder 512; $c = New-Object System.Text.StringBuilder 256
    [void][SmokeFg.U]::GetWindowText($h, $t, 512); [void][SmokeFg.U]::GetClassName($h, $c, 256)
    "$($t.ToString()) [$($c.ToString())]"
  } catch { "$_" })
}

$json = Join-Path $Out "$Label-facts.json"
$facts | ConvertTo-Json -Depth 8 | Set-Content -Path $json -Encoding UTF8

$summary = @()
$summary += "OS: $($facts.os.productName) $($facts.os.displayVersion) build $($facts.os.currentBuild).$($facts.os.ubr) ($($facts.os.editionId), $($facts.os.installationType)) arch $($facts.os.arch) user $($facts.os.user) interactive=$($facts.os.userInteractive)"
$summary += "Display: $($facts.display.virtualScreen) dpi $($facts.display.dpiX)"
$summary += "RegisteredApplications (HKCU) matching '$Match': $($reg.registeredApplicationsHKCUMatching -join ', ')"
$summary += "RegisteredApplications (HKLM) matching: $($reg.registeredApplicationsHKLMMatching -join ', ')"
$summary += "StartMenuInternet HKCU: $($reg.startMenuInternetHKCU -join ', ') | HKLM: $($reg.startMenuInternetHKLM -join ', ')"
$summary += "Classes (HKCU) matching: $($reg.classesHKCUMatching -join ', ')"
$summary += "App Paths matching: $($reg.appPathsHKCUMatching -join ', ')"
$summary += "http UserChoice ProgId: $($facts.userChoice.http.ProgId) | https: $($facts.userChoice.https.ProgId)"
$summary += "Notification settings keys matching: $((@($reg.notificationSettingsMatching) | ForEach-Object { $_.key }) -join ', ')"
$summary += "Uninstall entries matching: $((@($uninstall) | ForEach-Object { "$($_.hive)\$($_.key) DisplayName=$($_.values.DisplayName) Version=$($_.values.DisplayVersion) Publisher=$($_.values.Publisher) InstallLocation=$($_.values.InstallLocation)" }) -join ' ; ')"
$summary += "Shortcuts: $((@($shortcuts) | ForEach-Object { "$($_.path) -> $($_.target) AUMID=$($_.appUserModelId)" }) -join ' ; ')"
$summary += "StartApps matching: $((@($facts.startApps) | ForEach-Object { "$($_.name)=$($_.appId)" }) -join ' ; ')"
$summary += "Install dirs: $((@($installs) | ForEach-Object { "$($_.dir) ($($_.sizeMB) MB, exes: $($_.exes -join ','))" }) -join ' ; ')"
$summary += "AppData dirs: $((@($facts.appDataDirs) | ForEach-Object { $_.dir }) -join ' ; ')"
$summary += "Defender: rtp=$($defender.status.realTimeProtectionEnabled) av=$($defender.status.antivirusEnabled) sig=$($defender.status.signatureVersion) threats=$(@($defender.threats).Count) events=$(@($defender.events).Count) exclusionPaths=$(@($defender.exclusions.paths) -join ',')"
foreach ($t in @($defender.threats)) { if ($t.resources) { $summary += "  Defender detection: $($t.resources -join ' | ') action=$($t.action) at $($t.initialDetectionTime)" } }
foreach ($e in @($defender.events)) { if ($e.message -and $e.message -match $Match) { $summary += "  Defender event $($e.id) $($e.time): $($e.message)" } }
$summary += "Shell: explorer=$($facts.shell.explorer -join ',') oobeInProgress=$($facts.shell.oobeInProgress) oobeProcesses=$($facts.shell.oobeProcesses -join ',') foreground=$($facts.shell.foregroundWindow)"
if ($reg.newKeysSinceSnapshot) { $summary += "New registry keys since snapshot: $(($reg.newKeysSinceSnapshot | ConvertTo-Json -Depth 4 -Compress))" }
$summary -join "`n" | Set-Content -Path (Join-Path $Out "$Label-facts.txt") -Encoding UTF8
Write-Output ($summary -join "`n")
