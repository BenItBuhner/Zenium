// The `private-taskbar` scenario: private windows on a taskbar group of their own, with the
// private icon (os-56). Windows groups taskbar buttons by AppUserModelID, so a private window's
// frame carries a second id – the app's with `.private` – with the private ICO and a relaunch
// command that opens a private window (src/main/platform/privateTaskbar.ts, written through
// `BrowserWindow.setAppDetails` in window.ts); the main process registers that id's class key
// beside the app's (notifications.ts) so Windows names and draws the group where no shortcut
// carries the id. The runner's taskbar cannot be asked which buttons it shows, so the facts are
// read where Windows reads them: each window's shell property store (win-taskbar.ps1,
// SHGetPropertyStoreForWindow) and the class key (win-toast.ps1 -Action app-id). Its own file so
// the harness's scenario table gains one line for it (the `notifications` shape).
//
// What each step reads, and who confirms it:
//   open-private-window   `window.newPrivate` from the main window's chrome: a second
//                         BrowserWindow, private, with its frame handle – the app
//   private-window-grouped  that frame's property store: System.AppUserModel.ID is the private id,
//                         RelaunchCommand is this executable on this profile with
//                         `--private-window`, RelaunchDisplayNameResource is "Zenium (Private)";
//                         the main window's frame carries no id of its own (it sits on the
//                         process's) – the OS's shell
//   private-icon          RelaunchIconResource names the private ICO this copy ships, index 0,
//                         and the file is on disk – the OS's shell, the file system
//   class-key             HKCU\Software\Classes\AppUserModelId\<id>.private holds the group's name
//                         and the private PNG under this executable's directory – the OS's
//                         registry (polled: the write is asynchronous after browser.start)
//   taskbar-still         a screenshot with both windows up (recorded, not judged: the runner's
//                         session may show no taskbar)
//   close-private-window  the private window closed from the main process; one window remains
//   quit                  the quit chord
import fs from 'node:fs'
import path from 'node:path'
import { appIdProblems, isUnderDirectory } from './notifications-scenario.mjs'

export const PRIVATE_TASKBAR_SCENARIO = 'private-taskbar'

/** Must equal `APP_USER_MODEL_ID` in src/main/platform/notifications.ts (the test holds them in step). */
export const APP_USER_MODEL_ID = 'io.github.benitbuhner.zenium'
/** `PRIVATE_APP_USER_MODEL_ID` in src/main/platform/privateTaskbar.ts. */
export const PRIVATE_APP_USER_MODEL_ID = `${APP_USER_MODEL_ID}.private`
/** `privateRelaunchDisplayName('Zenium')` there. */
export const PRIVATE_DISPLAY_NAME = 'Zenium (Private)'
/** The private icon's folder under `resources/icons` (`APP_ICON_PRIVATE.folder`). */
export const PRIVATE_ICON_FOLDER = 'private'

/** A Windows command-line argument as webAppLauncher.ts quotes one. */
export function quoteWindowsArg(arg) {
  if (!/[\s"]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

/**
 * The relaunch command a packaged build gives its private windows on a `--user-data-dir`
 * profile: the executable, the profile, `--private-window` – `privateRelaunchCommand` in
 * privateTaskbar.ts for a packaged copy (the test holds the two in step).
 */
export function expectedPrivateRelaunchCommand(execPath, userDataDir) {
  const parts = [execPath]
  if (userDataDir !== null && userDataDir !== undefined)
    parts.push(`--user-data-dir=${userDataDir}`)
  parts.push('--private-window')
  return parts.map(quoteWindowsArg).join(' ')
}

const shown = (v) => (v === null || v === undefined ? '<none>' : `'${v}'`)

/**
 * What is wrong with a private window's property store (one entry of `win-taskbar.ps1 -Action
 * windows`): the private id, the relaunch command, the display name, and the icon resource –
 * `<ico>,0` for a file on disk named `…\private\icon.ico` (`exists` tells whether it is, resolved
 * by the caller). One line per miss, empty when the frame carries the group's facts.
 */
export function privateWindowProblems(entry, { command, exists = null } = {}) {
  if (!entry) return ['the private window is not among the process’s top-level windows']
  const problems = []
  if (entry.error) problems.push(`the property store could not be read: ${entry.error}`)
  if (entry.appUserModelId !== PRIVATE_APP_USER_MODEL_ID) {
    problems.push(
      `System.AppUserModel.ID is ${shown(entry.appUserModelId)}, expected '${PRIVATE_APP_USER_MODEL_ID}'`
    )
  }
  if (command && entry.relaunchCommand !== command) {
    problems.push(`RelaunchCommand is ${shown(entry.relaunchCommand)}, expected '${command}'`)
  }
  if (entry.relaunchDisplayName !== PRIVATE_DISPLAY_NAME) {
    problems.push(
      `RelaunchDisplayNameResource is ${shown(entry.relaunchDisplayName)}, expected '${PRIVATE_DISPLAY_NAME}'`
    )
  }
  const icon = iconResourcePath(entry.relaunchIconResource)
  if (!icon) {
    problems.push(
      `RelaunchIconResource is ${shown(entry.relaunchIconResource)}, expected '<ico>,0' naming the private icon`
    )
  } else {
    if (!/[\\/]private[\\/]icon\.ico$/i.test(icon)) {
      problems.push(`RelaunchIconResource names ${shown(icon)}, not the private icon.ico`)
    }
    if (exists === false)
      problems.push(`RelaunchIconResource names ${shown(icon)}, which is not on disk`)
  }
  return problems
}

/** The file of an `<path>,<index>` icon resource whose index is 0, or null. */
export function iconResourcePath(resource) {
  if (typeof resource !== 'string') return null
  const m = /^(.*),(-?\d+)$/.exec(resource)
  if (!m || m[2] !== '0') return null
  return m[1]
}

/**
 * What is wrong with the main window's entry: it sits on the process's id, so its frame carries
 * either nothing or the app's own id – never the private one.
 */
export function mainWindowProblems(entry) {
  if (!entry) return ['the main window is not among the process’s top-level windows']
  const problems = []
  if (entry.appUserModelId !== null && entry.appUserModelId !== APP_USER_MODEL_ID) {
    problems.push(
      `the main window's System.AppUserModel.ID is ${shown(entry.appUserModelId)}, expected none or '${APP_USER_MODEL_ID}'`
    )
  }
  return problems
}

/** Main-process helper: the new windows' ids, frame handles and titles (plain function: it is serialised). */
function windowFacts({ BrowserWindow }) {
  return BrowserWindow.getAllWindows().map((w) => {
    const handle = w.getNativeWindowHandle()
    // The HWND as Windows numbers it: 8 bytes little-endian on x64 (4 on x86).
    const hwnd =
      handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0))
    return { id: w.id, hwnd, title: w.getTitle(), visible: w.isVisible() }
  })
}

export async function scenarioPrivateTaskbar(h) {
  const { freshProfile, runScenario, waitFor, log, grabScreen, ps, exe = null, isWin } = h
  if (!isWin) {
    log(`${PRIVATE_TASKBAR_SCENARIO}: Windows only (taskbar groups are Windows's); skipped`)
    return
  }
  const userData = freshProfile(`profile-${PRIVATE_TASKBAR_SCENARIO}`, { onboardingDone: true })
  const exeDir = exe ? realPath(path.dirname(exe)) : null

  return runScenario(PRIVATE_TASKBAR_SCENARIO, userData, {}, async (s, out) => {
    out.aumid = PRIVATE_APP_USER_MODEL_ID
    const invoke = (name, args) =>
      s.chrome.evaluate(({ name, args }) => window.zen.invoke(name, args), { name, args })
    const main = await s.app.evaluate(({ app }) => ({
      execPath: process.execPath,
      userData: app.getPath('userData'),
      name: app.getName()
    }))
    out.main = main
    const command = expectedPrivateRelaunchCommand(main.execPath, main.userData)
    // The frames belong to the browser process (`s.appPid`), not to the cmd.exe Playwright
    // launches it through on Windows (`s.pid` there; run 36020202657 read no windows under it).
    const pid = s.appPid ?? s.pid
    out.pid = { browser: s.appPid, launcher: s.pid }
    const readWindows = () => {
      const r = ps('win-taskbar.ps1', ['-Action', 'windows', '-ProcessId', String(pid)], 60000)
      const windows = parseJson(r.stdout, r).windows
      if (windows.length === 0) {
        throw new Error(
          `no top-level window under pid ${pid} (browser ${shown(s.appPid)}, launcher ${shown(s.pid)})`
        )
      }
      return windows
    }
    let privateWin = null
    let mainWin = null

    await s.step('open-private-window', async () => {
      const before = await s.app.evaluate(windowFacts)
      mainWin = before.find((w) => w.id === s.mainWindowId) ?? before[0]
      await invoke('window.newPrivate')
      let after = null
      await waitFor(
        async () => {
          after = await s.app.evaluate(windowFacts)
          const fresh = after.filter((w) => !before.some((b) => b.id === w.id))
          return fresh.length === 1 && fresh[0].visible
        },
        20000,
        'the private window up',
        250
      )
      privateWin = after.find((w) => !before.some((b) => b.id === w.id))
      if (!/\(Private/.test(privateWin.title)) {
        throw new Error(
          `the new window's title is '${privateWin.title}', not a private window's ("… (Private)")`
        )
      }
      return { main: mainWin, private: privateWin }
    })

    await s.step('private-window-grouped', async () => {
      const windows = readWindows()
      const entry = windows.find((w) => String(w.hwnd) === privateWin.hwnd) ?? null
      const mainEntry = windows.find((w) => String(w.hwnd) === mainWin.hwnd) ?? null
      const icon = iconResourcePath(entry?.relaunchIconResource)
      const exists = icon ? fs.existsSync(icon) : null
      const problems = [
        ...privateWindowProblems(entry, { command, exists }),
        ...mainWindowProblems(mainEntry)
      ]
      const facts = { command, private: entry, main: mainEntry, iconExists: exists, windows }
      if (problems.length) {
        const err = new Error(problems.join('; '))
        err.detail = facts
        throw err
      }
      log(
        `${PRIVATE_TASKBAR_SCENARIO}: the private window's frame carries '${entry.appUserModelId}', relaunch ${shown(entry.relaunchCommand)}, name ${shown(entry.relaunchDisplayName)}; the main window's carries ${shown(mainEntry.appUserModelId)}`
      )
      return facts
    })

    await s.step('private-icon', async () => {
      const windows = readWindows()
      const entry = windows.find((w) => String(w.hwnd) === privateWin.hwnd) ?? null
      const icon = iconResourcePath(entry?.relaunchIconResource)
      if (!icon)
        throw new Error(
          `no icon resource on the private window: ${shown(entry?.relaunchIconResource)}`
        )
      const exists = fs.existsSync(icon)
      const real = exists ? realPath(icon) : null
      const under = exeDir ? isUnderDirectory(real ?? icon, exeDir) : null
      if (!exists) throw new Error(`the private icon ${shown(icon)} is not on disk`)
      if (under === false) {
        throw new Error(
          `the private icon ${shown(icon)} is not under the running build's directory '${exeDir}'`
        )
      }
      return { icon, exists, realPath: real, underExeDir: under, size: fs.statSync(icon).size }
    })

    await s.step('class-key', async () => {
      let facts = null
      let problems = null
      await waitFor(
        async () => {
          const r = ps(
            'win-toast.ps1',
            ['-Action', 'app-id', '-Aumid', PRIVATE_APP_USER_MODEL_ID],
            60000
          )
          facts = parseJson(r.stdout, r)
          if (facts.class?.IconUri && facts.iconExists === true) {
            facts.iconRealPath = realPath(facts.class.IconUri)
          }
          problems = appIdProblems(facts, {
            displayName: PRIVATE_DISPLAY_NAME,
            aumid: PRIVATE_APP_USER_MODEL_ID,
            exeDir
          })
          if (problems.length === 0 && !/[\\/]private[\\/]icon\.png$/i.test(facts.class.IconUri)) {
            problems.push(
              `${facts.classKey} IconUri names ${shown(facts.class.IconUri)}, not the private icon.png`
            )
          }
          return problems.length === 0
        },
        15000,
        'the private id’s class key complete and the running build’s',
        1000
      ).catch((e) => {
        const err = new Error(problems ? problems.join('; ') : e.message)
        err.detail = facts
        throw err
      })
      return facts
    })

    await s.step('taskbar-still', async () => {
      // Recorded, not judged: the runner's session may show no taskbar at all.
      await s.bringToFront(privateWin.id).catch(() => undefined)
      return grabScreen(`${PRIVATE_TASKBAR_SCENARIO}-both-windows`)
    })

    await s.step('close-private-window', async () => {
      await s.app.evaluate(({ BrowserWindow }, id) => {
        const w = BrowserWindow.fromId(id)
        if (w && !w.isDestroyed()) w.close()
      }, privateWin.id)
      await waitFor(
        async () => (await s.app.evaluate(windowFacts)).length === 1,
        15000,
        'the private window closed',
        250
      )
      return { remaining: await s.app.evaluate(windowFacts) }
    })

    await s.step('quit', async () => s.quitGracefully())
  })
}

function realPath(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

function parseJson(text, r) {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(
      `win script printed no JSON (status ${r.status}): ${text || r.stderr || r.error || e.message}`
    )
  }
}
