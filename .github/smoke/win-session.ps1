# Interactive-session helpers for the Windows desktop smoke.
#   -Action dismiss-oobe   kill OOBE hosts / start Explorer if the session still sits in Windows OOBE
#                          (windows-11-arm boots into "Choose privacy settings": no shell, every
#                          screenshot shows OOBE)
#   -Action dialogs        JSON list of the app's visible top-level windows; native dialogs (#32770:
#                          MessageBox, TaskDialog, Electron's error box) with their text and buttons
#   -Action processes      JSON list of zenium*.exe processes with memory and window titles
#   -Action kill           stop every zenium*.exe process that is still running
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$ProcessName = 'zenium'
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Smoke -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
'@

function Get-WindowClass([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 256; [void][Smoke.Native]::GetClassName($h, $sb, 256); $sb.ToString() }
function Get-WindowTitle([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 1024; [void][Smoke.Native]::GetWindowText($h, $sb, 1024); $sb.ToString() }
function Get-TopWindows {
  $script:enumList = New-Object System.Collections.ArrayList
  $cb = [Smoke.Native+EnumProc] { param($h, $l) [void]$script:enumList.Add($h); $true }
  [void][Smoke.Native]::EnumWindows($cb, [IntPtr]::Zero)
  return @($script:enumList.ToArray())
}
function Get-ChildWindows([IntPtr]$parent) {
  $script:enumList = New-Object System.Collections.ArrayList
  $cb = [Smoke.Native+EnumProc] { param($h, $l) [void]$script:enumList.Add($h); $true }
  [void][Smoke.Native]::EnumChildWindows($parent, $cb, [IntPtr]::Zero)
  return @($script:enumList.ToArray())
}
function Get-AppProcesses { @(Get-Process -Name "$ProcessName*" -ErrorAction SilentlyContinue) }
$oobePattern = '^(msoobe|CloudExperienceHost.*|WWAHost|OOBE.*|UserOOBEBroker)$'
function Get-OobeProcesses {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $oobePattern })
}

switch ($Action) {
  'dismiss-oobe' {
    $fg = [Smoke.Native]::GetForegroundWindow()
    $info = [ordered]@{
      oobeProcessesBefore = @(Get-OobeProcesses | ForEach-Object { "$($_.ProcessName):$($_.Id)" })
      foregroundBefore = "$(Get-WindowTitle $fg) [$(Get-WindowClass $fg)]"
      explorerBefore = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
      startedExplorer = $false
    }
    foreach ($p in Get-OobeProcesses) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { $null = $_ }
    }
    if ($info.oobeProcessesBefore.Count) { Start-Sleep -Seconds 2 }
    if (-not $info.explorerBefore.Count) {
      try { Start-Process explorer.exe; $info.startedExplorer = $true } catch { $null = $_ }
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline -and -not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 500
      }
    }
    $fg = [Smoke.Native]::GetForegroundWindow()
    $info.oobeProcessesAfter = @(Get-OobeProcesses | ForEach-Object { "$($_.ProcessName):$($_.Id)" })
    $info.foregroundAfter = "$(Get-WindowTitle $fg) [$(Get-WindowClass $fg)]"
    $info.explorerAfter = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    [pscustomobject]$info | ConvertTo-Json -Depth 4 -Compress
  }
  'dialogs' {
    $pids = @(Get-AppProcesses | Select-Object -ExpandProperty Id)
    $out = @()
    foreach ($h in Get-TopWindows) {
      if (-not [Smoke.Native]::IsWindowVisible($h)) { continue }
      $ownerPid = [uint32]0
      [void][Smoke.Native]::GetWindowThreadProcessId($h, [ref]$ownerPid)
      if ($pids -notcontains [int]$ownerPid) { continue }
      $cls = Get-WindowClass $h
      $entry = [ordered]@{ hwnd = $h.ToString(); pid = [int]$ownerPid; title = (Get-WindowTitle $h); className = $cls; texts = @(); buttons = @() }
      if ($cls -eq '#32770') {
        # EnumChildWindows walks all descendants (TaskDialog buttons sit under a DirectUIHWND).
        foreach ($c in Get-ChildWindows $h) {
          $ccls = Get-WindowClass $c
          $txt = Get-WindowTitle $c
          if ($ccls -eq 'Button' -and $txt) { $entry.buttons += ($txt -replace '&', '') }
          elseif ($ccls -eq 'Static' -and $txt) { $entry.texts += $txt }
        }
      }
      $out += [pscustomobject]$entry
    }
    [pscustomobject]@{
      count = @($out).Count
      nativeDialogs = @($out | Where-Object { $_.className -eq '#32770' })
      windows = @($out)
    } | ConvertTo-Json -Depth 4 -Compress
  }
  'processes' {
    $procs = Get-AppProcesses | ForEach-Object {
      [pscustomobject]@{
        pid = $_.Id
        name = $_.ProcessName
        workingSetMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
        mainWindowTitle = $_.MainWindowTitle
        path = $_.Path
      }
    }
    [pscustomobject]@{ count = @($procs).Count; processes = @($procs) } | ConvertTo-Json -Depth 4 -Compress
  }
  'kill' {
    $procs = Get-AppProcesses
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Output "stopped $(@($procs).Count) $ProcessName* process(es)"
  }
  default { throw "unknown action $Action" }
}
