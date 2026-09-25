# The taskbar-grouping facts of a process's windows: what `BrowserWindow.setAppDetails`
# (src/main/platform/window.ts, the private windows' second AppUserModelID of
# src/main/platform/privateTaskbar.ts) wrote into each top-level window's shell property store –
# the properties Windows groups taskbar buttons by and relaunches from.
#
#   -Action windows -ProcessId <pid>
#       Every top-level window of the process: hwnd, title, class, visibility, and off its
#       property store (SHGetPropertyStoreForWindow) System.AppUserModel.ID, .RelaunchCommand,
#       .RelaunchIconResource and .RelaunchDisplayNameResource – $null where the window carries
#       none (a window on the process's default id).
#
# Prints one JSON document.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$ProcessId = 0
)

$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace SmokeTaskbar {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
    public PropertyKey(Guid f, uint p) { fmtid = f; pid = p; }
  }

  // PROPVARIANT: the type at 0, three reserved words, the union at 8 (on either bitness). The
  // union is two pointer-sized words (24 bytes in all on x64, 16 on x86): the struct has to be
  // that size, or GetValue's out-marshalling writes past the buffer the runtime gives it.
  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr p;
    [FieldOffset(16)] public IntPtr p2;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PropertyKey pkey);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant pv);
    [PreserveSig] int Commit();
  }

  public static class Native {
    [DllImport("shell32.dll", PreserveSig = false)]
    public static extern void SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, [Out, MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PropVariant pvar);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);

    // PKEY_AppUserModel_*: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3} with the property ids of propkey.h.
    static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    const uint RelaunchCommand = 2, RelaunchIconResource = 3, RelaunchDisplayNameResource = 4, ID = 5;
    const ushort VT_EMPTY = 0, VT_LPWSTR = 31;

    static string Read(IPropertyStore store, uint pid) {
      var key = new PropertyKey(AppUserModel, pid);
      PropVariant pv;
      int hr = store.GetValue(ref key, out pv);
      if (hr != 0) return "<hresult 0x" + hr.ToString("x8") + ">";
      try {
        if (pv.vt == VT_LPWSTR) return Marshal.PtrToStringUni(pv.p);
        if (pv.vt == VT_EMPTY) return null;
        return "<vt " + pv.vt + ">";
      } finally { PropVariantClear(ref pv); }
    }

    public static Dictionary<string, object> Window(IntPtr hwnd) {
      var d = new Dictionary<string, object>();
      d["hwnd"] = hwnd.ToInt64();
      var title = new StringBuilder(1024); GetWindowText(hwnd, title, 1024); d["title"] = title.ToString();
      var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256); d["class"] = cls.ToString();
      d["visible"] = IsWindowVisible(hwnd);
      try {
        var iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
        d["appUserModelId"] = Read(store, ID);
        d["relaunchCommand"] = Read(store, RelaunchCommand);
        d["relaunchIconResource"] = Read(store, RelaunchIconResource);
        d["relaunchDisplayName"] = Read(store, RelaunchDisplayNameResource);
        Marshal.ReleaseComObject(store);
      } catch (Exception e) { d["error"] = e.Message; }
      return d;
    }

    public static List<Dictionary<string, object>> WindowsOf(uint pid) {
      var list = new List<Dictionary<string, object>>();
      EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) list.Add(Window(h)); return true; }, IntPtr.Zero);
      return list;
    }
  }
}
'@

switch ($Action) {
  'windows' {
    if ($ProcessId -le 0) { throw 'windows needs -ProcessId' }
    $windows = @([SmokeTaskbar.Native]::WindowsOf([uint32]$ProcessId) | ForEach-Object {
      $w = [ordered]@{}
      foreach ($k in @('hwnd', 'title', 'class', 'visible', 'appUserModelId', 'relaunchCommand', 'relaunchIconResource', 'relaunchDisplayName', 'error')) {
        if ($_.ContainsKey($k)) { $w[$k] = $_[$k] } else { $w[$k] = $null }
      }
      $w
    })
    [ordered]@{ processId = $ProcessId; windows = $windows } | ConvertTo-Json -Depth 4
  }
  default { throw "unknown action $Action" }
}
