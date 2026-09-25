# What Windows knows about Zenium's relaunch after a restart or a sign-out (os-49), read and
# seeded for the `restart-registration` scenario of smoke.mjs; every action prints one JSON
# document with the same facts:
#   restartApps       the user's "Automatically save my restartable apps and restart them when I
#                     sign back in" toggle: HKCU\Software\Microsoft\Windows NT\CurrentVersion\
#                     Winlogon\RestartApps (a DWORD; $null when the value is absent, which is the
#                     OS default – on since Windows 11)
#   entry             the RunOnce value named -ValueName (HKCU\Software\Microsoft\Windows\
#                     CurrentVersion\RunOnce: what Windows runs once at the next sign-in), or $null
#   entries           every RunOnce value whose name starts with Zenium, name → command
#   build             the OS build ([Environment]::OSVersion), for the record
#   -Action read                -ValueName <name>
#   -Action set-restart-apps    -ValueName <name> -Value <0|1>    writes the toggle
#   -Action clear-restart-apps  -ValueName <name>                 deletes the toggle's value
#   -Action delete-run-once     -ValueName <name>                 deletes this profile's entry
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$ValueName = 'Zenium',
  [int]$Value = 1
)

$ErrorActionPreference = 'Continue'

$WinlogonKey = 'Software\Microsoft\Windows NT\CurrentVersion\Winlogon'
$RunOnceKey = 'Software\Microsoft\Windows\CurrentVersion\RunOnce'

function Read-UserValue([string]$path, [string]$name) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  if (-not $k) { return $null }
  try { return $k.GetValue($name, $null) } finally { $k.Close() }
}

function Read-ZeniumEntries {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunOnceKey)
  $o = [ordered]@{}
  if (-not $k) { return $o }
  try {
    foreach ($n in $k.GetValueNames()) {
      if ($n -like 'Zenium*') { $o[$n] = $k.GetValue($n, $null) }
    }
  } finally { $k.Close() }
  return $o
}

function Get-Facts {
  return [ordered]@{
    valueName = $ValueName
    restartAppsKey = "HKCU\$WinlogonKey\RestartApps"
    restartApps = Read-UserValue $WinlogonKey 'RestartApps'
    runOnceKey = "HKCU\$RunOnceKey"
    entry = Read-UserValue $RunOnceKey $ValueName
    entries = Read-ZeniumEntries
    build = [Environment]::OSVersion.Version.Build
  }
}

switch ($Action) {
  'read' {
    Get-Facts | ConvertTo-Json -Depth 4
  }
  'set-restart-apps' {
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($WinlogonKey)
    try { $k.SetValue('RestartApps', $Value, [Microsoft.Win32.RegistryValueKind]::DWord) } finally { $k.Close() }
    Get-Facts | ConvertTo-Json -Depth 4
  }
  'clear-restart-apps' {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($WinlogonKey, $true)
    if ($k) { try { $k.DeleteValue('RestartApps', $false) } finally { $k.Close() } }
    Get-Facts | ConvertTo-Json -Depth 4
  }
  'delete-run-once' {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunOnceKey, $true)
    if ($k) { try { $k.DeleteValue($ValueName, $false) } finally { $k.Close() } }
    Get-Facts | ConvertTo-Json -Depth 4
  }
  default { throw "unknown action $Action" }
}
