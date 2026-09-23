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
`installed-install.json`); after the uninstall none of it may be left and no document type may
still name the ProgID (`registrationLeftovers` in `installed-uninstall.json`). Either list
non-empty fails its step in `desktop-smoke.yml` with the lines. The user's own http/https choice
(`UserChoice`) is Windows's and is neither written nor read.

## Windows notifications (`notifications`)

`notifications-scenario.mjs` runs on both Windows legs (the unpacked build and the installed
one) for os-27, os-28 and os-30, with `win-toast.ps1` reading the OS's side. The profile is past
onboarding and its `zen/permissions.json` already allows notifications for the fixture origin,
so the page reads `Notification.permission === 'granted'` and `new Notification()` goes straight
to the platform. Each step says who confirms it:

| step | reads | confirmed by |
| --- | --- | --- |
| `permission-granted` | the page's `Notification.permission` through the page preload's shim | the app (its store) |
| `app-id-registered` | `HKCU\Software\Classes\AppUserModelId\<id>`: `DisplayName` = the app name, `IconUri` on disk (`src/main/platform/notifications.ts` writes it for a copy without installer shortcuts; polled, the write is asynchronous) | the OS's registry |
| `shortcut-aumid` | the installed shortcuts' `System.AppUserModel.ID` (the installer's `WinShell::SetLnkAUMI`; installed build only, the unpacked build has no shortcut) | the OS's shell |
| `fire` | `show` fired in the page, no `error`; Electron's toast log (`ELECTRON_DEBUG_NOTIFICATIONS=1`) says `Notification created` – ToastNotifier.Show returned S_OK – and reports no `WinAPI: … failed` | the platform accepted the toast |
| `os-toast` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<id>`, the per-sender key Windows creates once an app has shown a toast and Settings › System › Notifications lists senders from (os-30's source) – gates; the banner windows (`Windows.UI.Core.CoreWindow` "New notification"), the platform's store (`wpndatabase.db`) scanned for the id and the title, its event log (`Microsoft-Windows-PushNotification-Platform/Operational` event 3153: "Toast … is delivered to `<id>`") and a UI Automation click on the banner – recorded as the readings `banner`, `store`, `delivered`, `osClick` | the OS |
| `click-reveals-tab` | with another tab active, the notification's `click` dispatched in the page under a user gesture: `onclick` → `window.focus()` → the preload's `zen:page {type:'focus'}` (the hook records it) → the core's `revealTab`: the tab active again, the window's `show()`/`focus()` called | the app's path from `onclick` on |

What no runner confirms: the banner itself (the runner's session showed none – WIN-006 on
Server 2025 – so the click on it is best effort and its reading `osClick` says whether it went
anywhere), Chromium's routing of an OS toast activation to the page's `onclick` (the one link the
dispatched click does not exercise), whether Windows hands the foreground to the window
(`windowFocused` is recorded, not judged), the Settings page's visual entry and Focus Assist.

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

## Teardown

Removing a tree a launched build wrote into retries or polls, never a plain `rmSync`: Chromium's
helpers (the network service, the GPU process) flush into `Partitions/<name>` for a moment after
the browser process is gone, and a plain removal met that on #392's run (`ENOTEMPTY` on
`Partitions/zen-default` after every check had passed). Every teardown `rmSync` here and in
`.github/scripts` runs with `{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }`;
the sign-in smoke's profile removal goes through `.github/scripts/remove-tree.mjs`, which repeats
the pass until the tree is gone – Node's `maxRetries` retries only the failing `rmdir` and never
sees an entry created after the walk read the directory.
