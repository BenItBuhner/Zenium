; electron-builder's NSIS include for Zenium: (1) removes the installation of the app's former
; name, (2) registers Zenium as a web browser with Windows (further down).
;
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

; ---------------------------------------------------------------------------------------------
; Default-browser registration, the way Chrome registers a per-user install (no admin rights):
;
;   Software\RegisteredApplications            Zenium = <path of the Capabilities key>
;   Software\Clients\StartMenuInternet\Zenium  the browser client: icon, open command,
;     \Capabilities                            ApplicationName / Description / Icon,
;       \URLAssociations                       http, https  -> ZeniumHTML
;       \FileAssociations                      .htm, .html, … -> ZeniumHTML
;       \StartMenu                             StartMenuInternet = Zenium
;   Software\Classes\ZeniumHTML                the ProgID Windows launches: "zenium.exe" "%1"
;   Software\Classes\.html\OpenWithProgids     ZeniumHTML (lists Zenium under "Open with")
;
; Settings > Apps > Default apps lists every application found through RegisteredApplications,
; and only the user can pick one there (Windows 10 and later ignore programmatic changes to the
; user's choice). Nothing here changes a default: no `.html` or `http` class default is written.
; SHELL_CONTEXT is HKCU for the per-user installer electron-builder builds here and HKLM for an
; /allusers install; both are places Windows reads registrations from.
; ---------------------------------------------------------------------------------------------
!define ZENIUM_PROGID "ZeniumHTML"
!define ZENIUM_PROGID_KEY "Software\Classes\${ZENIUM_PROGID}"
!define ZENIUM_CLIENT_KEY "Software\Clients\StartMenuInternet\${PRODUCT_NAME}"
!define ZENIUM_CAPABILITIES_KEY "${ZENIUM_CLIENT_KEY}\Capabilities"
!ifdef APP_DESCRIPTION
  !define ZENIUM_DESCRIPTION "${APP_DESCRIPTION}"
!else
  !define ZENIUM_DESCRIPTION "${PRODUCT_NAME} web browser"
!endif

; Every document type Zenium opens; keep in step with mac.fileAssociations and linux.mimeTypes
; in electron-builder.yml and DOCUMENT_EXTENSIONS in src/shared/launchArgs.ts.
!macro forEachExtension MACRO
  !insertmacro ${MACRO} ".htm"
  !insertmacro ${MACRO} ".html"
  !insertmacro ${MACRO} ".shtml"
  !insertmacro ${MACRO} ".xht"
  !insertmacro ${MACRO} ".xhtml"
  !insertmacro ${MACRO} ".mhtml"
  !insertmacro ${MACRO} ".mht"
  !insertmacro ${MACRO} ".svg"
  !insertmacro ${MACRO} ".webp"
  !insertmacro ${MACRO} ".avif"
  !insertmacro ${MACRO} ".pdf"
!macroend

!macro registerExtension EXT
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CAPABILITIES_KEY}\FileAssociations" "${EXT}" "${ZENIUM_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${ZENIUM_PROGID}"
!macroend

; The extension's default ProgID is left alone unless it is ours (a user who picked Zenium for
; the type through Windows); keys left empty by the removal are dropped too.
!macro unregisterExtension EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${ZENIUM_PROGID}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids"
  ReadRegStr $R7 SHELL_CONTEXT "Software\Classes\${EXT}" ""
  ${if} $R7 == "${ZENIUM_PROGID}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}" ""
  ${endIf}
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\${EXT}"
!macroend

!macro registerDefaultBrowser
  DetailPrint "Registering ${PRODUCT_NAME} as a web browser with Windows"
  ; The browser client Settings > Default apps lists.
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}" "" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegDWORD SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}\InstallInfo" "IconsVisible" 1
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}\InstallInfo" "ReinstallCommand" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --make-default-browser'
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}\InstallInfo" "HideIconsCommand" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hide-icons'
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}\InstallInfo" "ShowIconsCommand" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --show-icons'
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CAPABILITIES_KEY}" "ApplicationDescription" "${ZENIUM_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CAPABILITIES_KEY}" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CAPABILITIES_KEY}\StartMenu" "StartMenuInternet" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CAPABILITIES_KEY}\URLAssociations" "http" "${ZENIUM_PROGID}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_CAPABILITIES_KEY}\URLAssociations" "https" "${ZENIUM_PROGID}"
  ; The ProgID both associations point at. "URL Protocol" marks it as a URL handler too.
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}" "" "${PRODUCT_NAME} HTML Document"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}" "FriendlyTypeName" "${PRODUCT_NAME} HTML Document"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}" "AppUserModelID" "${APP_ID}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}\Application" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}\Application" "ApplicationDescription" "${ZENIUM_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}\Application" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}\Application" "AppUserModelID" "${APP_ID}"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${ZENIUM_PROGID_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro forEachExtension registerExtension
  ; Last, so Settings never sees a half-written registration.
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}" "${ZENIUM_CAPABILITIES_KEY}"
  ; SHCNE_ASSOCCHANGED: the shell re-reads the associations.
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; The user's own http/https choice (UserChoice) is not touched: Windows owns it and asks for a
; new browser by itself once the ProgID it names is gone.
!macro unregisterDefaultBrowser
  DetailPrint "Removing the ${PRODUCT_NAME} web browser registration"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey SHELL_CONTEXT "${ZENIUM_CLIENT_KEY}"
  DeleteRegKey SHELL_CONTEXT "${ZENIUM_PROGID_KEY}"
  !insertmacro forEachExtension unregisterExtension
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  !insertmacro unregisterDefaultBrowser
!macroend

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

  !insertmacro registerDefaultBrowser
!macroend
