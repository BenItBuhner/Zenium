# Windows facts for the window-shell smoke (temporary; removed with the harness).
#   -Action facts                         JSON: hwnd, Win32 styles, DWM system backdrop type, bounds
#   -Action icon -Path <png>              save the app window's big icon (what the taskbar shows) as PNG
#   -Action crop -Path <png> -Out <png> -X -Y -W -H   crop a screenshot
#   -Action size -Path <png>              JSON: pixel width/height of a PNG
#   -Action jumplist -AppId <id> [-Commit]  JSON: HRESULTs of ICustomDestinationList SetAppID/BeginList/
#                                         AppendKnownCategory(recent)/Commit for <id>, the Recent folder the shell
#                                         resolves, the recent-items policy values, new jump list files
#   -Action taskbar                       JSON: taskbar buttons via UI Automation (name, AutomationId = AppUserModelID)
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Path = '',
  [string]$Out = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [string]$ProcessName = 'zenium',
  [string]$AppId = '',
  [switch]$Commit
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$jumpListInterop = @'
using System;
using System.Runtime.InteropServices;
namespace ShellSmoke {
  [ComImport, Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IObjectArray {
    [PreserveSig] int GetCount(out uint pcObjects);
    [PreserveSig] int GetAt(uint uiIndex, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
  }
  [ComImport, Guid("6332DEBF-87B5-4670-90C0-5E57B408A49E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ICustomDestinationList {
    [PreserveSig] int SetAppID([MarshalAs(UnmanagedType.LPWStr)] string pszAppID);
    [PreserveSig] int BeginList(out uint pcMinSlots, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    [PreserveSig] int AppendCategory([MarshalAs(UnmanagedType.LPWStr)] string pszCategory, [MarshalAs(UnmanagedType.IUnknown)] object poa);
    [PreserveSig] int AppendKnownCategory(int category);
    [PreserveSig] int AddUserTasks([MarshalAs(UnmanagedType.IUnknown)] object poa);
    [PreserveSig] int CommitList();
    [PreserveSig] int GetRemovedDestinations(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    [PreserveSig] int DeleteList([MarshalAs(UnmanagedType.LPWStr)] string pszAppID);
    [PreserveSig] int AbortList();
  }
  [ComImport, Guid("77F10CF0-3DB5-4966-B520-B7C54FD35ED6"), ClassInterface(ClassInterfaceType.None)]
  public class DestinationList { }
  public static class JumpProbe {
    // Returns { hrSetAppID, hrBeginList, minSlots, hrAppendKnownCategory(recent), hrCommitOrAbort }.
    public static int[] Run(string appId, bool commit) {
      ICustomDestinationList list = (ICustomDestinationList)new DestinationList();
      int hrSet = list.SetAppID(appId);
      uint slots = 0;
      object removed = null;
      Guid iid = typeof(IObjectArray).GUID;
      int hrBegin = list.BeginList(out slots, ref iid, out removed);
      int hrRecent = 1;
      int hrEnd = 1;
      if (hrBegin >= 0) {
        hrRecent = list.AppendKnownCategory(1);
        hrEnd = commit ? list.CommitList() : list.AbortList();
      }
      return new int[] { hrSet, hrBegin, (int)slots, hrRecent, hrEnd };
    }
  }
}
'@

function Hex32([int]$v) { return ('0x{0:X8}' -f $v) }

function Get-RegRaw([string]$key, [string]$name) {
  try {
    $k = Get-Item -Path $key -ErrorAction Stop
    return $k.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
  } catch { return $null }
}

function Get-RegValue([string]$key, [string]$name) {
  try { return (Get-ItemProperty -Path $key -Name $name -ErrorAction Stop).$name } catch { return $null }
}

function List-JumpLists([string]$recent) {
  # Empty when the shell cannot resolve the Recent folder (USERPROFILE pointing at a bare directory).
  if (-not $recent) { return @() }
  $dir = Join-Path $recent 'CustomDestinations'
  if (-not (Test-Path $dir)) { return @() }
  return @(Get-ChildItem -Path $dir -Filter '*.customDestinations-ms' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}

Add-Type -Namespace ShellSmoke -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Get-AppWindow {
  $proc = Get-Process -Name "$ProcessName*" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { throw "no $ProcessName process with a main window" }
  return $proc.MainWindowHandle
}

switch ($Action) {
  'facts' {
    $h = Get-AppWindow
    $style = [ShellSmoke.Native]::GetWindowLongPtr($h, -16).ToInt64()
    $flags = @{
      WS_CAPTION = 0x00C00000; WS_THICKFRAME = 0x00040000; WS_MINIMIZEBOX = 0x00020000; WS_MAXIMIZEBOX = 0x00010000
      WS_SYSMENU = 0x00080000; WS_POPUP = 0x80000000; WS_BORDER = 0x00800000
    }
    $set = @()
    foreach ($k in $flags.Keys) { if (($style -band $flags[$k]) -eq $flags[$k]) { $set += $k } }
    $backdrop = -1
    $hr = [ShellSmoke.Native]::DwmGetWindowAttribute($h, 38, [ref]$backdrop, 4)   # DWMWA_SYSTEMBACKDROP_TYPE
    $rect = New-Object ShellSmoke.Native+RECT
    [void][ShellSmoke.Native]::GetWindowRect($h, [ref]$rect)
    [pscustomobject]@{
      hwnd = $h.ToString()
      styles = @($set | Sort-Object)
      systemBackdropType = $backdrop
      systemBackdropHresult = $hr
      zoomed = [ShellSmoke.Native]::IsZoomed($h)
      rect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
    } | ConvertTo-Json -Depth 4 -Compress
  }
  'icon' {
    $h = Get-AppWindow
    $icon = [ShellSmoke.Native]::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]::Zero)      # WM_GETICON ICON_BIG
    if ($icon -eq [IntPtr]::Zero) { $icon = [ShellSmoke.Native]::GetClassLongPtr($h, -14) }  # GCLP_HICON
    if ($icon -eq [IntPtr]::Zero) { $icon = [ShellSmoke.Native]::SendMessage($h, 0x7F, [IntPtr]0, [IntPtr]::Zero) }
    if ($icon -eq [IntPtr]::Zero) { throw 'window has no icon' }
    $bmp = [System.Drawing.Icon]::FromHandle($icon).ToBitmap()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    [pscustomobject]@{ width = $bmp.Width; height = $bmp.Height; path = $Path } | ConvertTo-Json -Compress
    $bmp.Dispose()
  }
  'crop' {
    $src = [System.Drawing.Bitmap]::FromFile($Path)
    $x = [Math]::Max(0, $X); $y = [Math]::Max(0, $Y)
    $w = [Math]::Min($W, $src.Width - $x); $h2 = [Math]::Min($H, $src.Height - $y)
    $rect = New-Object System.Drawing.Rectangle $x, $y, $w, $h2
    $dst = $src.Clone($rect, $src.PixelFormat)
    $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    [pscustomobject]@{ width = $dst.Width; height = $dst.Height; path = $Out } | ConvertTo-Json -Compress
    $dst.Dispose(); $src.Dispose()
  }
  'size' {
    $src = [System.Drawing.Bitmap]::FromFile($Path)
    [pscustomobject]@{ width = $src.Width; height = $src.Height } | ConvertTo-Json -Compress
    $src.Dispose()
  }
  'jumplist' {
    if (-not $AppId) { throw 'jumplist needs -AppId' }
    Add-Type -TypeDefinition $jumpListInterop
    $recent = [Environment]::GetFolderPath('Recent')
    $before = List-JumpLists $recent
    $hr = [ShellSmoke.JumpProbe]::Run($AppId, [bool]$Commit)
    $after = List-JumpLists $recent
    $new = @($after | Where-Object { $before -notcontains $_ })
    $shellFolders = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $advanced = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
    $policyUser = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer'
    $policyMachine = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    [pscustomobject]@{
      appId = $AppId
      committed = [bool]$Commit
      hr = @{
        setAppId = Hex32 $hr[0]
        beginList = Hex32 $hr[1]
        minSlots = $hr[2]
        appendKnownCategoryRecent = Hex32 $hr[3]
        commitOrAbort = Hex32 $hr[4]
      }
      beginListOk = ($hr[1] -ge 0)
      recentFolder = $recent
      appDataFolder = [Environment]::GetFolderPath('ApplicationData')
      env = @{ APPDATA = $env:APPDATA; LOCALAPPDATA = $env:LOCALAPPDATA; USERPROFILE = $env:USERPROFILE }
      userShellFoldersRecentRaw = Get-RegRaw $shellFolders 'Recent'
      userShellFoldersAppDataRaw = Get-RegRaw $shellFolders 'AppData'
      startTrackDocs = Get-RegValue $advanced 'Start_TrackDocs'
      startTrackProgs = Get-RegValue $advanced 'Start_TrackProgs'
      noRecentDocsHistoryUser = Get-RegValue $policyUser 'NoRecentDocsHistory'
      noRecentDocsHistoryMachine = Get-RegValue $policyMachine 'NoRecentDocsHistory'
      user = $identity.Name
      isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      sessionId = (Get-Process -Id $PID).SessionId
      filesBefore = $before
      filesAfter = $after
      newFiles = $new
    } | ConvertTo-Json -Depth 4 -Compress
  }
  'taskbar' {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $ae = [System.Windows.Automation.AutomationElement]
    $trayCond = New-Object System.Windows.Automation.PropertyCondition($ae::ClassNameProperty, 'Shell_TrayWnd')
    $tray = $ae::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $trayCond)
    if (-not $tray) { throw 'no Shell_TrayWnd on this desktop' }
    $btnCond = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    $items = @()
    foreach ($b in $buttons) {
      $items += [pscustomobject]@{
        name = $b.Current.Name
        automationId = $b.Current.AutomationId
        className = $b.Current.ClassName
      }
    }
    [pscustomobject]@{ count = $items.Count; buttons = $items } | ConvertTo-Json -Depth 4 -Compress
  }
  default { throw "unknown action $Action" }
}
