import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RESTART_SCENARIO,
  RUN_ONCE_BUDGET_MS,
  RUN_ONCE_KEY,
  RUN_ONCE_POLL_EVERY_MS,
  describeEmit,
  entryProblems,
  expectedRestartCommand,
  formatRunOnceReads,
  logProblems,
  quoteWindowsArg,
  regQueryState,
  restartLogLines,
  runOnceMissMessage,
  runOnceValueName,
  runOnceVerdict
} from './restart-scenario.mjs'
import * as main from '../../src/main/platform/restartRegistration'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\Zenium\\Zenium.exe'
const PROFILE = 'D:\\a\\Zenium\\Zenium\\smoke-out\\profiles\\profile-restart-registration'

describe('the scenario constants', () => {
  it('names the scenario the harness table and both Windows legs of the workflow use', () => {
    expect(RESTART_SCENARIO).toBe('restart-registration')
    const workflow = read('.github/workflows/desktop-smoke.yml')
    const legs = workflow.match(/--scenarios [a-z,-]*\brestart-registration\b/g) ?? []
    expect(legs).toHaveLength(2)
    expect(read('.github/smoke/smoke.mjs')).toContain('[RESTART_SCENARIO]: () =>')
  })

  it('reads the key the main process writes', () => {
    expect(RUN_ONCE_KEY).toBe(main.RUN_ONCE_KEY)
    expect(read('.github/smoke/win-restart.ps1')).toContain(
      "$RunOnceKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'"
    )
    expect(read('.github/smoke/win-restart.ps1')).toContain(
      "$WinlogonKey = 'Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'"
    )
    expect(main.RESTART_APPS_KEY).toBe(
      'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
    )
  })

  it('ends the browser process itself in the registration-survives step', () => {
    // `s.kill()` stands for Windows ending the process after WM_ENDSESSION. Playwright launches
    // Electron through cmd.exe on win32, so a taskkill on the launched pid ended the shell and
    // left the app running (run 36020202657's leftover processes): the harness kills the main
    // process's own pid, which it resolves after the launch.
    const harness = read('.github/smoke/smoke.mjs')
    expect(harness).toContain('this.appPid = await this.app.evaluate(() => process.pid)')
    expect(harness).toMatch(/async kill\(\) \{[^}]*const pid = this\.appPid \?\? this\.pid/)
    expect(read('.github/smoke/restart-scenario.mjs')).toContain('const exit = await s.kill()')
  })

  it('reads the RunOnce key to a budget, every half second, stamped from the app’s write (W8-F10)', () => {
    // The budget is the poll's, from its start; a read is a PowerShell spawn, so on the arm64 leg
    // (300–1000 ms each) it is some 20–40 reads. It sits inside the harness's 60 s step timeout
    // with room for the emit, the process's end (10 s at most) and the cross-reads.
    expect(RUN_ONCE_BUDGET_MS).toBe(20_000)
    expect(RUN_ONCE_POLL_EVERY_MS).toBe(500)
    const scenario = read('.github/smoke/restart-scenario.mjs')
    // The app's clock either side of the emit: the handler – the write – runs inside it.
    expect(scenario).toMatch(
      /const emittedAt = Date\.now\(\)\s+const listened = w\.emit\('session-end', \{ reasons \}\)\s+const returnedAt = Date\.now\(\)/
    )
    expect(scenario).toMatch(
      /const emittedAt = Date\.now\(\)\s+const listened = app\.emit\('will-quit'/
    )
    // Every read is stamped from that return, and the three steps that read the key poll it.
    expect(scenario).toContain('{ since: emitted.returnedAt }')
    expect(scenario).toContain('{ since: registered.emitted.returnedAt }')
    expect(scenario).not.toContain('await delay(500)')
    expect(scenario).not.toContain('waitFor(')
    // The harness lends `sh` for the reg.exe cross-read.
    const harness = read('.github/smoke/smoke.mjs')
    expect(harness).toMatch(/scenarioRestartRegistration\(\{[^}]*\bsh,/)
  })
})

describe('the RunOnce reads (W8-F10)', () => {
  const command = `${EXE} --user-data-dir=${PROFILE} --restore-last-session`

  it('runOnceVerdict names the first read that met the state waited for', () => {
    const late = [
      { ms: 120, entry: null },
      { ms: 900, entry: null },
      { ms: 1600, entry: command }
    ]
    expect(runOnceVerdict(late)).toEqual({ verdict: 'present', seenAtMs: 1600 })
    expect(runOnceVerdict(late, { present: false })).toEqual({ verdict: 'absent', seenAtMs: 120 })
    const never = [
      { ms: 200, entry: null },
      { ms: 19800, entry: null }
    ]
    expect(runOnceVerdict(never)).toEqual({ verdict: 'absent', seenAtMs: null })
    expect(runOnceVerdict(never, { present: false })).toEqual({ verdict: 'absent', seenAtMs: 200 })
    const stays = [{ ms: 300, entry: command }]
    expect(runOnceVerdict(stays, { present: false })).toEqual({
      verdict: 'present',
      seenAtMs: null
    })
    expect(runOnceVerdict([])).toEqual({ verdict: 'absent', seenAtMs: null })
    expect(runOnceVerdict(undefined, { present: false })).toEqual({
      verdict: 'present',
      seenAtMs: null
    })
    // An `entry` left undefined (a read without the field) counts as missing, as entryProblems has it.
    expect(runOnceVerdict([{ ms: 50 }])).toEqual({ verdict: 'absent', seenAtMs: null })
  })

  it('formatRunOnceReads collapses the reads that agree into spans', () => {
    // The main leg's red of 2026-09-27: the app said registered, the key read missing for 10.9 s.
    const missing = Array.from({ length: 12 }, (_, i) => ({ ms: 400 + i * 950, entry: null }))
    expect(formatRunOnceReads(missing)).toBe('+0.4s…+10.8s ×12 missing')
    // A write that landed late: two misses, then the entry.
    expect(
      formatRunOnceReads([
        { ms: 300, entry: null },
        { ms: 1100, entry: null },
        { ms: 1900, entry: command }
      ])
    ).toBe('+0.3s…+1.1s ×2 missing; +1.9s present')
    // registration-survives on #615: present before the process's end, gone after it.
    expect(
      formatRunOnceReads([
        { ms: 500, entry: command },
        { ms: 3200, entry: null },
        { ms: 4100, entry: null }
      ])
    ).toBe('+0.5s present; +3.2s…+4.1s ×2 missing')
    expect(formatRunOnceReads([{ ms: -20, entry: command }])).toBe('-0.0s present')
    expect(formatRunOnceReads([])).toBe('(no reads)')
    expect(formatRunOnceReads(undefined)).toBe('(no reads)')
  })

  it('describeEmit is the app’s word on when its handler returned', () => {
    const emitted = {
      event: 'session-end',
      listened: true,
      reasons: ['logoff'],
      emittedAt: Date.UTC(2026, 8, 27, 15, 41, 56, 800),
      returnedAt: Date.UTC(2026, 8, 27, 15, 41, 56, 843)
    }
    expect(describeEmit(emitted)).toBe(
      "the app's session-end (logoff) handler returned at 15:41:56.843Z after 43 ms"
    )
    expect(describeEmit({ ...emitted, reasons: undefined })).toBe(
      "the app's session-end (shutdown) handler returned at 15:41:56.843Z after 43 ms"
    )
    expect(describeEmit({ ...emitted, event: 'will-quit', reasons: undefined })).toBe(
      "the app's will-quit handler returned at 15:41:56.843Z after 43 ms"
    )
    // An older emit without the clock, or none, reads as such rather than as a time.
    expect(describeEmit({ listened: true, reasons: ['shutdown'] })).toBe(
      'the app gave no time for its handler'
    )
    expect(describeEmit(null)).toBe('the app gave no time for its handler')
  })

  it('regQueryState reads reg.exe query the way the app writes', () => {
    const present = {
      status: 0,
      stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce\r\n    Zenium.e3e6e98b    REG_SZ    ${command}\r\n\r\n`,
      stderr: ''
    }
    expect(regQueryState(present)).toEqual({ state: 'present', value: command })
    expect(
      regQueryState({
        status: 1,
        stdout: '',
        stderr: '\r\nERROR: The system was unable to find the specified registry key or value.\r\n'
      })
    ).toEqual({ state: 'missing', value: null })
    // The app's view arrives with `available` and the spawn's facts; a timeout is `error`.
    expect(regQueryState({ available: true, ...present, tookMs: 120, pid: 4242 })).toEqual({
      state: 'present',
      value: command
    })
    expect(regQueryState({ available: false, reason: 'no require in the main process' })).toEqual({
      state: 'unavailable',
      value: null,
      note: 'no require in the main process'
    })
    expect(
      regQueryState({ status: null, stdout: '', stderr: '', error: 'spawnSync reg.exe ETIMEDOUT' })
    ).toEqual({
      state: 'unreadable',
      value: null,
      note: 'spawnSync reg.exe ETIMEDOUT'
    })
    expect(regQueryState({ status: 1, stdout: '', stderr: 'ERROR: Access is denied.' })).toEqual({
      state: 'unreadable',
      value: null,
      note: 'ERROR: Access is denied.'
    })
    expect(regQueryState({ status: 0, stdout: 'nothing of note', stderr: '' })).toEqual({
      state: 'unreadable',
      value: null,
      note: 'exit 0 without a REG_SZ line'
    })
    expect(regQueryState(null)).toEqual({
      state: 'unavailable',
      value: null,
      note: 'reg.exe was not run'
    })
  })

  it('runOnceMissMessage leads with the readers’ wording, then the app’s word, the reads and the cross-reads', () => {
    const emitted = {
      event: 'session-end',
      reasons: ['shutdown'],
      emittedAt: Date.UTC(2026, 8, 27, 12, 39, 13, 900),
      returnedAt: Date.UTC(2026, 8, 27, 12, 39, 13, 951)
    }
    const problems = entryProblems({ entry: null, entries: {} }, { valueName: 'Zenium.afce3647' })
    const reads = Array.from({ length: 12 }, (_, i) => ({ ms: 400 + i * 950, entry: null }))
    const message = runOnceMissMessage({
      problems,
      emitted,
      reads,
      cross: {
        harness: { state: 'missing', value: null },
        app: { state: 'present', value: command }
      }
    })
    expect(message).toBe(
      `${RUN_ONCE_KEY}\\Zenium.afce3647 is missing; the app's session-end (shutdown) handler returned at 12:39:13.951Z after 51 ms; reads +0.4s…+10.8s ×12 missing; reg query: harness missing, app present`
    )
    // The message starts as the failure did before the poll, so its readers still know it.
    expect(message.startsWith(`${RUN_ONCE_KEY}\\Zenium.afce3647 is missing`)).toBe(true)
    // Notes go between the app's word and the reads; an unreadable cross-read carries its note;
    // no cross-reads, no clause; the values read stay out of the message.
    expect(
      runOnceMissMessage({
        problems: ['x is missing'],
        emitted,
        notes: ["the process was ended +2.1s after the app's handler returned"],
        reads: [
          { ms: 500, entry: command },
          { ms: 3200, entry: null }
        ],
        cross: {
          harness: { state: 'unreadable', value: null, note: 'exit 0 without a REG_SZ line' }
        }
      })
    ).toBe(
      "x is missing; the app's session-end (shutdown) handler returned at 12:39:13.951Z after 51 ms; the process was ended +2.1s after the app's handler returned; reads +0.5s present; +3.2s missing; reg query: harness unreadable (exit 0 without a REG_SZ line)"
    )
    expect(runOnceMissMessage({ problems: ['x is still there'], reads: [] })).toBe(
      'x is still there; reads (no reads)'
    )
    expect(runOnceMissMessage({ problems: ['x'], reads: [], cross: {} })).toBe(
      'x; reads (no reads)'
    )
  })
})

describe('the rules the scenario shares with the main process', () => {
  it('names the RunOnce value as restartRegistration.ts does', () => {
    expect(runOnceValueName(null)).toBe(main.runOnceValueName(null))
    expect(runOnceValueName(null)).toBe('Zenium')
    for (const dir of [PROFILE, PROFILE.toUpperCase(), 'C:\\p', 'D:\\a b\\c']) {
      expect(runOnceValueName(dir)).toBe(main.runOnceValueName(dir))
    }
    expect(runOnceValueName(PROFILE)).toMatch(/^Zenium\.[0-9a-f]{8}$/)
  })

  it('expects the command a packaged build registers, quoted as the main process quotes it', () => {
    const env = { execPath: EXE, isPackaged: true, appPath: 'unused', systemVersion: '10.0.26100' }
    for (const dir of [PROFILE, 'D:\\smoke out\\profile', null]) {
      expect(expectedRestartCommand(EXE, dir)).toBe(
        main.restartCommand({ ...env, userDataDir: dir })
      )
    }
    expect(expectedRestartCommand(EXE, 'D:\\smoke out\\profile')).toBe(
      `${EXE} "--user-data-dir=D:\\smoke out\\profile" --restore-last-session`
    )
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('a "b" c')).toBe('"a \\"b\\" c"')
  })
})

describe('entryProblems', () => {
  const facts = {
    runOnceKey: RUN_ONCE_KEY,
    entry: `${EXE} --user-data-dir=${PROFILE} --restore-last-session`,
    entries: { 'Zenium.1234abcd': `${EXE} --user-data-dir=${PROFILE} --restore-last-session` }
  }

  it('is silent when the entry holds the command, and names a wrong or missing one', () => {
    const valueName = 'Zenium.1234abcd'
    expect(entryProblems(facts, { valueName, command: facts.entry })).toEqual([])
    expect(entryProblems(facts, { valueName })).toEqual([])
    expect(entryProblems(facts, { valueName, command: `${EXE} --restore-last-session` })).toEqual([
      `${RUN_ONCE_KEY}\\Zenium.1234abcd holds '${facts.entry}', expected '${EXE} --restore-last-session'`
    ])
    expect(entryProblems({ ...facts, entry: null }, { valueName, command: facts.entry })).toEqual([
      `${RUN_ONCE_KEY}\\Zenium.1234abcd is missing (Zenium entries there: Zenium.1234abcd)`
    ])
    expect(entryProblems({ entry: null, entries: {} }, { valueName })).toEqual([
      `${RUN_ONCE_KEY}\\Zenium.1234abcd is missing`
    ])
    expect(entryProblems(null, { valueName })).toEqual([
      `${RUN_ONCE_KEY}\\Zenium.1234abcd is missing`
    ])
  })

  it('with present: false requires the entry gone', () => {
    const valueName = 'Zenium.1234abcd'
    expect(entryProblems({ ...facts, entry: null }, { valueName, present: false })).toEqual([])
    expect(entryProblems(facts, { valueName, present: false })).toEqual([
      `${RUN_ONCE_KEY}\\Zenium.1234abcd is still there: '${facts.entry}'`
    ])
  })
})

describe('the main process’s log', () => {
  const stdout = [
    '[zen] cli: --user-data-dir: the profile is D:\\profile',
    '[zen] restart: session ending (shutdown): relaunch registered under HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce\\Zenium.1234abcd (C:\\Zenium.exe --restore-last-session)',
    'unrelated',
    '[zen] restart: clean quit: the RunOnce relaunch entry is taken back',
    '  [zen] restart: session ending (shutdown): not registered – "restart my apps when I sign back in" is off in Windows Settings  '
  ].join('\r\n')

  it('reads the [zen] restart: lines in order', () => {
    const lines = restartLogLines(stdout)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^session ending \(shutdown\): relaunch registered under/)
    expect(lines[1]).toBe('clean quit: the RunOnce relaunch entry is taken back')
    expect(lines[2]).toMatch(/is off in Windows Settings$/)
    expect(restartLogLines('')).toEqual([])
    expect(restartLogLines(undefined)).toEqual([])
  })

  it('requires a fresh line with the outcome’s wording', () => {
    const lines = restartLogLines(stdout)
    expect(
      logProblems(lines.slice(0, 1), { before: 0, outcome: 'relaunch registered under' })
    ).toEqual([])
    expect(logProblems(lines, { before: 2, outcome: 'is off in Windows Settings' })).toEqual([])
    // The last fresh line is the one judged: one end of the session per read.
    expect(logProblems(lines, { before: 0, outcome: 'relaunch registered under' })).toHaveLength(1)
    expect(logProblems(lines, { before: 3, outcome: 'is off in Windows Settings' })).toEqual([
      'no [zen] restart: line for this end of the session (3 so far)'
    ])
    expect(logProblems(lines, { before: 2, outcome: 'relaunch registered under' })).toEqual([
      `the main process says '${lines[2]}', not 'relaunch registered under'`
    ])
  })

  it('uses the wording restartRegistration.ts logs', () => {
    const source = read('src/main/platform/restartRegistration.ts')
    for (const outcome of [
      'relaunch registered under',
      'is off in Windows Settings',
      'no sign-in follows',
      'clean quit: the RunOnce relaunch entry is taken back'
    ]) {
      expect(source).toContain(outcome)
    }
    expect(source).toContain("console.log('[zen] restart:', line)")
  })
})
