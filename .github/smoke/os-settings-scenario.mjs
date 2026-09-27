// os-settings (W8-F5, W8-F6; settings-116 / #572, #594): two rows of the Settings page whose
// reading is the OS's, read on the OS that gives it – what no vitest on Linux can.
//
// F5, `accent-row`: Settings › Look and Feel's Appearance group holds a "Use system accent
// colour" row only where the host reports an accent (`src/main/platform/accent.ts`: Electron's
// `systemPreferences.getAccentColor()` on Windows – the DWM accent – and macOS – the Appearance
// pane's; Linux has no reading, the guard is the platform's). The step reads the raw colour the
// OS hands Electron, the `#rrggbb` the core holds from it (`UIState.systemAccent`, through
// `app.getState`), opens the section and reads the row: present, a boolean control reading the
// setting (off on a fresh profile), the core's accent the OS's first six digits, on Windows and
// macOS; absent, with the core holding null, on Linux. The hex is in the log and in the step's
// detail. Note the section's id: the spec's `zen://settings/appearance` is no section – an
// unknown section resolves to the landing (`shared/internalPages.ts`) – the Appearance rows are
// the `look` section's (`zen://settings/look`).
//
// F6, `system-proxy-door`: Settings › System's "Open your computer's proxy settings" row goes
// through `system.openProxySettings` to `src/main/platform/systemSettings.ts` – Windows'
// `ms-settings:network-proxy`, macOS's `x-apple.systempreferences:` URL of the Network
// settings extension with its Proxies anchor (the Network preference pane itself when the OS
// refuses the URL), the Linux desktop's tool by Chrome's table or `unsupported` where the table
// has none (XFCE, LXQt, no desktop named – a runner's). The URL strings are unit-tested; that
// the OS TAKES them (ShellExecute, LaunchServices) is what this step reads: the command is
// fired from the chrome page as the row's press fires it and its answer read – `opened` on
// Windows and macOS with exactly the expected URL handed to `shell.openExternal` (recorded in
// the main process by a pass-through wrapper: the call goes through, the OS app really opens),
// `unsupported` with no shell call on a Linux runner with no desktop named. The OS's half is
// recorded, not judged: the screen as it is 3 s later, the Settings process (Windows'
// `SystemSettings`, macOS's System Settings) – and closed again, so the legs' later steps and
// the quit meet no window of another app (Windows through win-session.ps1's kill, macOS
// through a quit told over osascript, `pkill` when that is refused), Zenium's window brought
// back to the front. Opening the real app rather than stubbing the call is what the
// default-browser scenario already does on the installed Windows leg (`ms-settings:defaultapps`,
// the same process killed after): the OS accepting the URL is the one thing the unit tests
// cannot say, and a stub would read Zenium's own string back to itself.

/** The scenario's name on the command line and in result.json. */
export const OS_SETTINGS_SCENARIO = 'os-settings'

/** The Settings section the Appearance group is on (`zen://settings/look`, "Look and Feel"). */
export const APPEARANCE_SECTION = 'look'
/** The group the accent row is in (`sections.tsx`, `appearanceSection`). */
export const APPEARANCE_GROUP = 'appearance'
/** The accent row's id and label (`sections.tsx`). */
export const ACCENT_ROW = 'use-system-accent'
export const ACCENT_ROW_LABEL = 'Use system accent colour'

/** The Settings section the proxy row is on (`zen://settings/system`). */
export const SYSTEM_SECTION = 'system'
/** The proxy row's id, label and resting description (`PROXY_SETTINGS_COPY` in `sections.tsx`). */
export const PROXY_ROW = 'proxy-settings'
export const PROXY_ROW_LABEL = "Open your computer's proxy settings"
export const PROXY_ROW_DESCRIPTION = "Zenium uses your computer's proxy settings."

/** Windows Settings › Network & internet › Proxy (`systemSettings.ts` `WINDOWS_PROXY_PAGE`). */
export const WINDOWS_PROXY_PAGE = 'ms-settings:network-proxy'
/** System Settings › Network › Proxies on macOS 13+ (`MAC_PROXY_PANE`). */
export const MAC_PROXY_PANE =
  'x-apple.systempreferences:com.apple.Network-Settings.extension?Proxies'
/** System Preferences › Network › Proxies on macOS 11 and 12 (`MAC_LEGACY_PROXY_PANE`). */
export const MAC_LEGACY_PROXY_PANE =
  'x-apple.systempreferences:com.apple.preference.network?Proxies'
/** The Network pane the macOS door falls back to when the URL is refused (`MAC_NETWORK_PREF_PANE`). */
export const MAC_NETWORK_PREF_PANE = '/System/Library/PreferencePanes/Network.prefPane'
/** Darwin 22 is macOS 13 Ventura, the first with the System Settings app and its extensions. */
export const MAC_VENTURA_DARWIN_MAJOR = 22

/** The Windows Settings app's process name (the default-browser scenario reads and kills the same). */
export const WINDOWS_SETTINGS_PROCESS = 'SystemSettings'
/** The macOS settings app's names (for osascript's `tell`): 13+'s, then 11 and 12's. */
export const MAC_SETTINGS_APPS = ['System Settings', 'System Preferences']

/**
 * The pattern `pgrep -f` / `pkill -f` finds a macOS settings app by: its executable's path
 * inside the bundle, since the process name `pgrep -x` reads is cut at 16 characters ("System
 * Preferenc"); unanchored at the end, in case the launch handed the app an argument.
 */
export function macAppPattern(name) {
  return `MacOS/${name}`
}

/** The environment the Linux door reads its desktop from (`linuxDesktop`), as `process.env` keys. */
export const LINUX_DESKTOP_ENV_KEYS = [
  'XDG_CURRENT_DESKTOP',
  'DESKTOP_SESSION',
  'KDE_SESSION_VERSION',
  'GNOME_DESKTOP_SESSION_ID',
  'KDE_FULL_SESSION'
]

/**
 * The desktops Chrome's table names a network-settings tool for (`LINUX_PROXY_COMMANDS` in
 * `systemSettings.ts`, after settings_utils_linux.cc): the door on one of these may open (the
 * tool on the PATH) or not (the tool missing); XFCE, LXQt and `other` have no tool and answer
 * `unsupported` without trying.
 */
export const LINUX_DESKTOPS_WITH_A_TOOL = [
  'cinnamon',
  'cosmic',
  'deepin',
  'gnome',
  'pantheon',
  'ukui',
  'unity',
  'kde3',
  'kde4',
  'kde5',
  'kde6'
]

/**
 * Electron's `RRGGBBAA` (or `RRGGBB`, with or without `#`) as the `#rrggbb` the core holds
 * (`accentHex` in `src/main/platform/accent.ts`); null for anything that is not a colour.
 */
export function accentHex(raw) {
  if (typeof raw !== 'string') return null
  const hex = raw.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null
  return `#${hex.slice(0, 6).toLowerCase()}`
}

/** Whether the host reads an accent at all: Windows and macOS (`systemAccentReadable`'s platforms). */
export function hostReadsAccent(platform) {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Chromium's `base::nix::GetDesktopEnvironment` as `systemSettings.ts` ports it: the values of
 * `XDG_CURRENT_DESKTOP` in priority order first (a Unity value with a gnome-fallback
 * `DESKTOP_SESSION` is GNOME; KDE's version from `KDE_SESSION_VERSION`, 4 when it says neither 5
 * nor 6), then the 2010-era `DESKTOP_SESSION`, then the GNOME and KDE session markers; `other`
 * when none says – a runner's shell, with none of them set.
 */
export function linuxDesktop(env) {
  const kde = () =>
    env.KDE_SESSION_VERSION === '5' ? 'kde5' : env.KDE_SESSION_VERSION === '6' ? 'kde6' : 'kde4'
  const current = env.XDG_CURRENT_DESKTOP
  if (current !== undefined) {
    for (const value of current.split(':').map((v) => v.trim())) {
      switch (value) {
        case 'Unity':
          return (env.DESKTOP_SESSION ?? '').includes('gnome-fallback') ? 'gnome' : 'unity'
        case 'Deepin':
          return 'deepin'
        case 'GNOME':
          return 'gnome'
        case 'X-Cinnamon':
          return 'cinnamon'
        case 'KDE':
          return kde()
        case 'Pantheon':
          return 'pantheon'
        case 'XFCE':
          return 'xfce'
        case 'UKUI':
          return 'ukui'
        case 'LXQt':
          return 'lxqt'
        case 'COSMIC':
          return 'cosmic'
      }
    }
  }
  const session = env.DESKTOP_SESSION ?? ''
  if (session === 'deepin') return 'deepin'
  if (session === 'gnome' || session === 'mate') return 'gnome'
  if (session === 'kde4' || session === 'kde-plasma') return 'kde4'
  if (session === 'kde') return env.KDE_SESSION_VERSION !== undefined ? 'kde4' : 'kde3'
  if (session.includes('xfce') || session === 'xubuntu') return 'xfce'
  if (session === 'ukui') return 'ukui'
  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return 'gnome'
  if (env.KDE_FULL_SESSION !== undefined) {
    return env.KDE_SESSION_VERSION !== undefined ? 'kde4' : 'kde3'
  }
  return 'other'
}

/**
 * What the door has to answer on this host, and through which call: `opened` with
 * `WINDOWS_PROXY_PAGE` through `shell.openExternal` on Windows; `opened` with the macOS URL the
 * Darwin major picks (`osRelease`, `os.release()`: 22+ the System Settings extension's, else
 * System Preferences') – or, when the OS refuses that URL, `MAC_NETWORK_PREF_PANE` through
 * `shell.openPath`; on Linux `unsupported` with no shell call for a desktop the table has no
 * tool for (`env` is the app's own environment), `either` for one it has – the tool may or may
 * not be on the PATH, and the reading is recorded.
 */
export function expectedProxyDoor({ platform, osRelease = '', env = {} }) {
  if (platform === 'win32') {
    return { door: 'opened', url: WINDOWS_PROXY_PAGE, fallback: null, desktop: null }
  }
  if (platform === 'darwin') {
    const major = Number(String(osRelease).split('.')[0] ?? 0)
    return {
      door: 'opened',
      url: major >= MAC_VENTURA_DARWIN_MAJOR ? MAC_PROXY_PANE : MAC_LEGACY_PROXY_PANE,
      fallback: MAC_NETWORK_PREF_PANE,
      desktop: null
    }
  }
  if (platform === 'linux') {
    const desktop = linuxDesktop(env)
    return {
      door: LINUX_DESKTOPS_WITH_A_TOOL.includes(desktop) ? 'either' : 'unsupported',
      url: null,
      fallback: null,
      desktop
    }
  }
  return { door: 'unsupported', url: null, fallback: null, desktop: null }
}

/**
 * What is wrong with the accent reading. `raw` is what `systemPreferences.getAccentColor()`
 * returned in the main process (or null when it threw or is absent), `coreAccent` the core's
 * `UIState.systemAccent`, `useSystemAccent` the setting, `row` the page's reading of the
 * `use-system-accent` row (`readSettingsRowScript`). Windows and macOS: the OS gives a colour,
 * the core holds its `#rrggbb`, the row is on the Appearance group as a boolean control (the
 * desktop layout's checkbox, or a `switch` role) reading the setting, enabled, under its label.
 * Linux: no row, and the core holds null whatever the method returned (the guard is the
 * platform's; Electron 44's method is there and returns "").
 */
export function accentRowProblems({ platform, raw, coreAccent, useSystemAccent, row }) {
  const problems = []
  if (hostReadsAccent(platform)) {
    const want = accentHex(raw)
    if (want === null) {
      problems.push(`the OS gave no colour: getAccentColor() read ${JSON.stringify(raw)}`)
    }
    if (coreAccent !== want) {
      problems.push(
        `the core holds systemAccent ${JSON.stringify(coreAccent)}, the OS reads ${want}`
      )
    }
    if (!row?.present) {
      problems.push(`no ${ACCENT_ROW} row on the ${row?.section ?? 'unknown'} section`)
      return problems
    }
    if (row.control !== 'checkbox' && row.control !== 'switch') {
      problems.push(`the row has no boolean control (${row.control ?? 'none'})`)
    } else if (row.checked !== Boolean(useSystemAccent)) {
      problems.push(`the row reads ${row.checked}, the setting is ${Boolean(useSystemAccent)}`)
    }
    if (row.disabled) problems.push('the row is disabled')
    if (row.label !== ACCENT_ROW_LABEL) problems.push(`the row reads "${row.label}"`)
    if (row.group !== APPEARANCE_GROUP) {
      problems.push(`the row is in the ${row.group ?? 'no'} group, not ${APPEARANCE_GROUP}`)
    }
    return problems
  }
  if (coreAccent !== null) {
    problems.push(`the core holds systemAccent ${JSON.stringify(coreAccent)} on ${platform}`)
  }
  if (row?.present) problems.push(`a ${ACCENT_ROW} row on ${platform}, which reads no accent`)
  return problems
}

/**
 * What is wrong with the proxy row as the System section shows it before the press: there,
 * under its label, with the resting description (no extension holds the proxy on a fresh
 * profile), enabled.
 */
export function proxyRowProblems(row) {
  if (!row?.present) return [`no ${PROXY_ROW} row on the ${row?.section ?? 'unknown'} section`]
  const problems = []
  if (row.label !== PROXY_ROW_LABEL) problems.push(`the row reads "${row.label}"`)
  if (row.description !== PROXY_ROW_DESCRIPTION) {
    problems.push(`the row's description reads "${row.description}"`)
  }
  if (row.disabled) problems.push('the row is disabled')
  return problems
}

/**
 * What is wrong with the door's answer. `result` is what `system.openProxySettings` resolved
 * (`{ settled, result, error }`, the chrome page's record), `calls` the shell calls the main
 * process recorded since the wrapper went in (`{ method, target, settled, error }`), `expected`
 * from `expectedProxyDoor`. `opened` legs: the answer `opened`, exactly one `openExternal` with
 * the expected URL; on macOS a refused URL is allowed its `openPath` fallback to the Network
 * pane. `unsupported` legs: the answer `unsupported` and no shell call at all (the Linux door
 * spawns a tool or nothing; `shell` is not on its path). `either`: one of the two answers,
 * recorded.
 */
export function proxyDoorProblems({ result, calls, expected }) {
  const problems = []
  if (!result?.settled) {
    problems.push('system.openProxySettings did not settle')
    return problems
  }
  if (result.error) {
    problems.push(`system.openProxySettings rejected: ${result.error}`)
    return problems
  }
  const answer = result.result
  if (expected.door === 'either') {
    if (answer !== 'opened' && answer !== 'unsupported') {
      problems.push(`the door answered ${JSON.stringify(answer)}`)
    }
    return problems
  }
  if (answer !== expected.door) {
    problems.push(`the door answered ${JSON.stringify(answer)}, expected ${expected.door}`)
  }
  const list = calls ?? []
  if (expected.door === 'unsupported') {
    if (list.length) {
      problems.push(
        `${list.length} shell call(s) on an unsupported host: ${list.map((c) => `${c.method}(${c.target})`).join(', ')}`
      )
    }
    return problems
  }
  const externals = list.filter((c) => c.method === 'openExternal')
  const paths = list.filter((c) => c.method === 'openPath')
  if (externals.length !== 1) {
    problems.push(
      `${externals.length} shell.openExternal call(s), expected one: ${externals.map((c) => c.target).join(', ') || 'none'}`
    )
  } else {
    const [call] = externals
    if (call.target !== expected.url) {
      problems.push(`shell.openExternal was handed ${call.target}, expected ${expected.url}`)
    }
    if (!call.settled) problems.push(`shell.openExternal(${call.target}) has not settled`)
    if (call.error) {
      if (!expected.fallback) {
        problems.push(`the OS refused ${call.target}: ${call.error}`)
      } else if (paths.length !== 1 || paths[0].target !== expected.fallback) {
        problems.push(
          `the OS refused ${call.target} (${call.error}) and the door did not fall back to ${expected.fallback} (openPath: ${paths.map((c) => c.target).join(', ') || 'none'})`
        )
      } else if (paths[0].error) {
        problems.push(`the OS refused ${expected.fallback} too: ${paths[0].error}`)
      }
    } else if (paths.length) {
      problems.push(
        `shell.openPath called though the URL was taken: ${paths.map((c) => c.target).join(', ')}`
      )
    }
  }
  return problems
}

/**
 * Runs in the app's main process (`s.app.evaluate`): the raw accent Electron reads, or the
 * throw. Self-contained – nothing of this module's scope is in reach.
 */
export function readAccentScript({ systemPreferences }) {
  const out = { platform: process.platform, hasMethod: false, raw: null, error: null }
  if (!systemPreferences || typeof systemPreferences.getAccentColor !== 'function') return out
  out.hasMethod = true
  try {
    out.raw = systemPreferences.getAccentColor()
  } catch (e) {
    out.error = String((e && e.message) || e)
  }
  return out
}

/**
 * Runs in the app's main process: the platform and the environment keys the Linux door reads
 * its desktop from – the app's own, which is what `expectedProxyDoor` judges by (the OS release
 * is the harness's `os.release()`: the same machine, and no `require` in reach here).
 */
export function readHostScript(_electron, keys) {
  const env = {}
  for (const key of keys) if (process.env[key] !== undefined) env[key] = process.env[key]
  return { platform: process.platform, env }
}

/**
 * Installed in the main process: records every `shell.openExternal` and `shell.openPath` call
 * the app makes from now on (the method, its target, when, and how the OS took it – resolved,
 * or rejected with its message; `openPath` resolves with the refusal as a string, kept as the
 * error) and lets each through, so the OS app really opens. Idempotent; keeps the originals
 * under `orig`. Self-contained, as every main-process script is.
 */
export function recordShellOpensScript({ shell }) {
  const g = globalThis
  if (g.__smokeShellOpens) {
    return { installed: g.__smokeShellOpens.installed, calls: g.__smokeShellOpens.calls.length }
  }
  const calls = []
  const orig = {}
  const installed = {}
  const wrap = (method) => {
    if (typeof shell[method] !== 'function') {
      installed[method] = false
      return
    }
    orig[method] = shell[method].bind(shell)
    const wrapped = (target, options) => {
      const entry = { method, target: String(target), at: Date.now(), settled: false, error: null }
      calls.push(entry)
      let p
      try {
        p = Promise.resolve(orig[method](target, options))
      } catch (e) {
        entry.settled = true
        entry.error = String((e && e.message) || e)
        throw e
      }
      return p.then(
        (r) => {
          entry.settled = true
          // openPath answers with the error message, '' for success.
          if (method === 'openPath' && typeof r === 'string' && r !== '') entry.error = r
          return r
        },
        (e) => {
          entry.settled = true
          entry.error = String((e && e.message) || e)
          throw e
        }
      )
    }
    try {
      shell[method] = wrapped
    } catch {
      // A read-only property: defined over below.
    }
    if (shell[method] !== wrapped) {
      try {
        Object.defineProperty(shell, method, { value: wrapped, configurable: true, writable: true })
      } catch {
        // Not configurable either: `installed` says so.
      }
    }
    installed[method] = shell[method] === wrapped
  }
  wrap('openExternal')
  wrap('openPath')
  g.__smokeShellOpens = { calls, orig, installed }
  return { installed, calls: 0 }
}

/** Runs in the app's main process: the shell calls recorded so far. */
export function readShellOpensScript() {
  return globalThis.__smokeShellOpens ? globalThis.__smokeShellOpens.calls : []
}

/**
 * Runs in the chrome page (`s.chrome.evaluate`): the Settings page's section and one row of it
 * by `data-row` id – its control (the desktop layout's checkbox, a `switch` role, or none),
 * whether it is checked and disabled, its label, description and group; or, when the row is not
 * there, the ids of the rows that are.
 */
export function readSettingsRowScript(id) {
  const page = document.querySelector('[data-testid="settings-page"]')
  const section = page ? page.getAttribute('data-section') : null
  const el = page ? page.querySelector(`[data-row="${id}"]`) : null
  if (!el) {
    return {
      present: false,
      section,
      rows: page
        ? [...page.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'))
        : []
    }
  }
  const checkbox = el.matches('input[type="checkbox"]')
    ? el
    : el.querySelector('input[type="checkbox"]')
  const role = el.getAttribute('role')
  const control = checkbox ? 'checkbox' : role === 'switch' ? 'switch' : null
  const checked = checkbox
    ? checkbox.checked
    : role === 'switch'
      ? el.getAttribute('aria-checked') === 'true'
      : null
  const disabled =
    el.getAttribute('aria-disabled') === 'true' ||
    el.disabled === true ||
    (checkbox ? checkbox.disabled : false)
  const text = (sel) => {
    const node = el.querySelector(sel)
    return node ? node.textContent.trim() : null
  }
  const group = el.closest('[data-group]')
  return {
    present: true,
    section,
    tag: el.tagName.toLowerCase(),
    control,
    checked,
    disabled,
    label: text('.zen-settings-label'),
    description: text('.zen-settings-description'),
    group: group ? group.getAttribute('data-group') : null
  }
}

/**
 * Runs in the chrome page: fires `system.openProxySettings` as the row's press does
 * (`window.zen.invoke`) and keeps its outcome on the window, without waiting for the OS – the
 * harness polls `readProxyDoorScript`, so no evaluate hangs on ShellExecute.
 */
export function fireProxyDoorScript() {
  const rec = { at: Date.now(), settled: false, result: undefined, error: null }
  window.__smokeProxyDoor = rec
  window.zen
    .invoke('system.openProxySettings')
    .then((r) => {
      rec.settled = true
      rec.result = r
    })
    .catch((e) => {
      rec.settled = true
      rec.error = String((e && e.message) || e)
    })
  return true
}

/** Runs in the chrome page: the fired command's record, with how long it has been open. */
export function readProxyDoorScript() {
  const rec = window.__smokeProxyDoor
  if (!rec) return null
  return { ...rec, ms: Date.now() - rec.at }
}

/** An error carrying what the step had read (`Session.step` keeps `detail`). */
function withDetail(message, detail) {
  const error = new Error(message)
  error.detail = detail
  return error
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `waitFor`,
 * `delay`, `log`, `grabScreen`, `sh`, `osascript`, `ps` and the platform flags.
 */
export async function scenarioOsSettings(h) {
  const { freshProfile, runScenario, waitFor, delay, log, grabScreen, sh, osascript, ps } = h
  const osRelease = h.osRelease ?? ''
  const isWin = h.isWin ?? process.platform === 'win32'
  const isMac = h.isMac ?? process.platform === 'darwin'
  const userData = freshProfile(`profile-${OS_SETTINGS_SCENARIO}`, { onboardingDone: true })

  return runScenario(OS_SETTINGS_SCENARIO, userData, {}, async (s, out) => {
    out.platform = process.platform
    const invoke = (name, args) =>
      s.chrome.evaluate(({ name, args }) => window.zen.invoke(name, args), { name, args })
    const readRow = (id) => s.chrome.evaluate(readSettingsRowScript, id)

    /**
     * The Settings page at `section`, opened or moved there (`page.open`: Settings is a
     * singleton page, so a second open moves the tab the first left), read once it is up.
     */
    const openSettings = async (section) => {
      const tabId = await invoke('page.open', { id: 'settings', section })
      const page = s.chrome.locator(`[data-testid="settings-page"][data-section="${section}"]`)
      await page.first().waitFor({ state: 'visible', timeout: 10000 })
      await s.settle()
      return tabId
    }

    await s.step('accent-row', async () => {
      // The raw reading first (Electron's, before anything of the page is touched), then the
      // core's holding of it and the setting, then the row on the page.
      const os = await s.app.evaluate(readAccentScript)
      const state = await s.appState()
      const coreAccent = state?.systemAccent ?? null
      const useSystemAccent = state?.settings?.useSystemAccent ?? false
      const tabId = await openSettings(APPEARANCE_SECTION)
      const row = await readRow(ACCENT_ROW)
      const screen = await s.shot('accent-row')
      const reading = {
        platform: os.platform,
        hasMethod: os.hasMethod,
        raw: os.raw,
        error: os.error,
        accent: coreAccent,
        useSystemAccent,
        row,
        tabId,
        screen
      }
      const problems = accentRowProblems({
        platform: os.platform,
        raw: os.raw,
        coreAccent,
        useSystemAccent,
        row
      })
      const word = hostReadsAccent(os.platform)
        ? `accent ${coreAccent ?? 'none'} (getAccentColor ${JSON.stringify(os.raw)}); the row ${row.present ? `present, ${row.control} ${row.checked ? 'on' : 'off'}` : 'ABSENT'}`
        : `no accent (systemAccent ${JSON.stringify(coreAccent)}, getAccentColor ${os.error ? `threw: ${os.error}` : JSON.stringify(os.raw)}); the row ${row.present ? 'PRESENT' : 'absent'}`
      log(`${OS_SETTINGS_SCENARIO}: ${os.platform}: ${word}`)
      out.accent = { platform: os.platform, raw: os.raw, accent: coreAccent, row: row.present }
      if (problems.length) throw withDetail(problems.join('; '), reading)
      return reading
    })

    await s.step(
      'system-proxy-door',
      async () => {
        const host = {
          ...(await s.app.evaluate(readHostScript, LINUX_DESKTOP_ENV_KEYS)),
          osRelease
        }
        const expected = expectedProxyDoor(host)
        const wrapper = await s.app.evaluate(recordShellOpensScript)
        await openSettings(SYSTEM_SECTION)
        const row = await readRow(PROXY_ROW)
        const rowProblems = proxyRowProblems(row)
        if (rowProblems.length) throw withDetail(rowProblems.join('; '), { host, expected, row })

        // The command as the row's press fires it; its answer polled (ShellExecute answers once
        // the Settings app is launching, which the arm64 runner takes its time over).
        await s.chrome.evaluate(fireProxyDoorScript)
        const result = await waitFor(
          async () => {
            const rec = await s.chrome.evaluate(readProxyDoorScript)
            return rec?.settled ? rec : null
          },
          30000,
          'system.openProxySettings answered',
          250
        ).catch(async () => (await s.chrome.evaluate(readProxyDoorScript)) ?? { settled: false })
        // The shell calls, once each has settled (the OS's answer to the URL) or 10 s went by.
        let calls = await s.app.evaluate(readShellOpensScript)
        if (calls.some((c) => !c.settled)) {
          calls = await waitFor(
            async () => {
              const now = await s.app.evaluate(readShellOpensScript)
              return now.every((c) => c.settled) ? now : null
            },
            10000,
            'the shell calls settled',
            250
          ).catch(() => s.app.evaluate(readShellOpensScript))
        }
        const detail = { host, expected, wrapper, row, result, calls }
        const problems = proxyDoorProblems({ result, calls, expected })

        // The OS's half, recorded: what came up, and closed again so nothing of another app is
        // left over the legs' later steps or the quit.
        if (result.result === 'opened') {
          await delay(3000)
          detail.screen = grabScreen(`${OS_SETTINGS_SCENARIO}-proxy-door`).file
          if (isWin) {
            const seen = ps(
              'win-session.ps1',
              ['-Action', 'processes', '-ProcessName', WINDOWS_SETTINGS_PROCESS],
              60000
            )
            try {
              detail.processes = JSON.parse(seen.stdout)
            } catch {
              detail.processes = {
                error: (seen.stderr || seen.stdout || seen.error || '').slice(0, 300)
              }
            }
            const closed = ps(
              'win-session.ps1',
              ['-Action', 'kill', '-ProcessName', WINDOWS_SETTINGS_PROCESS],
              60000
            )
            detail.closed =
              closed.stdout || closed.stderr || closed.error || `exit ${closed.status}`
          } else if (isMac) {
            // The app told to quit over osascript (an Apple event the runner's session may
            // refuse: then pkill, which needs no permission); polled gone either way.
            const running = () =>
              MAC_SETTINGS_APPS.filter(
                (name) => sh('pgrep', ['-f', macAppPattern(name)], 10000).status === 0
              )
            const before = running()
            detail.processes = { apps: before }
            const closing = []
            for (const name of before) {
              const told = osascript(`tell application "${name}" to quit`, 15000)
              closing.push(
                `${name}: osascript ${told.status === 0 ? 'quit' : `refused (${told.stderr || told.error || `exit ${told.status}`})`}`
              )
            }
            const gone = await waitFor(
              () => (running().length ? null : true),
              10000,
              'the settings app gone',
              500
            ).catch(() => false)
            if (!gone) {
              for (const name of running()) {
                const killed = sh('pkill', ['-f', macAppPattern(name)], 10000)
                closing.push(`${name}: pkill exit ${killed.status}`)
              }
            }
            detail.closed = closing.join('; ') || 'nothing to close'
          } else {
            detail.closed =
              'nothing to close: the Linux door spawns the desktop’s tool detached, or nothing'
          }
          await s.bringToFront().catch(() => undefined)
          await s.settle()
        }

        const took = result.settled ? `${result.ms} ms` : 'not settled'
        const opened = calls.map(
          (c) =>
            `${c.method}(${c.target}) → ${c.error ? `refused: ${c.error}` : c.settled ? 'taken' : 'open'}`
        )
        const osSide = isWin
          ? `${WINDOWS_SETTINGS_PROCESS} ${detail.processes?.count ? `on screen (${detail.processes.count} process(es)${detail.processes.processes?.find((p) => p.mainWindowTitle)?.mainWindowTitle ? `, "${detail.processes.processes.find((p) => p.mainWindowTitle).mainWindowTitle}"` : ''})` : 'not seen as a process'}`
          : isMac
            ? `${detail.processes?.apps?.length ? `${detail.processes.apps.join(', ')} running` : 'no settings app seen running'}`
            : `desktop ${expected.desktop}`
        log(
          `${OS_SETTINGS_SCENARIO}: ${host.platform}: proxy door → ${JSON.stringify(result.result ?? result.error)} in ${took}; ${opened.join(', ') || 'no shell call'}; ${osSide}${detail.closed ? `; ${detail.closed}` : ''}`
        )
        out.proxyDoor = {
          platform: host.platform,
          answer: result.result ?? null,
          error: result.error ?? null,
          urls: calls.map((c) => c.target),
          desktop: expected.desktop
        }
        if (problems.length) throw withDetail(problems.join('; '), detail)
        return detail
      },
      { timeoutMs: 120000 }
    )

    // The session ends the way every scenario's does: the quit chord (held on macOS), the
    // question the open tabs earn answered, the process's exit 0 read.
    await s.step('quit', async () => s.quitGracefully())
  })
}
