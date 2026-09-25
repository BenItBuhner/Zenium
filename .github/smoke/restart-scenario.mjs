// The `restart-registration` scenario: Windows brings Zenium back with its session after a
// restart or a sign-out (os-49). Electron 44 has no `RegisterApplicationRestart`, so the main
// process (src/main/platform/restartRegistration.ts) writes the relaunch command under the
// user's RunOnce key when a window's `session-end` says the session is ending – gated on the
// user's "Automatically save my restartable apps and restart them when I sign back in" toggle
// (Winlogon\RestartApps) – and a clean quit takes the entry back. No runner restarts: the
// session's end is emitted on the main window from the main process (the event Electron
// raises off WM_ENDSESSION; the app's handlers run as they would), and what Windows would run
// at the next sign-in is read off the registry (win-restart.ps1). Its own file so the harness's
// scenario table gains one line for it (the `notifications` shape).
//
// What each step reads, and who confirms it:
//   toggle-on            the toggle before the run (kept, restored at the end) and set on, so the
//                        registration is exercised whatever the runner's default – the OS
//   session-end-registers  `session-end` {reasons:['shutdown']} on the main window: the RunOnce
//                        value for this profile (`Zenium.<hash of the profile's path>`) holds the
//                        running executable, `--user-data-dir=<this profile>` and
//                        `--restore-last-session`; the main process's `[zen] restart:` line says
//                        so – the app's handler, the OS's registry
//   clean-quit-unregisters  `will-quit` emitted on the app: the entry is gone (the quit's
//                        cleanup; the app is still up, so the steps after can register again)
//   toggle-off-skips     the toggle set off, `session-end` again: no entry, the line says why
//   close-app-skips      the toggle on, `session-end` {reasons:['close-app']} (the Restart
//                        Manager closing the app for an installer, which restarts it itself):
//                        no entry
//   registration-survives  `session-end` {reasons:['logoff']} registers again; the process is
//                        ended the way Windows ends it after WM_ENDSESSION (taskkill): the entry
//                        stands – what the next sign-in would run
//   cleanup              the entry deleted, the toggle put back as it was (the runner is not to
//                        launch Zenium at its next sign-in)
import { createHash } from 'node:crypto'

export const RESTART_SCENARIO = 'restart-registration'

/** Must equal `RUN_ONCE_KEY` in src/main/platform/restartRegistration.ts (the test holds them in step). */
export const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'

/**
 * The RunOnce value's name for a profile: `Zenium` for the default one, `Zenium.<8 hex of the
 * SHA-1 of the path, lower-cased>` for a `--user-data-dir` profile – the rule of
 * `runOnceValueName` in restartRegistration.ts (the test holds the two in step).
 */
export function runOnceValueName(userDataDir) {
  if (userDataDir === null || userDataDir === undefined) return 'Zenium'
  const hash = createHash('sha1').update(userDataDir.toLowerCase()).digest('hex').slice(0, 8)
  return `Zenium.${hash}`
}

/** A Windows command-line argument as restartRegistration.ts quotes one. */
export function quoteWindowsArg(arg) {
  if (!/[\s"]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

/**
 * The command a packaged build registers for a `--user-data-dir` profile: the executable, the
 * profile, `--restore-last-session` – `restartCommand` in restartRegistration.ts for a
 * packaged copy (the test holds the two in step).
 */
export function expectedRestartCommand(execPath, userDataDir) {
  const parts = [execPath]
  if (userDataDir !== null && userDataDir !== undefined) {
    parts.push(`--user-data-dir=${userDataDir}`)
  }
  parts.push('--restore-last-session')
  return parts.map(quoteWindowsArg).join(' ')
}

/**
 * What is wrong with the RunOnce facts (`win-restart.ps1`) when the entry is expected: the value
 * named must be there and hold `command`; with `present: false`, it must not be there. One line
 * per miss, empty when the registry agrees.
 */
export function entryProblems(facts, { valueName, command = null, present = true }) {
  const key = facts?.runOnceKey ?? RUN_ONCE_KEY
  const entry = facts?.entry ?? null
  if (!present) {
    return entry === null ? [] : [`${key}\\${valueName} is still there: ${shown(entry)}`]
  }
  if (entry === null) {
    const others = Object.keys(facts?.entries ?? {})
    return [
      `${key}\\${valueName} is missing${others.length ? ` (Zenium entries there: ${others.join(', ')})` : ''}`
    ]
  }
  if (command !== null && entry !== command) {
    return [`${key}\\${valueName} holds ${shown(entry)}, expected ${shown(command)}`]
  }
  return []
}

/**
 * The main process's `[zen] restart:` lines off its stdout (restartRegistration.ts's log), in
 * order: what each end of the session came to.
 */
export function restartLogLines(stdout) {
  const lines = []
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const m = /\[zen\] restart: (.*)$/.exec(raw.trim())
    if (m) lines.push(m[1].trim())
  }
  return lines
}

/**
 * What is wrong with the log after an end of the session: `outcome` is the wording the main
 * process uses for what happened (`relaunch registered under`, `is off in Windows Settings`, `no
 * sign-in follows`), and one more line than `before` has to say it.
 */
export function logProblems(lines, { before, outcome }) {
  const fresh = lines.slice(before)
  if (!fresh.length)
    return [`no [zen] restart: line for this end of the session (${lines.length} so far)`]
  const last = fresh[fresh.length - 1]
  if (!last.includes(outcome)) return [`the main process says '${last}', not '${outcome}'`]
  return []
}

function shown(v) {
  return v === undefined || v === null ? '<missing>' : `'${v}'`
}

/** In the main process: the window's `session-end`, as Electron raises it off WM_ENDSESSION. */
function emitSessionEnd({ BrowserWindow }, { id, reasons }) {
  const w = BrowserWindow.fromId(id)
  if (!w || w.isDestroyed()) throw new Error(`window ${id} is gone`)
  return { listened: w.emit('session-end', { reasons }), reasons }
}

/** In the main process: the app's `will-quit`, as a clean quit raises it; the app stays up. */
function emitWillQuit({ app }) {
  let prevented = false
  const listened = app.emit('will-quit', {
    preventDefault: () => {
      prevented = true
    }
  })
  return { listened, prevented }
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `waitFor`,
 * `delay`, `log`, `ps` (a PowerShell runner for the scripts beside smoke.mjs) and `isWin`.
 */
export async function scenarioRestartRegistration(h) {
  const { freshProfile, runScenario, waitFor, delay, log, ps, isWin } = h
  if (!isWin) {
    log(`${RESTART_SCENARIO}: Windows only (the RunOnce registration); nothing to run here`)
    return
  }
  const userData = freshProfile(`profile-${RESTART_SCENARIO}`, { onboardingDone: true })
  const valueName = runOnceValueName(userData)
  const restart = (action, extra = []) => {
    const r = ps('win-restart.ps1', ['-Action', action, '-ValueName', valueName, ...extra], 60000)
    return parseJson(r.stdout, r)
  }
  // Before the launch: the toggle as the runner has it, put back at the end whatever happens.
  const before = restart('read')
  const toggleBefore = before.restartApps
  log(
    `${RESTART_SCENARIO}: RestartApps before the run: ${shown(toggleBefore)} (build ${before.build}); RunOnce Zenium entries: ${Object.keys(before.entries ?? {}).join(', ') || 'none'}`
  )
  const restoreToggle = () =>
    toggleBefore === null || toggleBefore === undefined
      ? restart('clear-restart-apps')
      : restart('set-restart-apps', ['-Value', String(toggleBefore)])

  try {
    return await runScenario(RESTART_SCENARIO, userData, {}, async (s, out) => {
      out.valueName = valueName
      out.toggleBefore = toggleBefore
      const main = await s.app.evaluate(({ app }) => ({
        execPath: process.execPath,
        userData: app.getPath('userData'),
        systemVersion: process.getSystemVersion()
      }))
      // The name the main process derives is from the path the app resolved, which may differ
      // in form from the harness's (case, separators): the one the app has is the one to read.
      const appValueName = runOnceValueName(main.userData)
      if (appValueName !== valueName) {
        log(
          `${RESTART_SCENARIO}: the app resolved the profile to ${main.userData}; reading ${appValueName}`
        )
      }
      const read = (action, extra = []) => {
        const r = ps(
          'win-restart.ps1',
          ['-Action', action, '-ValueName', appValueName, ...extra],
          60000
        )
        return parseJson(r.stdout, r)
      }
      const command = expectedRestartCommand(main.execPath, main.userData)
      out.expected = { valueName: appValueName, command }
      const logLines = () => restartLogLines(s.stdout.join(''))
      const sessionEnd = (reasons) =>
        s.app.evaluate(emitSessionEnd, { id: s.mainWindowId, reasons })
      /** An end of the session, then the registry and the log read until they agree, or the problems. */
      const endSession = async (reasons, { present, outcome }) => {
        const linesBefore = logLines().length
        const emitted = await sessionEnd(reasons)
        if (!emitted.listened) {
          throw new Error(
            `no session-end listener on window ${s.mainWindowId}: the hook is not there`
          )
        }
        let facts = null
        let problems = null
        await waitFor(
          () => {
            facts = read('read')
            problems = [
              ...entryProblems(facts, { valueName: appValueName, command, present }),
              ...logProblems(logLines(), { before: linesBefore, outcome })
            ]
            return problems.length === 0
          },
          10000,
          `the RunOnce entry ${present ? 'written' : 'absent'} and the log's word`,
          500
        ).catch((e) => {
          const err = new Error(problems ? problems.join('; ') : e.message)
          err.detail = { emitted, facts, log: logLines().slice(linesBefore) }
          throw err
        })
        return { emitted, facts, log: logLines().slice(linesBefore) }
      }

      await s.step('toggle-on', async () => {
        const facts = read('set-restart-apps', ['-Value', '1'])
        if (facts.restartApps !== 1) {
          throw new Error(`RestartApps reads ${shown(facts.restartApps)} after the write`)
        }
        // A leftover entry of an earlier run would pass for this one's.
        if (facts.entry !== null && facts.entry !== undefined) read('delete-run-once')
        return { before: toggleBefore, ...facts, systemVersion: main.systemVersion }
      })

      await s.step('session-end-registers', async () => {
        const detail = await endSession(['shutdown'], {
          present: true,
          outcome: 'relaunch registered under'
        })
        log(
          `${RESTART_SCENARIO}: ${detail.facts.runOnceKey}\\${appValueName} = ${detail.facts.entry}`
        )
        return detail
      })

      await s.step('clean-quit-unregisters', async () => {
        const emitted = await s.app.evaluate(emitWillQuit)
        if (!emitted.listened) throw new Error('no will-quit listener on the app')
        let facts = null
        let problems = null
        await waitFor(
          () => {
            facts = read('read')
            problems = entryProblems(facts, { valueName: appValueName, present: false })
            return problems.length === 0
          },
          10000,
          'the RunOnce entry taken back',
          500
        ).catch((e) => {
          const err = new Error(problems ? problems.join('; ') : e.message)
          err.detail = { emitted, facts }
          throw err
        })
        const lines = logLines()
        return { emitted, facts, log: lines.slice(-1) }
      })

      await s.step('toggle-off-skips', async () => {
        const facts = read('set-restart-apps', ['-Value', '0'])
        if (facts.restartApps !== 0) {
          throw new Error(`RestartApps reads ${shown(facts.restartApps)} after the write`)
        }
        return endSession(['shutdown'], { present: false, outcome: 'is off in Windows Settings' })
      })

      await s.step('close-app-skips', async () => {
        const facts = read('set-restart-apps', ['-Value', '1'])
        if (facts.restartApps !== 1) {
          throw new Error(`RestartApps reads ${shown(facts.restartApps)} after the write`)
        }
        return endSession(['close-app'], { present: false, outcome: 'no sign-in follows' })
      })

      await s.step('registration-survives', async () => {
        const registered = await endSession(['logoff'], {
          present: true,
          outcome: 'relaunch registered under'
        })
        // Windows ends the process after WM_ENDSESSION; nothing of the app runs after this.
        const exit = await s.kill()
        await delay(500)
        const facts = read('read')
        const problems = entryProblems(facts, { valueName: appValueName, command, present: true })
        if (problems.length) {
          const err = new Error(problems.join('; '))
          err.detail = { registered, exit, facts }
          throw err
        }
        log(`${RESTART_SCENARIO}: the entry stands after the process's end: ${facts.entry}`)
        return { registered, exit, facts }
      })

      await s.step('cleanup', async () => {
        const facts = read('delete-run-once')
        const problems = entryProblems(facts, { valueName: appValueName, present: false })
        if (problems.length) throw new Error(problems.join('; '))
        return facts
      })
    })
  } finally {
    const after = restoreToggle()
    log(`${RESTART_SCENARIO}: RestartApps put back: ${shown(after.restartApps)}`)
  }
}

/** The JSON a PowerShell helper printed, or an error naming what it printed instead. */
function parseJson(text, r) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      `win-restart.ps1 printed no JSON (exit ${r?.status}): ${(r?.stderr || r?.stdout || r?.error || '').slice(0, 800)}`
    )
  }
}
