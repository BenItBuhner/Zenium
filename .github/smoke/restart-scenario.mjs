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
//
// Every read of the key is timed to a budget (W8-F10): the app's handler runs inside the emit –
// the RunOnce write is a synchronous `reg.exe add` – so `emitSessionEnd`/`emitWillQuit` return the
// app's clock either side of it (when the app wrote), and the key is then read every
// RUN_ONCE_POLL_EVERY_MS until it agrees, to RUN_ONCE_BUDGET_MS, each read stamped from that
// return. A key that never agrees fails after the budget with the read trace, the app's word on
// when it wrote and two `reg.exe query` cross-reads (the harness's, and the app's own while it is
// up): a write that raced the reads tells from one the PowerShell reader never sees.
import { createHash } from 'node:crypto'

export const RESTART_SCENARIO = 'restart-registration'

/** Must equal `RUN_ONCE_KEY` in src/main/platform/restartRegistration.ts (the test holds them in step). */
export const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'

/**
 * How long the RunOnce key is read for, from the poll's start, before the step is judged (W8-F10).
 * The app writes the entry synchronously inside the window's `session-end` handler (`reg.exe
 * add`), and `emitSessionEnd` returns the app's clock either side of that emit, so every read is
 * stamped from when the app's write returned. On the windows-arm64 legs (the slow Intel-emulated
 * runner) the entry the app said it wrote read back missing on 2026-09-27: `session-end-registers`
 * for the whole of its 10 s (run 36319202354 on main; the `[zen] restart:` line said registered),
 * and `registration-survives` 500 ms after the process's end, having read present before it (run
 * 36329961432 on #615). The poll gives the read a budget in place of one shot; a key that never
 * agrees still fails after it, with the read trace and the cross-reads. A `read` is a PowerShell
 * spawn (300–1000 ms on that leg), so the budget is some 20–40 reads.
 */
export const RUN_ONCE_BUDGET_MS = 20_000

/** The least time between two reads of the RunOnce key while it is polled (W8-F10). */
export const RUN_ONCE_POLL_EVERY_MS = 500

/** `ms` as the RunOnce read trace writes an offset from the app's write returning: `+2.0s`. */
const runOnceSec = (ms) => `${ms < 0 ? '-' : '+'}${(Math.abs(ms) / 1000).toFixed(1)}s`

/**
 * The app's word on when it handled the event `emitSessionEnd` or `emitWillQuit` raised, for a
 * log line or a failure: the handler runs inside the emit – the RunOnce write or delete is a
 * synchronous `reg.exe` – so `returnedAt` is when the app had written, by its clock (the
 * harness's: one machine). An `emitted` without the clock reads as such.
 */
export function describeEmit(emitted) {
  if (!emitted || typeof emitted.emittedAt !== 'number' || typeof emitted.returnedAt !== 'number') {
    return 'the app gave no time for its handler'
  }
  const at = new Date(emitted.returnedAt).toISOString().slice(11, 24)
  const what =
    emitted.event === 'will-quit'
      ? 'will-quit'
      : `session-end (${(emitted.reasons ?? []).join(', ') || 'shutdown'})`
  return `the app's ${what} handler returned at ${at} after ${emitted.returnedAt - emitted.emittedAt} ms`
}

/**
 * What a `reg.exe query <key> /v <name>` came to – the view of the tool the app writes with, taken
 * on a miss from the harness and from inside the app's process. `result` is `sh`'s shape (`status`,
 * `stdout`, `stderr`, `error`), or `{ available: false, reason }` when it could not be run. Returns
 * `present` with the value, `missing` (reg.exe's "unable to find the specified registry key or
 * value"), `unreadable` with a note (an error, a timeout, output it does not know), or
 * `unavailable`.
 */
export function regQueryState(result) {
  if (!result || result.available === false) {
    return { state: 'unavailable', value: null, note: result?.reason ?? 'reg.exe was not run' }
  }
  if (result.error) return { state: 'unreadable', value: null, note: String(result.error) }
  const stdout = String(result.stdout ?? '')
  if (result.status === 0) {
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*\S+\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line)
      if (m) return { state: 'present', value: m[1].trim() }
    }
    return { state: 'unreadable', value: null, note: 'exit 0 without a REG_SZ line' }
  }
  const text = `${stdout}\n${result.stderr ?? ''}`
  if (/unable to find the specified registry key or value/i.test(text)) {
    return { state: 'missing', value: null }
  }
  return {
    state: 'unreadable',
    value: null,
    note: (String(result.stderr ?? '') || stdout || `exit ${result.status}`).trim().slice(0, 200)
  }
}

/**
 * The failure a RunOnce step throws when the budget passes (W8-F10), one line: the problems the
 * last read left (`entryProblems`/`logProblems`, the wording the step's readers know, first), the
 * app's word on its handler, any `notes`, the read trace, and the `reg.exe query` cross-reads
 * (`cross`: who → `regQueryState`) when they were taken. The values read stay in the failure's
 * detail; the message carries the states.
 */
export function runOnceMissMessage({
  problems,
  emitted = null,
  notes = [],
  reads = [],
  cross = null
}) {
  const parts = [problems.join('; ')]
  if (emitted) parts.push(describeEmit(emitted))
  parts.push(...notes)
  parts.push(`reads ${formatRunOnceReads(reads)}`)
  if (cross && Object.keys(cross).length) {
    const views = Object.entries(cross).map(
      ([who, q]) => `${who} ${q.state}${q.state === 'unreadable' && q.note ? ` (${q.note})` : ''}`
    )
    parts.push(`reg query: ${views.join(', ')}`)
  }
  return parts.join('; ')
}

/**
 * The verdict on a sequence of RunOnce reads (`reads`, each `{ ms, entry }` – `ms` since the
 * app's write returned, `entry` the value read or null): whether the state the step waited for
 * was ever observed. `present: true` waits for the entry to appear (the registration written),
 * `present: false` for it to be gone (a clean quit's take-back, a skipped registration). Returns
 * `present` or `absent` and `seenAtMs`, the first read that met it (null when none did). Pure, so
 * the classifier is `restart-scenario.test.mjs`'s.
 */
export function runOnceVerdict(reads, { present = true } = {}) {
  const has = (r) => r.entry !== null && r.entry !== undefined
  const wanted = (r) => (present ? has(r) : !has(r))
  const hit = (reads ?? []).find(wanted)
  return {
    verdict: hit ? (present ? 'present' : 'absent') : present ? 'absent' : 'present',
    seenAtMs: hit ? hit.ms : null
  }
}

/**
 * The RunOnce read trace as one line for a failure message: `reads` are `{ ms, entry }` (ms since
 * the app's write returned). Consecutive reads that agree (the entry present, or missing) collapse
 * into one entry with their span and count, so a budget of 500 ms reads is a few entries:
 *
 *     +2.0s…+14.5s ×26 missing
 *     +0.2s present
 *
 * No reads reads `(no reads)`.
 */
export function formatRunOnceReads(reads) {
  if (!reads || reads.length === 0) return '(no reads)'
  const runs = []
  for (const r of reads) {
    const state = r.entry === null || r.entry === undefined ? 'missing' : 'present'
    const last = runs[runs.length - 1]
    if (last && last.state === state) {
      last.to = r.ms
      last.count++
    } else {
      runs.push({ from: r.ms, to: r.ms, count: 1, state })
    }
  }
  return runs
    .map((r) =>
      r.count === 1
        ? `${runOnceSec(r.from)} ${r.state}`
        : `${runOnceSec(r.from)}…${runOnceSec(r.to)} ×${r.count} ${r.state}`
    )
    .join('; ')
}

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

/**
 * In the main process: the window's `session-end`, as Electron raises it off WM_ENDSESSION. The
 * app's handler – the RunOnce write, a synchronous `reg.exe add` – runs inside the emit, so the
 * clock either side of it says when the app wrote (W8-F10): `emittedAt` before, `returnedAt` once
 * the handler had returned.
 */
function emitSessionEnd({ BrowserWindow }, { id, reasons }) {
  const w = BrowserWindow.fromId(id)
  if (!w || w.isDestroyed()) throw new Error(`window ${id} is gone`)
  const emittedAt = Date.now()
  const listened = w.emit('session-end', { reasons })
  const returnedAt = Date.now()
  return { event: 'session-end', listened, reasons, emittedAt, returnedAt }
}

/**
 * In the main process: the app's `will-quit`, as a clean quit raises it; the app stays up. The
 * clock either side of the emit, as `emitSessionEnd` returns it (the take-back is a synchronous
 * `reg.exe delete` inside the handler).
 */
function emitWillQuit({ app }) {
  let prevented = false
  const emittedAt = Date.now()
  const listened = app.emit('will-quit', {
    preventDefault: () => {
      prevented = true
    }
  })
  const returnedAt = Date.now()
  return { event: 'will-quit', listened, prevented, emittedAt, returnedAt }
}

/**
 * In the main process: `reg.exe query` for the entry from inside the app – the process that
 * wrote it, with its token and its view of the registry (W8-F10's cross-read on a miss).
 * Playwright evaluates this through the Node inspector, so `child_process` comes off the main
 * module's `require` (as hookMain takes `fs`); without one, `available: false`.
 */
function appRegQuery(_electron, { key, name }) {
  let cp = null
  try {
    cp =
      process.mainModule && process.mainModule.require
        ? process.mainModule.require('child_process')
        : null
  } catch {
    cp = null
  }
  if (!cp) {
    try {
      cp = typeof globalThis.require === 'function' ? globalThis.require('child_process') : null
    } catch {
      cp = null
    }
  }
  if (!cp) return { available: false, reason: 'no require in the main process' }
  const startedAt = Date.now()
  const r = cp.spawnSync('reg.exe', ['query', key, '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  })
  return {
    available: true,
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    error: r.error ? String(r.error.message) : undefined,
    tookMs: Date.now() - startedAt,
    pid: process.pid
  }
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `delay`,
 * `log`, `ps` (a PowerShell runner for the scripts beside smoke.mjs), `sh` (a command runner, for
 * the `reg.exe query` cross-read; optional) and `isWin`.
 */
export async function scenarioRestartRegistration(h) {
  const { freshProfile, runScenario, delay, log, ps, sh = null, isWin } = h
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
      /**
       * The RunOnce key read every RUN_ONCE_POLL_EVERY_MS until `judge(facts)` has nothing against
       * it, to RUN_ONCE_BUDGET_MS from the poll's start (W8-F10). Every read is stamped `ms` from
       * `since` – the app's clock as its handler returned – with the read's own length, so a miss
       * says what the key held, when. Returns the last facts, the reads, and what the last read
       * left (`hit` when nothing).
       */
      const pollRunOnce = async (judge, { since }) => {
        const deadline = Date.now() + RUN_ONCE_BUDGET_MS
        const reads = []
        for (;;) {
          const startedAt = Date.now()
          const facts = read('read')
          reads.push({
            ms: startedAt - since,
            tookMs: Date.now() - startedAt,
            entry: facts?.entry ?? null
          })
          const problems = judge(facts)
          if (problems.length === 0) return { facts, reads, problems, hit: true }
          if (Date.now() >= deadline) return { facts, reads, problems, hit: false }
          await delay(RUN_ONCE_POLL_EVERY_MS)
        }
      }
      /**
       * The key read the way the app writes it, `reg.exe query`: from the harness, and – while
       * the app is up – from inside the app's process. Taken when a poll came up short: the two
       * views beside the PowerShell reader's.
       */
      const crossRead = async ({ appAlive }) => {
        const cross = {}
        if (sh) {
          cross.harness = regQueryState(
            sh('reg.exe', ['query', RUN_ONCE_KEY, '/v', appValueName], 15000)
          )
        }
        if (appAlive) {
          cross.app = regQueryState(
            await s.app
              .evaluate(appRegQuery, { key: RUN_ONCE_KEY, name: appValueName })
              .catch((e) => ({ error: `evaluate failed: ${e?.message ?? e}` }))
          )
        }
        return cross
      }
      /** The failure a poll that came up short throws: the message `runOnceMissMessage` words, the facts in `detail`. */
      const miss = (polled, { emitted = null, notes = [], cross = null, detail = {} }) => {
        const err = new Error(
          runOnceMissMessage({
            problems: polled.problems,
            emitted,
            notes,
            reads: polled.reads,
            cross
          })
        )
        err.detail = { emitted, facts: polled.facts, reads: polled.reads, cross, ...detail }
        return err
      }
      const lastRead = (reads) => reads[reads.length - 1]
      /**
       * An end of the session, then the registry and the log read to the budget until they
       * agree; a miss carries the app's word on when it wrote, the reads and the cross-reads.
       */
      const endSession = async (reasons, { present, outcome }) => {
        const linesBefore = logLines().length
        const emitted = await sessionEnd(reasons)
        if (!emitted.listened) {
          throw new Error(
            `no session-end listener on window ${s.mainWindowId}: the hook is not there`
          )
        }
        const polled = await pollRunOnce(
          (facts) => [
            ...entryProblems(facts, { valueName: appValueName, command, present }),
            ...logProblems(logLines(), { before: linesBefore, outcome })
          ],
          { since: emitted.returnedAt }
        )
        const fresh = logLines().slice(linesBefore)
        if (!polled.hit) {
          throw miss(polled, {
            emitted,
            cross: await crossRead({ appAlive: true }),
            detail: { log: fresh }
          })
        }
        return { emitted, facts: polled.facts, reads: polled.reads, log: fresh }
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
          `${RESTART_SCENARIO}: ${detail.facts.runOnceKey}\\${appValueName} = ${detail.facts.entry} (read ${runOnceSec(lastRead(detail.reads).ms)} after ${describeEmit(detail.emitted)})`
        )
        return detail
      })

      await s.step('clean-quit-unregisters', async () => {
        const emitted = await s.app.evaluate(emitWillQuit)
        if (!emitted.listened) throw new Error('no will-quit listener on the app')
        const polled = await pollRunOnce(
          (facts) => entryProblems(facts, { valueName: appValueName, present: false }),
          { since: emitted.returnedAt }
        )
        if (!polled.hit) {
          throw miss(polled, { emitted, cross: await crossRead({ appAlive: true }) })
        }
        return { emitted, facts: polled.facts, reads: polled.reads, log: logLines().slice(-1) }
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
        const killedAt = s.killedAt
        const ended = `the process was ended ${runOnceSec(killedAt - registered.emitted.returnedAt)} after the app's handler returned`
        // The entry read to the budget after the process's end, each read stamped from the app's
        // write: what the next sign-in would run.
        const polled = await pollRunOnce(
          (facts) => entryProblems(facts, { valueName: appValueName, command, present: true }),
          { since: registered.emitted.returnedAt }
        )
        if (!polled.hit) {
          throw miss(polled, {
            emitted: registered.emitted,
            notes: [ended],
            cross: await crossRead({ appAlive: false }),
            detail: { registered, exit, killedAt }
          })
        }
        log(
          `${RESTART_SCENARIO}: the entry stands after the process's end: ${polled.facts.entry} (read ${runOnceSec(lastRead(polled.reads).ms)} after the app's write; ${ended})`
        )
        return { registered, exit, killedAt, facts: polled.facts, reads: polled.reads }
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
