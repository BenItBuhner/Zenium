import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  REGISTRY_SPAWN_OPTIONS,
  REGISTRY_TIMEOUT_MS,
  RESTART_APPS_KEY,
  RESTART_APPS_QUERY,
  RESTART_APPS_VALUE,
  RUN_ONCE_KEY,
  SESSION_END_REGISTRY_CALLS,
  WINDOWS_END_SESSION_BUDGET_MS,
  installWindowsRestart,
  parseRegDword,
  relaunchAfter,
  restartAppsEnabled,
  restartCommand,
  runOnceDelete,
  runOnceQuery,
  runOnceValueName,
  runOnceWrite,
  windowsBuild,
  windowsRestartRegistration,
  type RestartEnvironment,
  type SessionEndApp,
  type SessionEndWindow
} from '../restartRegistration'
import type { WindowsRegistryCommand, WindowsRegistryResult } from '../notifications'

const INSTALLED: RestartEnvironment = {
  execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe',
  isPackaged: true,
  appPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\resources\\app.asar',
  userDataDir: null,
  systemVersion: '10.0.22631'
}

const SMOKE_PROFILE = 'D:\\a\\Zenium\\smoke out\\profiles\\profile-restart'

const WIN11 = '10.0.22631'
const WIN10 = '10.0.19045'

/**
 * A registry of the two keys reg.exe touches here: the Winlogon toggle (a DWORD, or absent) and
 * the RunOnce values. `query … /v` answers the one value the way reg.exe prints it and fails for
 * an absent one; `add` writes, `delete` removes. `ran` keeps every command; `refuse` fails all.
 */
type FakeRegistry = {
  ran: WindowsRegistryCommand[]
  refuse: boolean
  toggle: number | null
  runOnce: Map<string, string>
  run: (command: WindowsRegistryCommand) => WindowsRegistryResult
}

function fakeRegistry(toggle: number | null = 1): FakeRegistry {
  const runOnce = new Map<string, string>()
  const ran: WindowsRegistryCommand[] = []
  const registry: FakeRegistry = {
    ran,
    refuse: false,
    toggle,
    runOnce,
    run(command: WindowsRegistryCommand): WindowsRegistryResult {
      ran.push(command)
      if (registry.refuse) return { ok: false, stdout: '' }
      expect(command.file).toBe('reg.exe')
      const [verb, key, slashV, name] = command.args
      expect(slashV).toBe('/v')
      if (key === RESTART_APPS_KEY) {
        expect(verb).toBe('query')
        expect(name).toBe(RESTART_APPS_VALUE)
        if (registry.toggle === null) return { ok: false, stdout: '' }
        return {
          ok: true,
          stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\r\n    RestartApps    REG_DWORD    0x${registry.toggle.toString(16)}\r\n\r\n`
        }
      }
      expect(key).toBe(RUN_ONCE_KEY)
      switch (verb) {
        case 'query': {
          const data = runOnce.get(name)
          if (data === undefined) return { ok: false, stdout: '' }
          return { ok: true, stdout: `\r\n${key}\r\n    ${name}    REG_SZ    ${data}\r\n\r\n` }
        }
        case 'add':
          expect(command.args.slice(4)).toEqual(['/t', 'REG_SZ', '/d', command.args[7], '/f'])
          runOnce.set(name, command.args[7])
          return { ok: true, stdout: 'The operation completed successfully.\r\n' }
        case 'delete':
          expect(command.args.slice(4)).toEqual(['/f'])
          runOnce.delete(name)
          return { ok: true, stdout: 'The operation completed successfully.\r\n' }
        default:
          throw new Error(`unexpected reg.exe verb ${verb}`)
      }
    }
  }
  return registry
}

const verbs = (ran: WindowsRegistryCommand[]): string[] =>
  ran.map((c) => `${c.args[0]} ${c.args[1] === RESTART_APPS_KEY ? 'RestartApps' : c.args[3]}`)

describe('the relaunch command Windows runs at the sign-in', () => {
  it('is the installed executable with --restore-last-session, quoted for its spaces', () => {
    expect(restartCommand(INSTALLED)).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe --restore-last-session'
    )
    expect(
      restartCommand({ ...INSTALLED, execPath: 'C:\\Program Files\\Zenium\\Zenium.exe' })
    ).toBe('"C:\\Program Files\\Zenium\\Zenium.exe" --restore-last-session')
  })

  it('carries the profile a run was given with --user-data-dir, so that profile comes back', () => {
    expect(restartCommand({ ...INSTALLED, userDataDir: SMOKE_PROFILE })).toBe(
      `C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe "--user-data-dir=${SMOKE_PROFILE}" --restore-last-session`
    )
    expect(restartCommand({ ...INSTALLED, userDataDir: 'D:\\profiles\\two' })).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe --user-data-dir=D:\\profiles\\two --restore-last-session'
    )
  })

  it('runs Electron with the app path in development', () => {
    expect(
      restartCommand({
        ...INSTALLED,
        isPackaged: false,
        execPath: 'C:\\dev\\Zenium\\node_modules\\electron\\dist\\electron.exe',
        appPath: 'C:\\dev\\Zenium'
      })
    ).toBe(
      'C:\\dev\\Zenium\\node_modules\\electron\\dist\\electron.exe C:\\dev\\Zenium --restore-last-session'
    )
  })
})

describe('the RunOnce entry', () => {
  it('is named Zenium for the default profile and Zenium.<hash> for another, the same hash for the same path', () => {
    expect(runOnceValueName(null)).toBe('Zenium')
    const named = runOnceValueName(SMOKE_PROFILE)
    expect(named).toMatch(/^Zenium\.[0-9a-f]{8}$/)
    expect(runOnceValueName(SMOKE_PROFILE)).toBe(named)
    // Windows paths compare without case.
    expect(runOnceValueName(SMOKE_PROFILE.toUpperCase())).toBe(named)
    expect(runOnceValueName('D:\\profiles\\two')).not.toBe(named)
  })

  it('is written, read and removed under HKCU\\…\\CurrentVersion\\RunOnce with reg.exe', () => {
    expect(RUN_ONCE_KEY).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce')
    expect(runOnceWrite(INSTALLED)).toEqual({
      file: 'reg.exe',
      args: [
        'add',
        RUN_ONCE_KEY,
        '/v',
        'Zenium',
        '/t',
        'REG_SZ',
        '/d',
        'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe --restore-last-session',
        '/f'
      ]
    })
    expect(runOnceDelete(null)).toEqual({
      file: 'reg.exe',
      args: ['delete', RUN_ONCE_KEY, '/v', 'Zenium', '/f']
    })
    expect(runOnceQuery(SMOKE_PROFILE)).toEqual({
      file: 'reg.exe',
      args: ['query', RUN_ONCE_KEY, '/v', runOnceValueName(SMOKE_PROFILE)]
    })
  })
})

describe('the user’s "restart my apps when I sign back in" toggle', () => {
  it('is read off Winlogon\\RestartApps as reg.exe prints a DWORD', () => {
    expect(RESTART_APPS_QUERY).toEqual({
      file: 'reg.exe',
      args: [
        'query',
        'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon',
        '/v',
        'RestartApps'
      ]
    })
    const listing = (value: string): string =>
      `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\r\n    RestartApps    REG_DWORD    ${value}\r\n\r\n`
    expect(parseRegDword({ ok: true, stdout: listing('0x1') })).toBe(1)
    expect(parseRegDword({ ok: true, stdout: listing('0x0') })).toBe(0)
    expect(parseRegDword({ ok: true, stdout: listing('1') })).toBe(1)
    // Absent (reg.exe fails), or a key listing without the DWORD.
    expect(parseRegDword({ ok: false, stdout: '' })).toBeNull()
    expect(parseRegDword({ ok: true, stdout: '\r\nHKEY_CURRENT_USER\\…\r\n\r\n' })).toBeNull()
  })

  it('is what its value says when set, on either Windows', () => {
    const on = { ok: true, stdout: '    RestartApps    REG_DWORD    0x1\r\n' }
    const off = { ok: true, stdout: '    RestartApps    REG_DWORD    0x0\r\n' }
    expect(restartAppsEnabled(on, WIN10)).toBe(true)
    expect(restartAppsEnabled(off, WIN11)).toBe(false)
  })

  it('defaults to on for Windows 11 and off for Windows 10 when the value is absent', () => {
    const absent = { ok: false, stdout: '' }
    expect(windowsBuild(WIN11)).toBe(22631)
    expect(windowsBuild(WIN10)).toBe(19045)
    expect(windowsBuild('10.0.22000')).toBe(22000)
    expect(windowsBuild('garbage')).toBe(0)
    expect(restartAppsEnabled(absent, WIN11)).toBe(true)
    expect(restartAppsEnabled(absent, '10.0.22000')).toBe(true)
    expect(restartAppsEnabled(absent, '10.0.26100')).toBe(true)
    expect(restartAppsEnabled(absent, WIN10)).toBe(false)
    expect(restartAppsEnabled(absent, 'garbage')).toBe(false)
  })
})

describe('which ends of the session a relaunch follows', () => {
  it('a shutdown or restart, a sign-out, a critical shutdown – not the Restart Manager closing the app alone', () => {
    expect(relaunchAfter(['shutdown'])).toBe(true)
    expect(relaunchAfter(['logoff'])).toBe(true)
    expect(relaunchAfter(['critical', 'shutdown'])).toBe(true)
    expect(relaunchAfter(['critical', 'logoff'])).toBe(true)
    expect(relaunchAfter(['close-app'])).toBe(false)
    expect(relaunchAfter(['close-app', 'critical'])).toBe(false)
    // A synthetic event without reasons reads as a shutdown.
    expect(relaunchAfter(undefined)).toBe(true)
    expect(relaunchAfter([])).toBe(true)
  })
})

describe('windowsRestartRegistration – one run’s registration', () => {
  it('reads the toggle and writes the entry once; later ends of the session find it done', () => {
    const registry = fakeRegistry(1)
    const registration = windowsRestartRegistration(INSTALLED, registry.run)
    expect(registration.registered).toBe(false)
    expect(registration.register(['shutdown'])).toBe('registered')
    expect(registration.registered).toBe(true)
    expect(registry.runOnce.get('Zenium')).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe --restore-last-session'
    )
    // The second and third window's session-end.
    expect(registration.register(['shutdown'])).toBe('registered')
    expect(registration.register(['logoff'])).toBe('registered')
    expect(verbs(registry.ran)).toEqual(['query RestartApps', 'add Zenium'])
    expect(registry.ran).toHaveLength(SESSION_END_REGISTRY_CALLS)
  })

  it('keeps the reg.exe calls inside Windows’ end-of-session budget: two calls, each capped at a second, well under the ~5 s a hung app gets', () => {
    expect(REGISTRY_TIMEOUT_MS).toBe(1_000)
    expect(REGISTRY_SPAWN_OPTIONS).toEqual({
      windowsHide: true,
      timeout: REGISTRY_TIMEOUT_MS,
      encoding: 'utf8'
    })
    // The worst case – every call stuck to its cap – leaves more than half the budget unused.
    expect(REGISTRY_TIMEOUT_MS * SESSION_END_REGISTRY_CALLS).toBeLessThan(
      WINDOWS_END_SESSION_BUDGET_MS / 2
    )
  })

  it('writes nothing with the toggle off, or absent on Windows 10', () => {
    const off = fakeRegistry(0)
    expect(windowsRestartRegistration(INSTALLED, off.run).register(['shutdown'])).toBe('off')
    expect(off.runOnce.size).toBe(0)
    expect(verbs(off.ran)).toEqual(['query RestartApps'])
    const win10 = fakeRegistry(null)
    expect(
      windowsRestartRegistration({ ...INSTALLED, systemVersion: WIN10 }, win10.run).register([
        'shutdown'
      ])
    ).toBe('off')
    expect(win10.runOnce.size).toBe(0)
    // Absent on Windows 11: the OS default is on.
    const win11 = fakeRegistry(null)
    expect(windowsRestartRegistration(INSTALLED, win11.run).register(['shutdown'])).toBe(
      'registered'
    )
    expect(win11.runOnce.has('Zenium')).toBe(true)
  })

  it('skips the Restart Manager closing the app for an installer, reading nothing', () => {
    const registry = fakeRegistry(1)
    const registration = windowsRestartRegistration(INSTALLED, registry.run)
    expect(registration.register(['close-app'])).toBe('skipped')
    expect(registration.registered).toBe(false)
    expect(registry.ran).toEqual([])
    // A later real end of the session still registers.
    expect(registration.register(['shutdown'])).toBe('registered')
  })

  it('reports a refused write and stays unregistered, so the next end of the session tries again', () => {
    const registry = fakeRegistry(1)
    const registration = windowsRestartRegistration(INSTALLED, registry.run)
    registry.refuse = true
    expect(registration.register(['shutdown'])).toBe('failed')
    expect(registration.registered).toBe(false)
    registry.refuse = false
    expect(registration.register(['shutdown'])).toBe('registered')
  })

  it('takes back only an entry this run wrote', () => {
    const registry = fakeRegistry(1)
    // Another profile's entry, and one an earlier run left: not this run's.
    registry.runOnce.set('Zenium.0badf00d', 'C:\\other\\Zenium.exe --restore-last-session')
    const registration = windowsRestartRegistration(INSTALLED, registry.run)
    expect(registration.unregister()).toBe(false)
    expect(registry.ran).toEqual([])
    expect(registration.register(['shutdown'])).toBe('registered')
    expect(registration.unregister()).toBe(true)
    expect(registration.registered).toBe(false)
    expect(registry.runOnce.has('Zenium')).toBe(false)
    expect(registry.runOnce.has('Zenium.0badf00d')).toBe(true)
    expect(verbs(registry.ran)).toEqual(['query RestartApps', 'add Zenium', 'delete Zenium'])
    // Twice takes back nothing more.
    expect(registration.unregister()).toBe(false)
  })

  it('keeps two profiles’ entries apart', () => {
    const registry = fakeRegistry(1)
    const one = windowsRestartRegistration(INSTALLED, registry.run)
    const two = windowsRestartRegistration(
      { ...INSTALLED, userDataDir: SMOKE_PROFILE },
      registry.run
    )
    expect(one.register(['shutdown'])).toBe('registered')
    expect(two.register(['shutdown'])).toBe('registered')
    expect([...registry.runOnce.keys()]).toEqual(['Zenium', runOnceValueName(SMOKE_PROFILE)])
    expect(registry.runOnce.get(runOnceValueName(SMOKE_PROFILE))).toContain(
      `"--user-data-dir=${SMOKE_PROFILE}"`
    )
  })
})

describe('installWindowsRestart – the hook on the app and its windows', () => {
  /** An `app` and its windows as event emitters: `session-end` per window, `will-quit` once. */
  function fakeApp(): { app: SessionEndApp; windows: EventEmitter[]; create: () => EventEmitter } {
    const app = new EventEmitter()
    const windows: EventEmitter[] = []
    const create = (): EventEmitter => {
      const win = new EventEmitter()
      windows.push(win)
      app.emit('browser-window-created', {}, win as unknown as SessionEndWindow)
      return win
    }
    return { app: app as unknown as SessionEndApp, windows, create }
  }

  it('registers on the first window’s session-end, once for every window, and logs what it did', () => {
    const registry = fakeRegistry(1)
    const { app, create } = fakeApp()
    const lines: string[] = []
    const registration = installWindowsRestart(app, INSTALLED, registry.run, (l) => lines.push(l))
    const a = create()
    const b = create()
    a.emit('session-end', { reasons: ['shutdown'] })
    b.emit('session-end', { reasons: ['shutdown'] })
    expect(registration.registered).toBe(true)
    expect(verbs(registry.ran)).toEqual(['query RestartApps', 'add Zenium'])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      'session ending (shutdown): relaunch registered under HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce\\Zenium (C:\\Users\\me\\AppData\\Local\\Programs\\Zenium\\Zenium.exe --restore-last-session)'
    )
  })

  it('a window made later gets the hook too; a sign-out registers as a shutdown does', () => {
    const registry = fakeRegistry(1)
    const { app, create } = fakeApp()
    const registration = installWindowsRestart(app, INSTALLED, registry.run, () => undefined)
    create()
    const later = create()
    later.emit('session-end', { reasons: ['logoff'] })
    expect(registration.registered).toBe(true)
  })

  it('a synthetic session-end without an event registers as a shutdown', () => {
    const registry = fakeRegistry(1)
    const { app, create } = fakeApp()
    const registration = installWindowsRestart(app, INSTALLED, registry.run, () => undefined)
    create().emit('session-end')
    expect(registration.registered).toBe(true)
  })

  it('says why nothing was written: the toggle off, the Restart Manager’s close', () => {
    const registry = fakeRegistry(0)
    const { app, create } = fakeApp()
    const lines: string[] = []
    installWindowsRestart(app, INSTALLED, registry.run, (l) => lines.push(l))
    const win = create()
    win.emit('session-end', { reasons: ['shutdown'] })
    win.emit('session-end', { reasons: ['close-app'] })
    expect(lines).toEqual([
      'session ending (shutdown): not registered – "restart my apps when I sign back in" is off in Windows Settings',
      'session ending (close-app): not registered – no sign-in follows this end of the session'
    ])
    expect(registry.runOnce.size).toBe(0)
  })

  it('a clean quit takes the entry back, and only when one was written', () => {
    const registry = fakeRegistry(1)
    const { app, create } = fakeApp()
    const lines: string[] = []
    const registration = installWindowsRestart(app, INSTALLED, registry.run, (l) => lines.push(l))
    const emitter = app as unknown as EventEmitter
    emitter.emit('will-quit', { preventDefault: () => undefined })
    expect(lines).toEqual([])
    create().emit('session-end', { reasons: ['shutdown'] })
    emitter.emit('will-quit', { preventDefault: () => undefined })
    expect(registration.registered).toBe(false)
    expect(registry.runOnce.size).toBe(0)
    expect(lines.at(-1)).toBe('clean quit: the RunOnce relaunch entry is taken back')
  })
})
