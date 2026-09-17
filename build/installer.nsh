; Zenium shipped as "Zen" up to v0.2.0 (appId app.zen-browser.chromium). electron-builder derives
; the NSIS GUID – the uninstall registry key, the install-info key and the "Apps" entry – from the
; appId, so Windows treats Zenium as a program unrelated to Zen and a plain install would leave
; the old copy, its shortcuts and its uninstaller entry behind. This removes that copy by running
; its own uninstaller silently, the way electron-builder replaces a previous version of the same
; GUID (installUtil.nsh, uninstallOldVersion).
;
; User data is kept: the electron-builder uninstaller only deletes %APPDATA% with --delete-app-data,
; which is never passed here, and Zenium moves %APPDATA%\Zen to %APPDATA%\Zenium on its first
; launch (src/main/platform/legacyPaths.ts). Zen was a per-user (HKCU) installation only.
;
; UUID v5 of "app.zen-browser.chromium" in electron-builder's namespace
; 50e065bc-3134-11e6-9bab-38c9862bdaf3 (app-builder-lib/out/targets/nsis/NsisTarget.js).
!define ZEN_LEGACY_GUID "1a1fcb04-afbe-586c-8201-726e3825a77b"
!define ZEN_LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${ZEN_LEGACY_GUID}"
!define ZEN_LEGACY_INSTALL_KEY "Software\${ZEN_LEGACY_GUID}"
!define ZEN_LEGACY_EXECUTABLE "zen.exe"

; The app icon colour picked in Settings → Look and Feel. The running app can change its window
; and taskbar icon, but the Start menu and desktop shortcuts carry the icon the installer gave
; them, so the app records the choice here (src/main/platform/appIcon.ts) and every update
; re-points the shortcuts it just created at the matching multi-size ICO shipped with the app.
!define ZEN_APP_ICON_KEY "Software\Zenium"
!define ZEN_APP_ICON_VALUE "AppIcon"

!macro customInstall
  ; Declared here rather than at file scope: makensis also compiles this script for the
  ; uninstaller, where the macro is not inserted, and treats an unreferenced variable as a
  ; warning (electron-builder turns warnings into errors).
  Var /GLOBAL zenAppIcon
  Var /GLOBAL zenAppIconFile

  ClearErrors
  ReadRegStr $zenAppIcon HKEY_CURRENT_USER "${ZEN_APP_ICON_KEY}" "${ZEN_APP_ICON_VALUE}"
  ${if} $zenAppIcon != ""
    StrCpy $zenAppIconFile "$INSTDIR\resources\app.asar.unpacked\resources\icons\$zenAppIcon\icon.ico"
    ${if} ${FileExists} "$zenAppIconFile"
      ${if} ${FileExists} "$newStartMenuLink"
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$zenAppIconFile" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      ${endIf}
      ${if} ${FileExists} "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$zenAppIconFile" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${endIf}
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
      DetailPrint "Shortcuts use the $zenAppIcon app icon"
    ${endIf}
  ${endIf}
  ClearErrors

  Var /GLOBAL zenLegacyUninstallString
  Var /GLOBAL zenLegacyUninstaller
  Var /GLOBAL zenLegacyInstallDir
  Var /GLOBAL zenLegacyResult

  ClearErrors
  ReadRegStr $zenLegacyUninstallString HKEY_CURRENT_USER "${ZEN_LEGACY_UNINSTALL_KEY}" UninstallString
  ${if} $zenLegacyUninstallString != ""
    DetailPrint "Removing the previous Zen installation (Zen is now Zenium; your data is kept)"
    !insertmacro GetInQuotes $zenLegacyUninstaller "$zenLegacyUninstallString"
    ReadRegStr $zenLegacyInstallDir HKEY_CURRENT_USER "${ZEN_LEGACY_INSTALL_KEY}" InstallLocation
    ${if} $zenLegacyInstallDir == ""
    ${andIf} $zenLegacyUninstaller != ""
      Push $zenLegacyUninstaller
      Call GetFileParent
      Pop $zenLegacyInstallDir
    ${endIf}

    ${if} ${FileExists} "$zenLegacyUninstaller"
      ; A running Zen would keep its files busy. Ask it to close first (WM_CLOSE lets it flush its
      ; session to disk), then insist.
      nsExec::Exec '"$SYSDIR\cmd.exe" /C taskkill /FI "USERNAME eq %USERNAME%" /IM ${ZEN_LEGACY_EXECUTABLE}'
      Pop $zenLegacyResult
      ${if} $zenLegacyResult == 0
        Sleep 3000
        nsExec::Exec '"$SYSDIR\cmd.exe" /C taskkill /F /FI "USERNAME eq %USERNAME%" /IM ${ZEN_LEGACY_EXECUTABLE}'
        Pop $zenLegacyResult
        Sleep 500
      ${endIf}

      ; Run a copy of the uninstaller so it can delete its own directory (_?= makes it run in place
      ; and lets ExecWait wait for it). --updated selects the careful file removal and, together
      ; with the absence of --delete-app-data, keeps %APPDATA%; shortcuts and registry entries go.
      ClearErrors
      CopyFiles /SILENT /FILESONLY "$zenLegacyUninstaller" "$PLUGINSDIR\zen-uninstaller.exe"
      ${if} ${Errors}
        ExecWait '"$zenLegacyUninstaller" /S /KEEP_APP_DATA --updated /currentuser _?=$zenLegacyInstallDir' $zenLegacyResult
      ${else}
        ExecWait '"$PLUGINSDIR\zen-uninstaller.exe" /S /KEEP_APP_DATA --updated /currentuser _?=$zenLegacyInstallDir' $zenLegacyResult
      ${endIf}
      ${if} $zenLegacyResult == 0
        DetailPrint "Zen was removed"
      ${else}
        DetailPrint "Could not remove Zen automatically (uninstaller exit code $zenLegacyResult); remove it from Settings > Apps"
      ${endIf}
    ${else}
      ; The entry survived its program: nothing to run, drop the stale keys.
      DeleteRegKey HKEY_CURRENT_USER "${ZEN_LEGACY_UNINSTALL_KEY}"
      DeleteRegKey HKEY_CURRENT_USER "${ZEN_LEGACY_INSTALL_KEY}"
    ${endIf}
  ${endIf}
  ClearErrors
!macroend
