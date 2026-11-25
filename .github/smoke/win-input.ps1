# Real OS input for the title bar check (titlebar-check.mjs): the cursor and the buttons go
# through user32, so the main process's cursor polling and Windows' own hit testing see them
# exactly as they would see a person's mouse. Coordinates are screen pixels.
param(
  [Parameter(Mandatory = $true)][ValidateSet('move', 'click', 'drag', 'snap-left', 'shot')][string]$Action,
  [int]$X = 0, [int]$Y = 0, [int]$X2 = 0, [int]$Y2 = 0,
  [int]$W = 0, [int]$H = 0,
  [string]$Path = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ZenInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
}
'@
[ZenInput]::SetProcessDPIAware() | Out-Null
$LEFTDOWN = 0x02; $LEFTUP = 0x04; $KEYUP = 0x02; $MOVE = 0x01; $ABSOLUTE = 0x8000
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
# A real mouse move through the input queue (mouse_event, absolute 0..65535), which is what
# Windows' window-move loop follows; SetCursorPos alone only repositions the pointer.
function MoveTo([int]$x, [int]$y) {
  $ax = [uint32][math]::Round($x * 65535 / ($screen.Width - 1))
  $ay = [uint32][math]::Round($y * 65535 / ($screen.Height - 1))
  [ZenInput]::mouse_event($MOVE -bor $ABSOLUTE, $ax, $ay, 0, [UIntPtr]::Zero)
}
function Glide([int]$fx, [int]$fy, [int]$tx, [int]$ty) {
  $steps = 30
  for ($i = 1; $i -le $steps; $i++) {
    MoveTo ([int]($fx + ($tx - $fx) * $i / $steps)) ([int]($fy + ($ty - $fy) * $i / $steps))
    Start-Sleep -Milliseconds 30
  }
}
switch ($Action) {
  'move' { MoveTo $X $Y }
  'click' {
    MoveTo $X $Y
    Start-Sleep -Milliseconds 150
    [ZenInput]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [ZenInput]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  'drag' {
    MoveTo $X $Y
    Start-Sleep -Milliseconds 200
    [ZenInput]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    Glide $X $Y $X2 $Y2
    Start-Sleep -Milliseconds 400
    [ZenInput]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  'snap-left' {
    # Win+Left: Windows' own snap of the foreground window to the left half.
    [ZenInput]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
    [ZenInput]::keybd_event(0x25, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [ZenInput]::keybd_event(0x25, 0, $KEYUP, [UIntPtr]::Zero)
    [ZenInput]::keybd_event(0x5B, 0, $KEYUP, [UIntPtr]::Zero)
  }
  'shot' {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    if ($W -le 0 -or $H -le 0) {
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $X = $b.X; $Y = $b.Y; $W = $b.Width; $H = $b.Height
    }
    $bmp = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen((New-Object System.Drawing.Point $X, $Y), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $W, $H), [System.Drawing.CopyPixelOperation]::SourceCopy)
    # The cursor is not part of a screen copy: draw a marker where it stands.
    $c = [System.Windows.Forms.Cursor]::Position
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
    $g.DrawEllipse($pen, $c.X - $X - 6, $c.Y - $Y - 6, 12, 12)
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
}
