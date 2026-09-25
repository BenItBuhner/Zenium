# Desktop smoke

Playwright-for-Electron scenarios against a packaged build, run by `ci.yml` (the unpacked
Linux build under Xvfb) and `desktop-smoke.yml` (installers on Windows, macOS and Linux). The
header of `smoke.mjs` documents the scenarios, options and exit codes; `verdict.mjs` aggregates
the `result.json` files of a run; `known-failures.json` names the tolerated failures.

Locally, on Linux:

```sh
npx electron-vite build && npx electron-builder --linux --dir --publish never
xvfb-run -a -s '-screen 0 1600x1000x24' node .github/smoke/smoke.mjs \
  --exe dist/linux-unpacked/zenium --label unpacked --out /tmp/smoke-out \
  --scenarios boot,restore,crash,walkthrough --extra-args="--no-sandbox --disable-gpu"
node .github/smoke/verdict.mjs --out /tmp/smoke-out --expect unpacked
```

## Sandboxed legs

A `--no-sandbox` leg cannot observe the worker-preload layer: Electron evaluates a session's
`service-worker` preload scripts in sandboxed renderers only, so Zenium's `chrome.*` layer for
MV3 background workers (`src/preload/extension.ts`) is simply not there in a worker started
under `--no-sandbox`, and a check on it that passes there checks the wrong thing. The
`mv3-worker` scenario therefore runs twice in `ci.yml`: sandboxed (`--sandbox`, no
`--no-sandbox`; the layer must be present) and under `--no-sandbox` (the negative: the layer must
be absent). Where the kernel denies unprivileged user namespaces (ubuntu-24.04's AppArmor
default) the sandboxed launch needs the build's `chrome-sandbox` helper setuid root, as the
installers leave it. The leg's arguments are what the app gets: Playwright 1.63's Electron
launcher would add `--no-sandbox` on Linux by itself, so the smoke launches with
`chromiumSandbox: true` and the `--no-sandbox` legs pass the switch themselves; and since
Electron takes `ELECTRON_DISABLE_SANDBOX` in the environment as the same switch, a `--sandbox`
leg drops it from the launch's environment (the result's `sandbox` facts say whether the run's
environment carried it, `envDisableSandbox` / `envDisableSandboxDropped`):

```sh
sudo chown root:root dist/linux-unpacked/chrome-sandbox && sudo chmod 4755 dist/linux-unpacked/chrome-sandbox
xvfb-run -a -s '-screen 0 1600x1000x24' node .github/smoke/smoke.mjs \
  --exe dist/linux-unpacked/zenium --label mv3-worker-sandboxed --out /tmp/smoke-out \
  --scenarios mv3-worker --sandbox --extra-args="--disable-gpu"
```

The fixture extension lives under `fixtures/mv3-worker` (its worker logs the `chrome` surface it
starts with; the hook in `smoke.mjs` reads the line off the session's ServiceWorkers console).

## Windows installer

`win-install.ps1` installs the NSIS build silently and uninstalls it, and judges the
default-browser registration `build/installer.nsh` writes for the user: after the install every
key and value of the Chrome-style set (`Software\RegisteredApplications`, the
`Clients\StartMenuInternet\Zenium` client and its `Capabilities` with the `http`/`https` and
document-type associations, the `ZeniumHTML` ProgID and each type's `OpenWithProgids`) has to be
there and point at the installed executable (`registrationProblems` in
`installed-install.json`); after the uninstall none of it may be left, no document type may
still name the ProgID, and the `AppUserModelId` class key the running app writes for its toasts
(`HKCU\Software\Classes\AppUserModelId\<id>`, read along for the record after the install as
the unpacked build left it) has to be gone with it – `installer.nsh`'s `customUnInstall`
deletes it (`registrationLeftovers` in `installed-uninstall.json`, read until gone, up to 10 s,
never once; `registrationLeftoverRounds` says how many reads). Either list non-empty fails its
step in `desktop-smoke.yml` with the lines. `-Action registration -Exe <exe> -Stage <name>` reads
the same set back for a build under test without judging it (the `default-browser` scenario
below does), and with it the per-user `http`/`https` classes and the user's own choice
(`UserChoice`) – Windows's, read for the record only and never written.

## Windows notifications (`notifications`)

`notifications-scenario.mjs` runs on both Windows legs (the unpacked build and the installed
one) for os-27, os-28 and os-30, with `win-toast.ps1` reading the OS's side. The profile is past
onboarding and its `zen/permissions.json` already allows notifications for the fixture origin,
so the page reads `Notification.permission === 'granted'` and `new Notification()` goes straight
to the platform. The workflow runs it first on each leg, so its launch is the leg's first launch
of that build and the `app-id-registered` step meets the class key as the leg starts (no key on
the runner's first run, the unpacked build's on the installed leg) rather than one an earlier
scenario's launch already rewrote. Each step says who confirms it:

| step                 | reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | confirmed by                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `permission-granted` | the page's `Notification.permission` through the page preload's shim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | the app (its store)              |
| `app-id-registered`  | `HKCU\Software\Classes\AppUserModelId\<id>`: `DisplayName` = the app name, `IconUri` on disk and under the running executable's directory (`src/main/platform/notifications.ts` writes it for a copy without installer shortcuts and refreshes a value another copy left; polled, the write is asynchronous). The key is read before the launch as well – the installed leg meets the unpacked build's icon path, a leg with no key (the runner's first run) seeds a stale one (`win-toast.ps1 -Action seed-app-id`: a foreign `DisplayName`, an `IconUri` naming the scenario file) – and the step's `refresh` says how it moved (`before` → `after`, `changed`, `registered` / `refreshed`) | the OS's registry                |
| `shortcut-aumid`     | the installed shortcuts' `System.AppUserModel.ID` (the installer's `WinShell::SetLnkAUMI`; installed build only, the unpacked build has no shortcut)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | the OS's shell                   |
| `fire`               | `show` fired in the page, no `error`; Electron's toast log (`ELECTRON_DEBUG_NOTIFICATIONS=1`) says `Notification created` – ToastNotifier.Show returned S_OK – and reports no `WinAPI: … failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the platform accepted the toast  |
| `os-toast`           | `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<id>`, the per-sender key Windows creates once an app has shown a toast and Settings › System › Notifications lists senders from (os-30's source) – gates; the banner windows (`Windows.UI.Core.CoreWindow` "New notification"), the platform's store (`wpndatabase.db`) scanned for the id and the title, its event log (`Microsoft-Windows-PushNotification-Platform/Operational` event 3153: "Toast … is delivered to `<id>`") and a UI Automation click on the banner – recorded as the readings `banner`, `store`, `delivered`, `osClick`                                                                         | the OS                           |
| `click-reveals-tab`  | with another tab active, the notification's `click` dispatched in the page under a user gesture: `onclick` → `window.focus()` → the preload's `zen:page {type:'focus'}` (the hook records it) → the core's `revealTab`: the tab active again, the window's `show()`/`focus()` called                                                                                                                                                                                                                                                                                                                                                                                                          | the app's path from `onclick` on |

What no runner confirms: the banner itself (the runner's session showed none – WIN-006 on
Server 2025 – so the click on it is best effort and its reading `osClick` says whether it went
anywhere), Chromium's routing of an OS toast activation to the page's `onclick` (the one link the
dispatched click does not exercise), whether Windows hands the foreground to the window
(`windowFocused` is recorded, not judged), the Settings page's visual entry and Focus Assist.

## Windows restart registration (`restart-registration`)

`restart-scenario.mjs` runs on both Windows legs for os-49 – Windows bringing Zenium back with
its session after a restart or a sign-out. Electron 44 has no `RegisterApplicationRestart`, so
`src/main/platform/restartRegistration.ts` uses the alternative Windows offers every app: when a
window's `session-end` says the session is ending (Electron raises it off `WM_ENDSESSION`; past
that point the process is ended by Windows), the relaunch command goes under the user's
`RunOnce` key (`HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce\Zenium[.<hash of the
profile's path>]`), which Windows runs once at the next sign-in – gated on the user's
"Automatically save my restartable apps and restart them when I sign back in" toggle
(`Winlogon\RestartApps`; absent means the OS default: on since Windows 11, off on Windows 10); a
clean quit takes the entry back. No runner restarts: the scenario emits the events on the running
app from the main process and reads what Windows would run off the registry (`win-restart.ps1`);
the toggle is set on for the run and put back as it was, the entry deleted at the end.

| step                      | reads                                                                                                                                                                                                                                          | confirmed by                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `toggle-on`               | `RestartApps` before the run (restored at the end), then set to 1; a leftover entry of an earlier run removed                                                                                                                                  | the OS's registry                       |
| `session-end-registers`   | `session-end` `{reasons:['shutdown']}` on the main window: this profile's RunOnce value holds `<exe> "--user-data-dir=<profile>" --restore-last-session` (the running executable, the profile the app resolved); the `[zen] restart:` line says so | the app's handler, the OS's registry    |
| `clean-quit-unregisters`  | `will-quit` on the app: the value gone (the app stays up – the emit is the quit's event alone)                                                                                                                                                | the app's handler, the OS's registry    |
| `toggle-off-skips`        | `RestartApps` = 0, `session-end` again: no value; the line says the toggle is off                                                                                                                                                              | the app's handler, the OS's registry    |
| `close-app-skips`         | `RestartApps` = 1, `session-end` `{reasons:['close-app']}` (the Restart Manager closing the app for an installer, which restarts it itself): no value; the line says no sign-in follows                                                     | the app's handler, the OS's registry    |
| `registration-survives`   | `session-end` `{reasons:['logoff']}` registers again; the process is ended the way Windows ends it after `WM_ENDSESSION` (`taskkill /F`): the value stands – what the next sign-in would run                                                    | the OS's registry                       |
| `cleanup`                 | the value deleted; the toggle put back                                                                                                                                                                                                         | the OS's registry                       |

What no runner confirms: the sign-in itself (RunOnce processed by the shell at the user's next
sign-in, the app up with `--restore-last-session`), and that Windows delivers `WM_ENDSESSION`
to the window in time for the write on a real shutdown (the events are emitted, not received).

## Windows private windows' taskbar group (`private-taskbar`)

`private-taskbar-scenario.mjs` runs on both Windows legs for os-56. Windows groups taskbar
buttons by AppUserModelID, so a private window's frame carries a second id – the app's with
`.private` – with the private icon (the mask on the private purple, `resources/icons/private/`)
and a relaunch command that opens a private window; the main process registers that id's class
key beside the app's (`notifications.ts`), which the installer's uninstall check sees gone. The
taskbar cannot be asked what buttons it shows, so the facts are read where Windows reads them:
the window's shell property store (`win-taskbar.ps1`, `SHGetPropertyStoreForWindow` on every
top-level window of the process) and the registry.

| step                      | what is read                                                                                                                                                                                                                                | confirmed by                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `open-private-window`     | `window.newPrivate` from the main window's chrome: a second `BrowserWindow`, visible, titled `… (Private)`, with its frame handle                                                                                                            | the app                                 |
| `private-window-grouped`  | that frame's `System.AppUserModel.ID` = `<app id>.private`, `RelaunchCommand` = this executable, `--user-data-dir=<this profile>`, `--private-window`, `RelaunchDisplayNameResource` = `Zenium (Private)`; the main window's frame carries no id of its own | the OS's shell                          |
| `private-icon`            | `RelaunchIconResource` = `<…\private\icon.ico>,0`, the file on disk under the running build's directory                                                                                                                                   | the OS's shell, the file system         |
| `class-key`               | `HKCU\Software\Classes\AppUserModelId\<app id>.private`: `DisplayName` the group's name, `IconUri` the private `icon.png` under the build's directory (polled: written after `browser.start`)                                                | the OS's registry                       |
| `taskbar-still`           | a screenshot with both windows up – recorded, not judged (the runner's session may show no taskbar)                                                                                                                                       | –                                       |
| `close-private-window`    | the private window closed from the main process; one window remains                                                                                                                                                                       | the app                                 |

What no runner confirms: the taskbar drawing two buttons (the still shows it when the session
has a taskbar), and a click on a pinned "Zenium (Private)" button running the relaunch command
(the command is asserted; the shell's launch of it is not exercised).

## macOS default browser (`default-browser`)

`default-browser-scenario.mjs` runs last on the macOS legs for os-07. LaunchServices asks the
user before changing the default web browser ("Do you want to change your default web browser
to “Zenium” or keep using “Safari”?"), so the app's half is asserted, the OS's recorded, and
where the session lets a script answer the dialog the app's follow-through on the yes is
asserted too: `bundle-claims-web` reads the bundle's `CFBundleURLTypes` for `http` and `https`
(electron-builder's `protocols`; gates); `handlers-before` and `handlers-after` read
`LSHandlers` out of `com.apple.launchservices.secure` (who holds `http`/`https`; no entry means
Safari; after a yes both should name the bundle id – recorded as `namesApp`, the file given up
to 20 s to catch up with the API, which `lsd` writes it behind);
`make-default-calls-ls` wraps `app.setAsDefaultProtocolClient` in the main process, fires
`defaultBrowser.request` (the Settings row's source, not awaited: it polls for the user's answer
for two minutes) and requires the request for `http` first and alone – `https` only once `http`
is held, or the OS puts a second prompt up – recording what LaunchServices returned; `os-dialog`
takes the screen, scans every process's windows through System Events for the dialog (its
"default web browser" text or its "Use …"/"Keep …" buttons, whoever owns it – the app's own
windows excepted) and presses "Use" when found (UI scripting needs the Accessibility
permission: the GitHub runners grant it, a fresh Mac says `not automatable`). After a click,
LaunchServices reporting `http` held is the OS's yes (recorded – an ad-hoc-signed bundle may be
refused); given the yes the app must see to `https` (`macClaimHttps`: look at it, and claim it
unless the yes already covered it – macOS 26 sets both schemes on the one yes) and resolve the
request `true` (gates), and a second scan records whether a claim put another dialog up (it is
meant not to). `mac-facts.sh` prints the same `LSHandlers` before and after the run and,
after it, LaunchServices' own record of the bundle (`lsregister -dump`: what the dialog names
the app from) and the unified log's LaunchServices lines.

## Windows default browser (`default-browser`)

The same scenario runs last on both Windows legs for ci-08's registry read (its LaunchServices
steps skip there). Since Windows 8 only the user picks a default browser, in Settings › Apps ›
Default apps, so the app claims no scheme on Windows: `defaultBrowser.request` reads the shell's
association, then whether the installer's `RegisteredApplications\Zenium` entry is there (what
Settings lists the app from), and opens the app's own Default apps page for the user to press
"Set default" (`src/main/platform/defaultBrowser.ts`, `windowsRequest`) –
`app.setAsDefaultProtocolClient` would write `HKCU\Software\Classes\http\shell\open\command`, a
class the user's choice overrides and the uninstaller does not know. Each step says who confirms
it:

| step                          | reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | confirmed by                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `registration-before`         | `win-install.ps1 -Action registration`: `RegisteredApplications\Zenium`, the `StartMenuInternet` client and its `Capabilities`, the `ZeniumHTML` ProgID – complete and pointing at the executable under test for the installed build (gates), recorded for the unpacked one (not registered: its leg runs before the install); the per-user `http`/`https` classes and the user's `UserChoice` as they stand; the state's `defaultBrowser.isDefault` (the core's read at start)                                                                           | the OS's registry                    |
| `make-default-opens-settings` | `defaultBrowser.request` (the Settings row's source) with `app.setAsDefaultProtocolClient` / `removeAsDefaultProtocolClient` and `shell.openExternal` wrapped in the main process: registered, the deep link `ms-settings:defaultapps?registeredAppUser=Zenium` is opened first (the plain `ms-settings:defaultapps` only after the OS refused it; Windows 10 gets the plain page alone) and the request waits for the user's choice; not registered, nothing is opened and the request resolves `false` at once; no scheme is claimed either way (gates) | the app's path up to the OS's window |
| `os-settings-page`            | three seconds after the open: the screen, the `SystemSettings` processes and their window title (`win-session.ps1 -Action processes -ProcessName SystemSettings`) – recorded – then Settings closed (`-Action kill`) so nothing is left for the legs after                                                                                                                                                                                                                                                                                                | the OS (recorded)                    |
| `registry-after`              | the registration again – intact for the installed build (gates); `HKCU\Software\Classes\http\shell\open\command` and `https`: neither may name the executable (the class only a `setAsDefaultProtocolClient` call would have left; gates); the user's choice again, for the record; the state's `defaultBrowser.isDefault` false unless the user's choice names `ZeniumHTML` for both schemes – on the runners it never does, so `true` would mean the status reads a class write rather than the choice (gates)                                          | the OS's registry, the app's status  |

What no runner confirms: the user's "Set default" press in Settings (no runner presses it, so
`awaitChoice`'s poll and the `true` it resolves on the yes stay unexercised), and whether the
deep link lands on Zenium's page rather than the list (the screenshot shows what came up).

## Teardown

Removing a tree a launched build wrote into retries or polls, never a plain `rmSync`: Chromium's
helpers (the network service, the GPU process) flush into `Partitions/<name>` for a moment after
the browser process is gone, and a plain removal met that on #392's run (`ENOTEMPTY` on
`Partitions/zen-default` after every check had passed). Every teardown `rmSync` here and in
`.github/scripts` runs with `{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }`;
the sign-in smoke's profile removal goes through `.github/scripts/remove-tree.mjs`, which repeats
the pass until the tree is gone – Node's `maxRetries` retries only the failing `rmdir` and never
sees an entry created after the walk read the directory.
