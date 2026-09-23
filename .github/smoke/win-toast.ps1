# What Windows knows about Zenium's toast notifications (os-27 / os-28 / os-30), read for the
# `notifications` scenario of smoke.mjs; every action prints one JSON document.
#   -Action app-id    -Aumid <id>
#       The AppUserModelId class key a portable or unpacked copy writes for itself
#       (src/main/platform/notifications.ts: HKCU\Software\Classes\AppUserModelId\<id> with
#       DisplayName and IconUri; whether the icon file exists) and the notification platform's
#       per-sender key (HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<id>),
#       which Windows creates once the app has shown a toast and which Settings > System >
#       Notifications lists its senders from.
#   -Action shortcuts -Aumid <id> [-Match zenium]
#       Every *.lnk under the user's Start menu Programs folder and Desktop whose name matches,
#       with its target and the System.AppUserModel.ID the installer stamped on it
#       (electron-builder's WinShell::SetLnkAUMI); an installed build's toasts carry that id.
#   -Action toast     -Aumid <id> -Title <toast title> [-WaitSeconds 10] [-Click]
#       After a page fired a notification: waits for the platform's per-sender key, lists the
#       toast banner windows on screen (ShellExperienceHost's "New notification" CoreWindow),
#       scans the platform's store (%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db
#       and its -wal) for the id and the title, reads the platform's event log, and with -Click
#       tries to activate the banner through UI Automation (best effort: the runner's session
#       may show no banner at all – WIN-006 on Server 2025).
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Aumid = 'io.github.benitbuhner.zenium',
  [string]$Title = '',
  [string]$Match = 'zenium',
  [int]$WaitSeconds = 10,
  [switch]$Click
)

$ErrorActionPreference = 'Continue'

$AppIdClassKey = "Software\Classes\AppUserModelId\$Aumid"
$SenderSettingsKey = "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$Aumid"

# The values under `$path` of the user's hive, or $null when the key is not there.
function Read-UserKey([string]$path) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  if (-not $k) { return $null }
  try {
    $o = [ordered]@{}
    foreach ($n in $k.GetValueNames()) {
      $label = if ($n -eq '') { '(default)' } else { $n }
      $o[$label] = $k.GetValue($n, $null)
    }
    $o['(subkeys)'] = @($k.GetSubKeyNames())
    return $o
  } finally { $k.Close() }
}

function Get-AppIdFacts {
  $class = Read-UserKey $AppIdClassKey
  $iconUri = $null
  if ($class) { $iconUri = $class['IconUri'] }
  $iconExists = $null
  if ($iconUri) { $iconExists = Test-Path -LiteralPath $iconUri }
  return [ordered]@{
    aumid = $Aumid
    classKey = "HKCU\$AppIdClassKey"
    class = $class
    iconExists = $iconExists
    senderSettingsKey = "HKCU\$SenderSettingsKey"
    senderSettings = Read-UserKey $SenderSettingsKey
  }
}

function Get-ShortcutFacts {
  $folders = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('CommonDesktopDirectory')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $shell = New-Object -ComObject Shell.Application
  $wsh = New-Object -ComObject WScript.Shell
  $list = @()
  foreach ($lnk in @(Get-ChildItem -Path $folders -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $Match })) {
    $entry = [ordered]@{ path = $lnk.FullName; target = $null; aumid = $null; error = $null }
    try { $entry.target = $wsh.CreateShortcut($lnk.FullName).TargetPath } catch { $entry.error = "target: $($_.Exception.Message)" }
    try {
      $folder = $shell.NameSpace($lnk.DirectoryName)
      $item = $folder.ParseName($lnk.Name)
      $entry.aumid = $item.ExtendedProperty('System.AppUserModel.ID')
    } catch { $entry.error = "aumid: $($_.Exception.Message)" }
    $list += $entry
  }
  return [ordered]@{
    aumid = $Aumid
    folders = @($folders)
    shortcuts = @($list)
  }
}

# --- Windows on screen --------------------------------------------------------------------------
Add-Type -Namespace SmokeToast -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
'@

function Get-WindowClass([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 256; [void][SmokeToast.Native]::GetClassName($h, $sb, 256); $sb.ToString() }
function Get-WindowTitle([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 1024; [void][SmokeToast.Native]::GetWindowText($h, $sb, 1024); $sb.ToString() }

# Visible top-level windows of the shell's notification host: the toast banner is a
# Windows.UI.Core.CoreWindow titled "New notification" (Windows 10 and 11), owned by
# ShellExperienceHost.exe; the Action Center list is another CoreWindow of the same host.
function Get-ToastWindows {
  $script:toastEnum = New-Object System.Collections.ArrayList
  $cb = [SmokeToast.Native+EnumProc] { param($h, $l) [void]$script:toastEnum.Add($h); $true }
  [void][SmokeToast.Native]::EnumWindows($cb, [IntPtr]::Zero)
  $out = @()
  foreach ($h in @($script:toastEnum.ToArray())) {
    if (-not [SmokeToast.Native]::IsWindowVisible($h)) { continue }
    $cls = Get-WindowClass $h
    if ($cls -ne 'Windows.UI.Core.CoreWindow') { continue }
    $title = Get-WindowTitle $h
    $ownerPid = [uint32]0
    [void][SmokeToast.Native]::GetWindowThreadProcessId($h, [ref]$ownerPid)
    $proc = $null
    try { $proc = (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName } catch { $proc = $null }
    $out += [ordered]@{ handle = [int64]$h; title = $title; class = $cls; pid = [int64]$ownerPid; process = $proc; toast = ($title -eq 'New notification') }
  }
  return @($out)
}

# --- The platform's store -----------------------------------------------------------------------
# wpndatabase.db is SQLite, held open by the notification platform's service; the runner has no
# SQLite, so the file (and the WAL, where the latest rows sit until a checkpoint) is scanned for
# the bytes of the id and the title in the two encodings SQLite may store text in.
function Read-FileShared([string]$path) {
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $len = [int]$fs.Length
    $bytes = New-Object byte[] $len
    $read = 0
    while ($read -lt $len) {
      $n = $fs.Read($bytes, $read, $len - $read)
      if ($n -le 0) { break }
      $read += $n
    }
    return $bytes
  } finally { $fs.Close() }
}

function Get-OccurrenceCount([string]$haystack, [string]$needle) {
  if (-not $needle) { return 0 }
  $count = 0
  $at = 0
  while ($true) {
    $at = $haystack.IndexOf($needle, $at, [System.StringComparison]::Ordinal)
    if ($at -lt 0) { break }
    $count++
    $at += $needle.Length
  }
  return $count
}

function Get-StoreFacts([string]$title) {
  $dir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Notifications'
  $latin1 = [System.Text.Encoding]::GetEncoding(28591)
  $files = @()
  foreach ($name in @('wpndatabase.db', 'wpndatabase.db-wal')) {
    $p = Join-Path $dir $name
    $f = [ordered]@{ file = $p; exists = (Test-Path -LiteralPath $p); bytes = $null; aumidUtf8 = $null; aumidUtf16 = $null; titleUtf8 = $null; titleUtf16 = $null; error = $null }
    if ($f.exists) {
      try {
        $bytes = Read-FileShared $p
        $f.bytes = $bytes.Length
        $text = $latin1.GetString($bytes)
        $f.aumidUtf8 = Get-OccurrenceCount $text ($latin1.GetString([System.Text.Encoding]::UTF8.GetBytes($Aumid)))
        $f.aumidUtf16 = Get-OccurrenceCount $text ($latin1.GetString([System.Text.Encoding]::Unicode.GetBytes($Aumid)))
        if ($title) {
          $f.titleUtf8 = Get-OccurrenceCount $text ($latin1.GetString([System.Text.Encoding]::UTF8.GetBytes($title)))
          $f.titleUtf16 = Get-OccurrenceCount $text ($latin1.GetString([System.Text.Encoding]::Unicode.GetBytes($title)))
        }
      } catch { $f.error = $_.Exception.Message }
    }
    $files += $f
  }
  $aumidFound = $false
  $titleFound = $false
  foreach ($f in $files) {
    if (($f.aumidUtf8 -gt 0) -or ($f.aumidUtf16 -gt 0)) { $aumidFound = $true }
    if (($f.titleUtf8 -gt 0) -or ($f.titleUtf16 -gt 0)) { $titleFound = $true }
  }
  return [ordered]@{ directory = $dir; files = @($files); aumidFound = $aumidFound; titleFound = $titleFound }
}

# The notification platform's operational log: present on every Windows, not always enabled.
function Get-PlatformEvents {
  $out = [ordered]@{ log = 'Microsoft-Windows-PushNotification-Platform/Operational'; enabled = $null; events = @(); error = $null }
  try {
    $l = Get-WinEvent -ListLog $out.log -ErrorAction Stop
    $out.enabled = $l.IsEnabled
    $out.recordCount = $l.RecordCount
    if ($l.RecordCount -gt 0) {
      $out.events = @(Get-WinEvent -LogName $out.log -MaxEvents 25 -ErrorAction Stop | ForEach-Object {
        [ordered]@{ time = $_.TimeCreated.ToString('o'); id = $_.Id; level = $_.LevelDisplayName; message = ($_.Message -replace '\s+', ' ').Substring(0, [Math]::Min(300, ($_.Message -replace '\s+', ' ').Length)) }
      })
    }
  } catch { $out.error = $_.Exception.Message }
  return $out
}

# A click on the banner through UI Automation: the toast's element is the first descendant of
# the "New notification" window that names the title; its Invoke pattern (or the nearest
# ancestor's) is the activation a pointer click would be.
function Invoke-ToastClick([string]$title) {
  $out = [ordered]@{ attempted = $true; invoked = $false; via = $null; element = $null; error = $null }
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $banner = @(Get-ToastWindows | Where-Object { $_.toast }) | Select-Object -First 1
    if (-not $banner) { $out.error = 'no "New notification" window on screen'; return $out }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$banner.handle)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $target = $null
    foreach ($el in $all) {
      $name = $el.Current.Name
      if ($title -and $name -and $name.Contains($title)) { $target = $el; break }
    }
    if (-not $target) { $out.error = "no element naming '$title' among $($all.Count) in the banner"; return $out }
    $out.element = [ordered]@{ name = $target.Current.Name; controlType = $target.Current.ControlType.ProgrammaticName; automationId = $target.Current.AutomationId }
    $el = $target
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -lt 6 -and $el; $depth++) {
      $pattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        $out.invoked = $true
        $out.via = "InvokePattern at depth $depth ($($el.Current.ControlType.ProgrammaticName))"
        break
      }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select()
        $out.invoked = $true
        $out.via = "SelectionItemPattern at depth $depth ($($el.Current.ControlType.ProgrammaticName))"
        break
      }
      $el = $walker.GetParent($el)
    }
    if (-not $out.invoked) { $out.error = 'no Invoke or SelectionItem pattern on the element or its ancestors' }
  } catch { $out.error = $_.Exception.Message }
  return $out
}

switch ($Action) {
  'app-id' {
    Get-AppIdFacts | ConvertTo-Json -Depth 6
  }
  'shortcuts' {
    Get-ShortcutFacts | ConvertTo-Json -Depth 6
  }
  'toast' {
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $sender = $null
    $rounds = 0
    do {
      $rounds++
      $sender = Read-UserKey $SenderSettingsKey
      if ($sender) { break }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    $info = [ordered]@{
      aumid = $Aumid
      title = $Title
      senderSettingsKey = "HKCU\$SenderSettingsKey"
      senderSettings = $sender
      senderSettingsRounds = $rounds
      windows = @(Get-ToastWindows)
      store = Get-StoreFacts $Title
      platformLog = Get-PlatformEvents
      click = $null
    }
    if ($Click) { $info.click = Invoke-ToastClick $Title }
    $info | ConvertTo-Json -Depth 7
  }
  default { throw "unknown action $Action" }
}
