# OS-level input and window inspection helpers for the smoke driver.
#   -Action move  -X <px> -Y <px>                 move the real cursor (hover)
#   -Action drag  -X <px> -Y <px> -DX <px> -DY <px>  press the left button at X,Y and drag by DX,DY
#   -Action escape                                send Esc to the foreground window (closes menus)
#   -Action sendkeys -Name '^t'                   SendKeys sequence to the foreground window
#   -Action uia-invoke -Name <button text>        click a native dialog button through UI Automation
#   -Action dialogs                               JSON list of the app's top-level windows incl. native dialog text
#   -Action processes                             JSON list of zen*.exe processes with memory
#   -Action window                                JSON with Win32 styles of the app's top-level window
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$DX = 0,
  [int]$DY = 0,
  [string]$Name = '',
  [string]$ProcessName = 'zen',
  [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Smoke -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Move-Cursor([int]$x, [int]$y) {
  [Smoke.Native]::SetCursorPos($x, $y) | Out-Null
  # A real WM_MOUSEMOVE so hover states (caption buttons, Snap Layouts) see the pointer.
  [Smoke.Native]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
}

switch ($Action) {
  'move' {
    Move-Cursor $X $Y
    Write-Output "moved to $X,$Y"
  }
  'drag' {
    Move-Cursor $X $Y
    Start-Sleep -Milliseconds 150
    [Smoke.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
    Start-Sleep -Milliseconds 150
    $steps = 20
    for ($i = 1; $i -le $steps; $i++) {
      Move-Cursor ($X + [int]($DX * $i / $steps)) ($Y + [int]($DY * $i / $steps))
      Start-Sleep -Milliseconds 25
    }
    Start-Sleep -Milliseconds 150
    [Smoke.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
    Write-Output "dragged from $X,$Y by $DX,$DY"
  }
  'escape' {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Write-Output 'sent ESC'
  }
  'sendkeys' {
    # Real key events to the foreground window, e.g. '^t' (Ctrl+T), '^+p' (Ctrl+Shift+P), '{F11}'.
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait($Name)
    Write-Output "sent $Name"
  }
  'uia-invoke' {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $found = $null
    while ((Get-Date) -lt $deadline -and -not $found) {
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      # Restrict to top-level windows of the target process first (dialogs are owned windows).
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
      $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      foreach ($b in $buttons) {
        if ($b.Current.Name -eq $Name) { $found = $b; break }
      }
      if (-not $found) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $found) { throw "no button named '$Name' found within $TimeoutSeconds s" }
    $pattern = $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    Write-Output "invoked '$Name' (pid $($found.Current.ProcessId))"
  }
  'dialogs' {
    # Top-level windows of the app's processes, with the text of any native dialog (#32770).
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $pids = @(Get-Process -Name "$ProcessName*" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $out = @()
    foreach ($w in $all) {
      if ($pids -notcontains $w.Current.ProcessId) { continue }
      $entry = [ordered]@{ pid = $w.Current.ProcessId; title = $w.Current.Name; className = $w.Current.ClassName; texts = @(); buttons = @() }
      if ($w.Current.ClassName -eq '#32770' -or $w.Current.Name -match 'error') {
        $texts = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
        foreach ($t in $texts) { $entry.texts += $t.Current.Name }
        $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
        foreach ($b in $btns) { $entry.buttons += $b.Current.Name }
      }
      $out += [pscustomobject]$entry
    }
    [pscustomobject]@{ count = @($out).Count; windows = @($out) } | ConvertTo-Json -Depth 4 -Compress
  }
  'processes' {
    $procs = Get-Process -Name "$ProcessName*" -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        pid = $_.Id
        name = $_.ProcessName
        workingSetMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
        privateMB = [math]::Round($_.PrivateMemorySize64 / 1MB, 1)
        threads = $_.Threads.Count
        mainWindowTitle = $_.MainWindowTitle
        path = $_.Path
        startTime = $(try { $_.StartTime.ToString('o') } catch { $null })
      }
    }
    $total = ($procs | Measure-Object -Property workingSetMB -Sum).Sum
    [pscustomobject]@{ count = @($procs).Count; totalWorkingSetMB = $total; processes = @($procs) } | ConvertTo-Json -Depth 4 -Compress
  }
  'window' {
    $proc = Get-Process -Name "$ProcessName*" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { [pscustomobject]@{ error = 'no process with a main window' } | ConvertTo-Json -Compress; break }
    $h = $proc.MainWindowHandle
    $style = [Smoke.Native]::GetWindowLongPtr($h, -16).ToInt64()
    $ex = [Smoke.Native]::GetWindowLongPtr($h, -20).ToInt64()
    $sb = New-Object System.Text.StringBuilder 256
    [Smoke.Native]::GetClassName($h, $sb, 256) | Out-Null
    $rect = New-Object Smoke.Native+RECT
    [Smoke.Native]::GetWindowRect($h, [ref]$rect) | Out-Null
    $frame = New-Object Smoke.Native+RECT
    [Smoke.Native]::DwmGetWindowAttribute($h, 9, [ref]$frame, 16) | Out-Null
    $flags = @{
      WS_CAPTION = 0x00C00000; WS_THICKFRAME = 0x00040000; WS_MINIMIZEBOX = 0x00020000; WS_MAXIMIZEBOX = 0x00010000
      WS_SYSMENU = 0x00080000; WS_POPUP = 0x80000000; WS_BORDER = 0x00800000; WS_DLGFRAME = 0x00400000
    }
    $set = @()
    foreach ($k in $flags.Keys) { if (($style -band $flags[$k]) -eq $flags[$k]) { $set += $k } }
    $exFlags = @{ WS_EX_APPWINDOW = 0x00040000; WS_EX_TOOLWINDOW = 0x00000080; WS_EX_LAYERED = 0x00080000; WS_EX_NOREDIRECTIONBITMAP = 0x00200000; WS_EX_COMPOSITED = 0x02000000 }
    $exSet = @()
    foreach ($k in $exFlags.Keys) { if (($ex -band $exFlags[$k]) -eq $exFlags[$k]) { $exSet += $k } }
    [pscustomobject]@{
      pid = $proc.Id
      hwnd = $h.ToString()
      title = $proc.MainWindowTitle
      className = $sb.ToString()
      style = ('0x{0:X8}' -f $style)
      styleFlags = ($set | Sort-Object)
      exStyle = ('0x{0:X8}' -f $ex)
      exStyleFlags = ($exSet | Sort-Object)
      windowRect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
      dwmExtendedFrame = @{ left = $frame.Left; top = $frame.Top; right = $frame.Right; bottom = $frame.Bottom }
      iconic = [Smoke.Native]::IsIconic($h)
      zoomed = [Smoke.Native]::IsZoomed($h)
      foreground = ([Smoke.Native]::GetForegroundWindow() -eq $h)
    } | ConvertTo-Json -Depth 4 -Compress
  }
  default { throw "unknown action $Action" }
}
