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

Electron evaluates a session's `service-worker` preload scripts in its sandboxed renderer client
only, and picks that client for a renderer when `--enable-sandbox` is on its command line or
`--no-sandbox` is not. Zenium's `chrome.*` layer for MV3 background workers
(`src/preload/extension.ts`) is such a preload, so a plain `--no-sandbox` launch used to start
every worker without it; the app now asks for the client itself (`--enable-sandbox` appended
before `ready`, `src/main/platform/sandbox.ts` – not for root on Linux, where Electron refuses
it; not `app.enableSandbox()`, which would also strip `--no-sandbox` from the launch), and
the layer is there whatever the OS sandbox does. The `mv3-worker` scenario runs twice in
`ci.yml` and expects the layer both times: sandboxed (`--sandbox`, no `--no-sandbox`; the layer
with the OS sandbox on) and under `--no-sandbox` (the layer by the app's own switch – the
in-house fix's proof; the app must carry `--enable-sandbox`, and its startup self-check for a
preload that did not run must stay silent). Where the kernel denies unprivileged user
namespaces (ubuntu-24.04's AppArmor default) the sandboxed launch needs the build's
`chrome-sandbox` helper setuid root, as the installers leave it. The leg's arguments are what
the app gets: Playwright 1.63's Electron
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

## reCAPTCHA v2 (`recaptcha`, allow-network)

The one scenario that leaves the loopback fixture: it opens Google's own reCAPTCHA v2 demo
(`https://www.google.com/recaptcha/api2/demo`) in a tab and requires the widget's anchor frame
and then its challenge frame (`bframe`) within 10 s of the load, one trusted click at the
checkbox to tick it (`aria-checked=true`) or put the image challenge up within 20 s (a fresh
profile on an automated build gets the challenge – either is the widget's handshake at work),
and no `reCAPTCHA Timeout` or permissions-policy violation among the tab's console lines once
the widget's 15 s timer window has passed (W5-P1: the anchor asks the Storage Access API for its
cookies before it answers, and a permission prompt left pending there stalled the widget until
that timer). The harness reaches `www.google.com` first (a HEAD within 8 s); when it cannot, the
scenario is recorded as `skipped: network` with the reason in `result.json` and the log, and the
verdict stays green – the result carries `network: "allow-network"` either way.

```sh
xvfb-run -a -s '-screen 0 1600x1000x24' node .github/smoke/smoke.mjs \
  --exe dist/linux-unpacked/zenium --label recaptcha --out /tmp/smoke-out \
  --scenarios recaptcha --extra-args="--no-sandbox --disable-gpu"
```

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

| step                     | reads                                                                                                                                                                                                                                              | confirmed by                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `toggle-on`              | `RestartApps` before the run (restored at the end), then set to 1; a leftover entry of an earlier run removed                                                                                                                                      | the OS's registry                    |
| `session-end-registers`  | `session-end` `{reasons:['shutdown']}` on the main window: this profile's RunOnce value holds `<exe> "--user-data-dir=<profile>" --restore-last-session` (the running executable, the profile the app resolved); the `[zen] restart:` line says so | the app's handler, the OS's registry |
| `clean-quit-unregisters` | `will-quit` on the app: the value gone (the app stays up – the emit is the quit's event alone)                                                                                                                                                     | the app's handler, the OS's registry |
| `toggle-off-skips`       | `RestartApps` = 0, `session-end` again: no value; the line says the toggle is off                                                                                                                                                                  | the app's handler, the OS's registry |
| `close-app-skips`        | `RestartApps` = 1, `session-end` `{reasons:['close-app']}` (the Restart Manager closing the app for an installer, which restarts it itself): no value; the line says no sign-in follows                                                            | the app's handler, the OS's registry |
| `registration-survives`  | `session-end` `{reasons:['logoff']}` registers again; the process is ended the way Windows ends it after `WM_ENDSESSION` (`taskkill /F`): the value stands – what the next sign-in would run                                                       | the OS's registry                    |
| `cleanup`                | the value deleted; the toggle put back                                                                                                                                                                                                             | the OS's registry                    |

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

| step                     | what is read                                                                                                                                                                                                                                                | confirmed by                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `open-private-window`    | `window.newPrivate` from the main window's chrome: a second `BrowserWindow`, visible, titled `… (Private)`, with its frame handle                                                                                                                           | the app                         |
| `private-window-grouped` | that frame's `System.AppUserModel.ID` = `<app id>.private`, `RelaunchCommand` = this executable, `--user-data-dir=<this profile>`, `--private-window`, `RelaunchDisplayNameResource` = `Zenium (Private)`; the main window's frame carries no id of its own | the OS's shell                  |
| `private-icon`           | `RelaunchIconResource` = `<…\private\icon.ico>,0`, the file on disk under the running build's directory                                                                                                                                                     | the OS's shell, the file system |
| `class-key`              | `HKCU\Software\Classes\AppUserModelId\<app id>.private`: `DisplayName` the group's name, `IconUri` the private `icon.png` under the build's directory (polled: written after `browser.start`)                                                               | the OS's registry               |
| `taskbar-still`          | a screenshot with both windows up – recorded, not judged (the runner's session may show no taskbar)                                                                                                                                                         | –                               |
| `close-private-window`   | the private window closed from the main process; one window remains                                                                                                                                                                                         | the app                         |

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

## A page's visibilityState follows its window (`visibility`)

`visibility-scenario.mjs` (W6-F6) runs on the Linux job (its own step), the Windows unpacked leg
and the macOS legs. A Chrome tab's `document.visibilityState` is `hidden` while its window is
minimised, hidden, or fully covered where the OS tracks occlusion (Windows, macOS), and
`visible` through a blur that leaves the window on screen; Zenium's tab views are
`WebContentsView`s the host shows and hides itself, and W6-F6 has the window host take them down
to Chromium while the window is minimised or hidden (`src/main/platform/window.ts`,
`ElectronTabView.applyWindowVisible`) – a view parked under a chrome cover (W6-F5) included,
parked again when the window returns. The scenario installs a logger in the fixture's first page
(every `visibilitychange`, stamped) and moves the main window from the main process; each move
Chrome reports as one transition has to be exactly one event here (a flicker is a failure).
`native-forwarding` first makes the same moves on a throwaway `BrowserWindow` +
`WebContentsView` created in the app's process, with no host logic in between – what Electron
forwards natively on the OS, recorded and not judged (the slice's "before" column).

One harness detail this scenario needs: Playwright turns `Emulation.setFocusEmulationEnabled` on
for every page it attaches, which pins `document.visibilityState` to `visible` whatever the window
does. Left on, every reading here would be `visible`. `s.honestVisibility` turns it back off (per
page, through the page's own CDP session) for the tab it reads and for the throwaway native view,
so both follow their window as a user's page does; no other scenario changes it. (The earlier
report that a page never reads `hidden` on Xvfb was this pin, not the platform.)

| step                 | reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | confirmed by                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `page-visible`       | the page in a tab, its view shown in its box, the window in front: `visible`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the page                                     |
| `native-forwarding`  | the throwaway window minimised, restored, hidden, shown, covered whole, uncovered, covered in part, uncovered: the throwaway page's state and events per move, with the window's own state and events – recorded                                                                                                                                                                                                                                                                                                                                                                                                                                | Electron, natively (recorded)                |
| `minimize`           | `minimize()`: `hidden`, one event, the tab view hidden to Chromium (`getVisible()` false). Under Xvfb (no window manager) `minimize()` does nothing – the step records `skipped` with that reason and the page has to stay `visible` with no event                                                                                                                                                                                                                                                                                                                                                                                              | the page, the view                           |
| `restore`            | `restore()`: `visible`, one event, the view back in its box (`skipped` where minimize was)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the page, the view                           |
| `hide`               | `hide()`: the window not visible, `hidden`, one event, the view hidden to Chromium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the page, the view                           |
| `show`               | `show()`: `visible`, one event, the view back in its box                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the page, the view                           |
| `blur-partial-cover` | a window of the harness's own over the top-left quarter of the main window, focused (the main window blurs): `visible`, no event; the cover closed: the same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the page                                     |
| `blur-full-cover`    | a window over the whole of the main window and a margin beyond: Windows and macOS, where this display reported occlusion to the bare window of `native-forwarding` (its `cover-full` row `hidden`) – `hidden`, one event (Chromium's native occlusion tracking; gates), `visible` again with one event once the cover closes; elsewhere recorded – Linux (the X server's word: Xvfb reports the window fully obscured and the page reads `hidden`, a compositing desktop does not) and the macOS arm64 runner, whose virtual display reports no occlusion to any window (the page stays `visible`) – the events exactly the flips that happened | the OS's occlusion tracking through the page |
| `parked-under-cover` | the Web capture overlay (`capture.start`) parks the page's view (shown, one pixel in a window corner; W6-F5) and the page reads `visible`; `hide()` takes the parked view down for real (hidden, its box its own) and the page reads `hidden`; `show()` parks it again and the page reads `visible`; the overlay stays up throughout; Escape closes it and the view is back in its box                                                                                                                                                                                                                                                          | the page, the view                           |

The screenshots of a window minimised or under a cover are taken as the screen stands
(`s.shotAsIs`): `s.shot` brings the app's window to the front first, and `show()` un-minimises a
window on Windows and macOS – the first run's `minimize` step had its view back up before it was
checked, on all four legs.

What no runner confirms: a real desktop's minimise on Linux (Xvfb has no window manager, so the
hide / show pair stands in), a compositing Linux desktop's occlusion (none, as Chrome's), and
occlusion on an Apple-silicon Mac (the arm64 runner's display reports none; macOS x64 confirms
the OS's tracking).

## The macOS menu bar (`menu-bar`)

`menu-bar-scenario.mjs` (W7-4, W8-4; shortcuts-menus-160, -162, -123) runs on the macOS legs,
and its one `no-bar` step on the Windows unpacked leg and the Linux job. The bar is the core's model
(`src/core/menuBar.ts`, built pure and tested on Linux by `menuBar.test.ts`) handed to Electron's
`Menu.setApplicationMenu` on macOS alone (`src/main/platform/menus.ts`); off macOS the main
process sets none (`Menu.setApplicationMenu(null)`). The scenario reads
`Menu.getApplicationMenu()` from the app's main process through the harness – labels, types,
roles, enabled states and accelerators two levels deep – and judges it against the model's
promise. A native menu is not on the window's pixels until it is open, so no screenshot judges
anything here; the readings are the main process's own. The Tab menu's chords are the Chrome
preset's (a fresh profile's), written out in `TAB_MENU_CHORDS`; `menuBar.test.ts` holds the bar
to the key table itself, so a rebinding shows up there, not here.

| step                     | reads                                                                                                                                                                                                                                                                                                                                                                                                                                | confirmed by                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `menus`                  | Zenium, File, Edit, View, History, Bookmarks, Tab, Window, Help – Chrome's order less Profiles; Window and Help under the host's `window` and `help` roles (the Help menu's Search field)                                                                                                                                                                                                                                            | the main process             |
| `tab-menu-new-tab-page`  | the Tab menu with the fresh profile's one new tab page in front: New Tab Below, Select Next Tab ⌃⇥, Select Previous Tab ⌃⇧⇥, Duplicate Tab ⇧⌘K, Mute Site (greyed: no site), Pin Tab ⌃⌘P, Add Tab to New Folder, Remove from Folder (greyed), Close Other Tabs and Close Tabs Below (greyed: nothing to close), Move Tab to New Window (greyed: one tab alone, as Chrome greys it), Add Tab to New Split View ⇧⌘\*, Search Tabs… ⇧⌘A | the main process             |
| `help-menu-new-tab-page` | the Help menu with the new tab page in front: What's New, a separator, Zenium Help, Keyboard Shortcuts, Report an Issue… ⌥⇧⌘I, Report an Unsafe Site… (greyed: no http(s) URL to report); no About Zenium (the application menu's)                                                                                                                                                                                                   | the main process             |
| `tab-menu-site-page`     | the fixture's first page in a new tab in front and its second in a tab below: Mute Site, Close Other Tabs, Close Tabs Below and Move Tab to New Window enabled, the rest as before                                                                                                                                                                                                                                                   | the main process             |
| `tab-menu-orientation`   | `settings.update { toolbarLayout: 'horizontal' }`: the two direction rows read New Tab to the Right and Close Tabs to the Right, the rest as before; the layout written back, they read Below again                                                                                                                                                                                                                                  | the main process             |
| `tab-menu-toggles`       | Pin Tab picked through the item's own `click` reads Unpin Tab once the bar is redrawn (Add Tab to New Folder greyed for the pinned tab), Unpin Tab picked reads Pin Tab; Mute Site picked reads Unmute Site, Unmute Site picked reads Mute Site                                                                                                                                                                                      | the main process             |
| `help-menu`              | the Help menu with the site page in front: the rows of `help-menu-new-tab-page` with Report an Unsafe Site… enabled (an http(s) URL to report), Report an Issue… the one chord row, no About Zenium                                                                                                                                                                                                                                  | the main process             |
| `about-row`              | the application menu's first row About Zenium: enabled, a plain row of Zenium's own (no `about` role); picked, the Settings page opens at its About section in the front window                                                                                                                                                                                                                                                      | the main process, the chrome |
| `no-bar` (off macOS)     | `Menu.getApplicationMenu()` is null                                                                                                                                                                                                                                                                                                                                                                                                  | the main process             |

What no runner confirms: the menu as drawn by AppKit (the Search field the `help` role adds, the
window list the `window` role appends) – UI scripting would open it, and the readings above are
what AppKit draws from.

## The OS's Settings rows (`os-settings`)

`os-settings-scenario.mjs` (W8-F5 / F6; settings-116 / #572, #594) runs on all five installer
legs and on the Linux boot set: two rows of the Settings page whose reading is the OS's, read on
the OS that gives it. The accent (`src/main/platform/accent.ts`) is Electron's
`systemPreferences.getAccentColor()` on Windows (the DWM accent) and macOS (the Appearance pane's);
Linux has no reading and the guard is the platform's, so the "Use system accent colour" row is
held there. The proxy door (`src/main/platform/systemSettings.ts`, after Chromium's
`settings_utils_{win,mac,linux}`) hands Windows' `ms-settings:network-proxy` or macOS's
`x-apple.systempreferences:` URL to `shell.openExternal`, and on Linux spawns the desktop's tool
from Chrome's table or answers `unsupported` where the table has none – the runner's shell, with
no desktop named. The URL strings are unit-tested; that the OS takes them is what the step reads,
so the call is let through and the OS app really opens (the default-browser scenario opens
`ms-settings:defaultapps` the same way on the installed Windows leg), recorded by a pass-through
wrapper in the main process and closed again before the leg goes on. The section the accent row is
on is `look` (`zen://settings/look`, "Look and Feel", the Appearance group): the wave plan's
`zen://settings/appearance` names no section, and an unknown one resolves to the landing.

| step                | reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | confirmed by                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `accent-row`        | `getAccentColor()` raw in the main process, the core's `UIState.systemAccent` and `settings.useSystemAccent` through `app.getState`, then `page.open { settings, look }` and the `use-system-accent` row: on Windows and macOS present in the `appearance` group as a boolean control (the desktop layout's checkbox) reading the setting – off on a fresh profile – enabled, under its label, the core's accent the OS's first six digits as `#rrggbb` (logged); on Linux absent, the core holding null              | the main process, the chrome; the log's hex    |
| `system-proxy-door` | the Settings tab moved to `system`, the `proxy-settings` row present, enabled, with its resting description; `system.openProxySettings` fired from the chrome page as the row's press fires it and its answer polled: `opened` on Windows and macOS with exactly one `shell.openExternal` of the expected URL (a refused macOS URL allowed its `openPath` fallback to the Network pane); `unsupported` with no shell call on a Linux runner with no desktop named (either answer, recorded, on a desktop with a tool) | the main process's record of the shell's calls |
|                     | the OS's half, recorded: the screen as it is 3 s after `opened`, Windows' `SystemSettings` process (win-session.ps1 `processes`, then `kill`), macOS's System Settings (`pgrep`, told to quit over osascript, `pkill` when the session refuses the Apple event, polled gone); Zenium's window brought back to the front                                                                                                                                                                                               | the screenshot, the process list               |
| `quit`              | the graceful quit as every scenario's (held on macOS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | the process's exit                             |

What no runner confirms: that the Settings app landed on the Proxy page rather than its front
page (Windows' process list and the screenshot show the app; the page is the URL's, which the OS
took), the accent following a change of the OS's colour while the app runs (Windows'
`accent-color-changed`, macOS's system-colours notification – nothing on a runner changes it), and
the Linux door on a desktop with a tool (the runners have none).

## Hold ⌘Q to quit (`quit-hold`, and every macOS quit)

Chrome's "Warn Before Quitting (⌘Q)" (session-08, W5-19; `src/core/quitHold.ts`): on a Mac with
the application menu's checkbox on – the default – the quit chord's key down arms "Hold ⌘Q to
quit" and the app quits once the keys were down for 1500 ms; a key up before that ends the hold
and nothing quits. The scenario runs on the macOS legs alone (the hold is the Mac's; the harness
holds on Linux too when `--extra-args` carries the app's `--test-quit-hold`), and every other
macOS scenario's `quit` step holds the chord to its end (`Session.quitGracefully` →
`holdQuitChord`: the keys down, the hold read off `app.getState`, the screen grabbed mid-hold
as `<scenario>-quit-hold.png`, the exit at the hold's end). The chord's keys go in through
`webContents.sendInputEvent` on the chrome, the path a physical press takes into
`before-input-event`, where the key table runs synchronously.

Two things the harness learnt on macos-x64 (`macos-15-intel`, W8-F9; five `hold-release` reds
in 37 h with the arm64 twin green each time, and one `dark/quit` red nothing could explain
afterwards): the hold's release is timed by the app's own clock, and a quit that does not come
is read while it is not coming.

| step           | reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | confirmed by                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `menu-item`    | a page in a new tab in front; the application menu's `Warn Before Quitting (⌘Q)` row a checkbox, checked; `settings.warnBeforeQuitting === true` on the fresh profile; the `Quit Zenium` row kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the main process, `app.getState` |
| `hold-release` | one evaluate in the main process (`Session.holdKeysFor`) sends the chord's key down, schedules its key up on a timer there 500 ms later and returns `{ downAt, upAt }` off the app's `Date.now()` – the hold's length (`heldForMs = upAt − downAt` ≈ 500, `lateByMs` the timer's slack) contains no round trip; meanwhile `window.quitHold` is polled through the chrome and each poll is judged by its timestamps (`quit.mjs` `judgeHoldRelease`): a poll that saw the hold proves the arming (its chord `⌘Q`, its 1500 ms), a null read whose whole round trip lay inside the hold fails the step (the chord armed nothing), a poll that answered after the release proves nothing and fails nothing (`arming: 'unproven'` with a note – the other scenarios' full holds prove the arming with a still each run); then the state reads no hold, no exit comes by `downAt + 2000`, the main process answers. Fails on: a release at or past 1500 ms, a key up the app could not send, a not-armed read, a hold naming another chord or duration | the app's clock, `app.getState`  |
| `toggle-off`   | the row picked through its own `click` in the main process: `settings.warnBeforeQuitting` false, the menu rebuilt with the row unchecked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the main process, `app.getState` |
| `quit-at-once` | `quitGracefully` reads the setting off and presses instead of holding: the app quits at the press with no hold (`hold` null), exit code 0; `state.json` keeps `warnBeforeQuitting: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the process, the profile         |

The trace of a quit that does not come (every `quitGracefully`, on every leg): a quit not exited
by the hold's 1500 ms and a 1000 ms margin is read BEFORE the keys come up (`holdQuitChord`) and
then every 500 ms through the 15 s budget (`Session.traceQuit` → `sampleQuit`): the chrome's
`window.quitHold` through `app.getState` and a main-process probe (its state through
`probeOutcome` – `responsive`, `blocked`, `gone` – with the window count and whether one is
focused). The hook's `before-quit` events and a still of the screen while the app is still up
(`<scenario>-quit-stuck.png`) join them, and a "did not exit" failure carries all of it, the
readings that agree collapsed (`quit.mjs` `formatQuitTrace`):

    app did not exit within 15000 ms after Meta+q (main process responsive; prompt null;
    before-quit none; hold {"startedAt":…,"durationMs":1500,"chord":"⌘Q"};
    trace +2.5s quitHold=held(⌘Q, started +0.1s, 1500 ms) main=responsive windows=1 focused=true;
    +3.0s…+14.5s ×24 quitHold=null main=responsive windows=1 focused=true; …)

which says whether the hold's timer never fired (the hold still up at +2.5 s), the hold was
cancelled or its quit refused (the hold gone, no `before-quit`), or the quit began and stalled
(`before-quit` at its offset). Nothing is read while a quit comes within the hold and margin, so
the green path runs as before; the step's detail and `quitGracefully`'s return carry `trace`
only when readings were taken. The pure parts – the polls' verdicts, the release's judging, the
trace's line – are `quit.test.mjs`'s.

What no runner confirms: a physical key up (the release is `sendInputEvent`'s key up, which
Chromium delivers to `before-input-event` as it does a keyboard's), and why a hold's timer would
not fire – the trace names the state, not the cause.

## The agents' space around a restore (`agent-space-restore`)

`agent-space-scenario.mjs` (W8-F2) guards #573 (W7-F3): a window left standing on an empty
agents' space comes back on the user's space, `ensureFirstTab` seeds nothing into the agents'
space, the quit question counts the user's tabs only, and an agent session's end moves the window
off the space it emptied. It runs on every leg of the installers' smoke and in the Linux job's
boot set. Two launches, each from a profile seeded as the MCP soak leaves one (`seedDocument`):
one user space with the boot fixture's page(s), the shared Agents space persisted through its
`agent: { kind: 'shared' }` mark with no tabs, the model's and the window's `activeSpaceId` on
that empty agents' space, `cleanExit: true`. The first launch (`agent-space-restore`) seeds the
window's `lastUserSpaceId`; the second (`agent-space-session`) leaves the key out, as a profile
written before it. The profile seeds `warnBeforeQuitting: false`, so a Mac's chord asks the
question like the other hosts' (with it on the Mac's hold is the confirmation and asks nothing),
and `settings.agents.defaultMode: 'background'`, so only the explicit `takeScreen` brings the
agent's tab in front. Every reading is state – the core's through `app.getState`, the question's
through its DOM, the profile's through `state.json` – never a log line.

| launch                | step                      | reads                                                                                                                                                                                                                  | confirmed by                    |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `agent-space-restore` | `restored-on-user-space`  | the window's `activeSpaceId` is the user space, its active tab on the fixture's first page; the agents' space present, marked `shared`, empty; one tab in all; no `zen://newtab` / `zen://blank` anywhere              | `app.getState`                  |
|                       | `quit`                    | one tab: the quit chord quits with no question, exit code 0 within the budget (`quitGracefully`)                                                                                                                       | the process, the chrome         |
|                       | `state-after-quit`        | `cleanExit: true`; one window remembered, on the user space; the agents' space kept with its mark and empty; one tab                                                                                                   | `state.json`                    |
| `agent-space-session` | `restored-on-user-space`  | as above with two tabs, the first page active                                                                                                                                                                          | `app.getState`                  |
|                       | `server-up`               | the local MCP server's endpoint from the profile's `agent.json` (`waitForEndpoint`, as the soak)                                                                                                                       | the profile                     |
|                       | `agent-tab-in-background` | `initialize`, `zen_mode background`, `browser_tabs new` on the fixture's hand-off page: the agents' space holds exactly the agent's tab; the window still on the user space, its two tabs there, the first page active | the server's replies, the state |
|                       | `quit-prompt-count`       | the quit chord: `[data-window-prompt="quit"]` reads "Quit Zenium?" and "2 tabs" (the agents' tab not counted); Cancel; the prompt gone, `window.prompt` null, the state as before                                      | the DOM, `app.getState`         |
|                       | `screen-taken`            | `zen_mode foreground takeScreen: true` + `browser_snapshot` on the agent's tab: the window's `activeSpaceId` is the agents' space and its active tab the agent's                                                       | the server's replies, the state |
|                       | `session-end`             | `zen_session end closeTabs: true`, then the DELETE: the window back on the user space, the agents' space empty, two user tabs with the first page active, no fresh tab seeded                                          | the server's replies, the state |
|                       | `quit`                    | two tabs: "Quit Zenium?" for 2 tabs, Quit, exit code 0                                                                                                                                                                 | the DOM, the process            |
|                       | `state-after-quit`        | as above with two tabs                                                                                                                                                                                                 | `state.json`                    |

The session's end goes over the local MCP server – the soak's `HttpClient` from
`scripts/mcp-soak.mjs`, the same HTTP path a real agent takes – not a test-only command. The
pure parts (the seeded document, the verdicts) are `agent-space-scenario.test.mjs`'s.

## Teardown

Removing a tree a launched build wrote into retries or polls, never a plain `rmSync`: Chromium's
helpers (the network service, the GPU process) flush into `Partitions/<name>` for a moment after
the browser process is gone, and a plain removal met that on #392's run (`ENOTEMPTY` on
`Partitions/zen-default` after every check had passed). Every teardown `rmSync` here and in
`.github/scripts` runs with `{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }`;
the sign-in smoke's profile removal goes through `.github/scripts/remove-tree.mjs`, which repeats
the pass until the tree is gone – Node's `maxRetries` retries only the failing `rmdir` and never
sees an entry created after the walk read the directory.
