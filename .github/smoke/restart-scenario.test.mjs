import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RESTART_SCENARIO,
  RUN_ONCE_KEY,
  entryProblems,
  expectedRestartCommand,
  logProblems,
  quoteWindowsArg,
  restartLogLines,
  runOnceValueName
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
