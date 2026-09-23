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
