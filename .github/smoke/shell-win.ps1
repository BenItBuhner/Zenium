# Windows facts for the window-shell smoke (temporary; removed with the harness).
#   -Action facts                         JSON: hwnd, Win32 styles, DWM system backdrop type, bounds
#   -Action icon -Path <png>              save the app window's big icon (what the taskbar shows) as PNG
#   -Action crop -Path <png> -Out <png> -X -Y -W -H   crop a screenshot
#   -Action size -Path <png>              JSON: pixel width/height of a PNG
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Path = '',
  [string]$Out = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [string]$ProcessName = 'zenium'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

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
  default { throw "unknown action $Action" }
}
