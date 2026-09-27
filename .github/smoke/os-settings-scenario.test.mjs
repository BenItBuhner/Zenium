import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCENT_ROW_LABEL,
  APPEARANCE_GROUP,
  LINUX_DESKTOP_ENV_KEYS,
  MAC_LEGACY_PROXY_PANE,
  MAC_NETWORK_PREF_PANE,
  MAC_PROXY_PANE,
  PROXY_ROW_DESCRIPTION,
  PROXY_ROW_LABEL,
  WINDOWS_PROXY_PAGE,
  accentHex,
  accentRowProblems,
  expectedProxyDoor,
  hostReadsAccent,
  linuxDesktop,
  macAppPattern,
  proxyDoorProblems,
  proxyRowProblems,
  readAccentScript,
  readHostScript,
  readShellOpensScript,
  recordShellOpensScript
} from './os-settings-scenario.mjs'

/** The page's reading of the accent row as the desktop layout draws it (a checkbox in a label). */
const accentRow = (over = {}) => ({
  present: true,
  section: 'look',
  tag: 'label',
  control: 'checkbox',
  checked: false,
  disabled: false,
  label: ACCENT_ROW_LABEL,
  description: null,
  group: APPEARANCE_GROUP,
  ...over
})

/** The page's reading of the proxy row: a pressable row with the resting sentence. */
const proxyRow = (over = {}) => ({
  present: true,
  section: 'system',
  tag: 'button',
  control: null,
  checked: null,
  disabled: false,
  label: PROXY_ROW_LABEL,
  description: PROXY_ROW_DESCRIPTION,
  group: 'system',
  ...over
})

const settled = (result) => ({ at: 0, settled: true, result, error: null, ms: 12 })
const call = (method, target, over = {}) => ({
  method,
  target,
  at: 0,
  settled: true,
  error: null,
  ...over
})

describe('accentHex', () => {
  it('takes Electron’s RRGGBBAA to the core’s #rrggbb, with or without a hash, lower-cased', () => {
    expect(accentHex('FF5500FF')).toBe('#ff5500')
    expect(accentHex('#0A84FF')).toBe('#0a84ff')
    expect(accentHex('0a84ff')).toBe('#0a84ff')
  })
  it('reads nothing into what is not a colour – Linux’s empty string included', () => {
    expect(accentHex('')).toBeNull()
    expect(accentHex('blue')).toBeNull()
    expect(accentHex('12345')).toBeNull()
    expect(accentHex(0x0a84ff)).toBeNull()
    expect(accentHex(null)).toBeNull()
  })
})

describe('hostReadsAccent', () => {
  it('is Windows and macOS', () => {
    expect(hostReadsAccent('win32')).toBe(true)
    expect(hostReadsAccent('darwin')).toBe(true)
    expect(hostReadsAccent('linux')).toBe(false)
  })
})

describe('linuxDesktop', () => {
  it('reads XDG_CURRENT_DESKTOP’s values in order, as Chromium does', () => {
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('gnome')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' })).toBe('kde6')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '5' })).toBe('kde5')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('kde4')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'Unity' })).toBe('unity')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'Unity', DESKTOP_SESSION: 'gnome-fallback' })).toBe(
      'gnome'
    )
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'XFCE' })).toBe('xfce')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'LXQt' })).toBe('lxqt')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' })).toBe('cinnamon')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'COSMIC' })).toBe('cosmic')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'Pantheon' })).toBe('pantheon')
  })
  it('falls back to DESKTOP_SESSION and the session markers', () => {
    expect(linuxDesktop({ DESKTOP_SESSION: 'mate' })).toBe('gnome')
    expect(linuxDesktop({ DESKTOP_SESSION: 'kde-plasma' })).toBe('kde4')
    expect(linuxDesktop({ DESKTOP_SESSION: 'kde' })).toBe('kde3')
    expect(linuxDesktop({ DESKTOP_SESSION: 'kde', KDE_SESSION_VERSION: '4' })).toBe('kde4')
    expect(linuxDesktop({ DESKTOP_SESSION: 'xubuntu' })).toBe('xfce')
    expect(linuxDesktop({ DESKTOP_SESSION: 'ukui' })).toBe('ukui')
    expect(linuxDesktop({ DESKTOP_SESSION: 'deepin' })).toBe('deepin')
    expect(linuxDesktop({ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' })).toBe('gnome')
    expect(linuxDesktop({ KDE_FULL_SESSION: 'true' })).toBe('kde3')
    expect(linuxDesktop({ KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '4' })).toBe('kde4')
  })
  it('is `other` for a runner’s shell with none of them set', () => {
    expect(linuxDesktop({})).toBe('other')
    expect(linuxDesktop({ XDG_CURRENT_DESKTOP: 'Weston' })).toBe('other')
  })
})

describe('expectedProxyDoor', () => {
  it('is Windows’ Proxy page through openExternal', () => {
    expect(expectedProxyDoor({ platform: 'win32', osRelease: '10.0.26100' })).toEqual({
      door: 'opened',
      url: WINDOWS_PROXY_PAGE,
      fallback: null,
      desktop: null
    })
  })
  it('is the System Settings extension’s URL from Ventura on, with the Network pane as the fallback', () => {
    const sequoia = expectedProxyDoor({ platform: 'darwin', osRelease: '24.1.0' })
    expect(sequoia).toEqual({
      door: 'opened',
      url: MAC_PROXY_PANE,
      fallback: MAC_NETWORK_PREF_PANE,
      desktop: null
    })
    expect(expectedProxyDoor({ platform: 'darwin', osRelease: '22.0.0' }).url).toBe(MAC_PROXY_PANE)
  })
  it('is System Preferences’ URL on macOS 11 and 12', () => {
    expect(expectedProxyDoor({ platform: 'darwin', osRelease: '21.6.0' }).url).toBe(
      MAC_LEGACY_PROXY_PANE
    )
  })
  it('is unsupported with no shell call on a Linux host with no desktop named, or one with no tool', () => {
    expect(expectedProxyDoor({ platform: 'linux', env: {} })).toEqual({
      door: 'unsupported',
      url: null,
      fallback: null,
      desktop: 'other'
    })
    expect(
      expectedProxyDoor({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'XFCE' } })
    ).toMatchObject({ door: 'unsupported', desktop: 'xfce' })
  })
  it('is either answer on a Linux desktop the table has a tool for', () => {
    expect(
      expectedProxyDoor({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' } })
    ).toMatchObject({ door: 'either', desktop: 'gnome' })
  })
  it('is unsupported anywhere else', () => {
    expect(expectedProxyDoor({ platform: 'freebsd' }).door).toBe('unsupported')
  })
})

describe('accentRowProblems', () => {
  const windows = {
    platform: 'win32',
    raw: 'ff5500ff',
    coreAccent: '#ff5500',
    useSystemAccent: false,
    row: accentRow()
  }
  it('passes Windows and macOS with the OS’s colour held by the core and the row off on a fresh profile', () => {
    expect(accentRowProblems(windows)).toEqual([])
    expect(
      accentRowProblems({
        platform: 'darwin',
        raw: '0A84FFFF',
        coreAccent: '#0a84ff',
        useSystemAccent: true,
        row: accentRow({ control: 'switch', checked: true })
      })
    ).toEqual([])
  })
  it('names a missing row', () => {
    const problems = accentRowProblems({
      ...windows,
      row: { present: false, section: 'look', rows: [] }
    })
    expect(problems).toEqual(['no use-system-accent row on the look section'])
  })
  it('names an OS that gave no colour, and the core disagreeing with the OS', () => {
    expect(accentRowProblems({ ...windows, raw: '' })).toEqual([
      'the OS gave no colour: getAccentColor() read ""',
      'the core holds systemAccent "#ff5500", the OS reads null'
    ])
    expect(accentRowProblems({ ...windows, coreAccent: '#000000' })).toEqual([
      'the core holds systemAccent "#000000", the OS reads #ff5500'
    ])
    expect(accentRowProblems({ ...windows, coreAccent: null })).toEqual([
      'the core holds systemAccent null, the OS reads #ff5500'
    ])
  })
  it('names a row that is not a boolean control, reads the wrong state, is disabled, mislabelled or misplaced', () => {
    expect(
      accentRowProblems({ ...windows, row: accentRow({ control: null, checked: null }) })
    ).toEqual(['the row has no boolean control (none)'])
    expect(accentRowProblems({ ...windows, row: accentRow({ checked: true }) })).toEqual([
      'the row reads true, the setting is false'
    ])
    expect(accentRowProblems({ ...windows, row: accentRow({ disabled: true }) })).toEqual([
      'the row is disabled'
    ])
    expect(accentRowProblems({ ...windows, row: accentRow({ label: 'Use accent' }) })).toEqual([
      'the row reads "Use accent"'
    ])
    expect(accentRowProblems({ ...windows, row: accentRow({ group: 'theme' }) })).toEqual([
      'the row is in the theme group, not appearance'
    ])
  })
  it('passes Linux with no row and the core holding null, whatever the method returned', () => {
    const linux = { platform: 'linux', raw: '', coreAccent: null, useSystemAccent: false }
    expect(
      accentRowProblems({ ...linux, row: { present: false, section: 'look', rows: [] } })
    ).toEqual([])
    expect(accentRowProblems({ ...linux, raw: 'ff5500ff', row: { present: false } })).toEqual([])
    expect(accentRowProblems({ ...linux, raw: null, row: { present: false } })).toEqual([])
  })
  it('names a row or an accent on Linux', () => {
    const linux = { platform: 'linux', raw: '', coreAccent: null, useSystemAccent: false }
    expect(accentRowProblems({ ...linux, row: accentRow() })).toEqual([
      'a use-system-accent row on linux, which reads no accent'
    ])
    expect(accentRowProblems({ ...linux, coreAccent: '#ff5500', row: { present: false } })).toEqual(
      ['the core holds systemAccent "#ff5500" on linux']
    )
  })
})

describe('proxyRowProblems', () => {
  it('passes the row as the System section shows it', () => {
    expect(proxyRowProblems(proxyRow())).toEqual([])
  })
  it('names a missing, held or reworded row', () => {
    expect(proxyRowProblems({ present: false, section: 'system', rows: [] })).toEqual([
      'no proxy-settings row on the system section'
    ])
    expect(
      proxyRowProblems(proxyRow({ disabled: true, description: 'Using a PAC script.' }))
    ).toEqual(['the row\'s description reads "Using a PAC script."', 'the row is disabled'])
    expect(proxyRowProblems(proxyRow({ label: 'Proxy' }))).toEqual(['the row reads "Proxy"'])
  })
})

describe('proxyDoorProblems', () => {
  const windows = expectedProxyDoor({ platform: 'win32' })
  const mac = expectedProxyDoor({ platform: 'darwin', osRelease: '24.0.0' })
  const runner = expectedProxyDoor({ platform: 'linux', env: {} })
  const gnome = expectedProxyDoor({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'GNOME' } })

  it('passes opened with the one expected URL taken', () => {
    expect(
      proxyDoorProblems({
        result: settled('opened'),
        calls: [call('openExternal', WINDOWS_PROXY_PAGE)],
        expected: windows
      })
    ).toEqual([])
    expect(
      proxyDoorProblems({
        result: settled('opened'),
        calls: [call('openExternal', MAC_PROXY_PANE)],
        expected: mac
      })
    ).toEqual([])
  })
  it('names a command that did not settle or rejected', () => {
    expect(proxyDoorProblems({ result: { settled: false }, calls: [], expected: windows })).toEqual(
      ['system.openProxySettings did not settle']
    )
    expect(proxyDoorProblems({ result: null, calls: [], expected: windows })).toEqual([
      'system.openProxySettings did not settle'
    ])
    expect(
      proxyDoorProblems({
        result: { settled: true, result: undefined, error: 'no handler' },
        calls: [],
        expected: windows
      })
    ).toEqual(['system.openProxySettings rejected: no handler'])
  })
  it('names the wrong answer and the wrong or missing shell call', () => {
    expect(
      proxyDoorProblems({ result: settled('unsupported'), calls: [], expected: windows })
    ).toEqual([
      'the door answered "unsupported", expected opened',
      '0 shell.openExternal call(s), expected one: none'
    ])
    expect(
      proxyDoorProblems({
        result: settled('opened'),
        calls: [call('openExternal', 'ms-settings:defaultapps')],
        expected: windows
      })
    ).toEqual([
      'shell.openExternal was handed ms-settings:defaultapps, expected ms-settings:network-proxy'
    ])
    expect(
      proxyDoorProblems({
        result: settled('opened'),
        calls: [call('openExternal', WINDOWS_PROXY_PAGE), call('openExternal', WINDOWS_PROXY_PAGE)],
        expected: windows
      })
    ).toEqual([
      '2 shell.openExternal call(s), expected one: ms-settings:network-proxy, ms-settings:network-proxy'
    ])
    expect(
      proxyDoorProblems({
        result: settled('opened'),
        calls: [call('openExternal', WINDOWS_PROXY_PAGE, { settled: false })],
        expected: windows
      })
    ).toEqual(['shell.openExternal(ms-settings:network-proxy) has not settled'])
  })
  it('names a URL the OS refused where there is no fallback', () => {
    expect(
      proxyDoorProblems({
        result: settled('unsupported'),
        calls: [call('openExternal', WINDOWS_PROXY_PAGE, { error: 'Failed to open path' })],
        expected: windows
      })
    ).toEqual([
      'the door answered "unsupported", expected opened',
      'the OS refused ms-settings:network-proxy: Failed to open path'
    ])
  })
  it('allows macOS its Network pane when the URL was refused, and names a fallback that was not taken', () => {
    const refused = call('openExternal', MAC_PROXY_PANE, { error: 'refused' })
    expect(
      proxyDoorProblems({
        result: settled('opened'),
        calls: [refused, call('openPath', MAC_NETWORK_PREF_PANE)],
        expected: mac
      })
    ).toEqual([])
    expect(
      proxyDoorProblems({ result: settled('unsupported'), calls: [refused], expected: mac })
    ).toEqual([
      'the door answered "unsupported", expected opened',
      `the OS refused ${MAC_PROXY_PANE} (refused) and the door did not fall back to ${MAC_NETWORK_PREF_PANE} (openPath: none)`
    ])
    expect(
      proxyDoorProblems({
        result: settled('unsupported'),
        calls: [refused, call('openPath', MAC_NETWORK_PREF_PANE, { error: 'no such pane' })],
        expected: mac
      })
    ).toEqual([
      'the door answered "unsupported", expected opened',
      `the OS refused ${MAC_NETWORK_PREF_PANE} too: no such pane`
    ])
  })
  it('names an openPath the door had no reason for', () => {
    expect(
      proxyDoorProblems({
        result: settled('opened'),
        calls: [call('openExternal', MAC_PROXY_PANE), call('openPath', MAC_NETWORK_PREF_PANE)],
        expected: mac
      })
    ).toEqual([`shell.openPath called though the URL was taken: ${MAC_NETWORK_PREF_PANE}`])
  })
  it('passes unsupported with no shell call on a runner with no desktop named, and names a call or an open', () => {
    expect(
      proxyDoorProblems({ result: settled('unsupported'), calls: [], expected: runner })
    ).toEqual([])
    expect(
      proxyDoorProblems({
        result: settled('unsupported'),
        calls: [call('openExternal', 'x-apple.systempreferences:')],
        expected: runner
      })
    ).toEqual(['1 shell call(s) on an unsupported host: openExternal(x-apple.systempreferences:)'])
    expect(proxyDoorProblems({ result: settled('opened'), calls: [], expected: runner })).toEqual([
      'the door answered "opened", expected unsupported'
    ])
  })
  it('takes either answer on a desktop with a tool, and names anything else', () => {
    expect(proxyDoorProblems({ result: settled('opened'), calls: [], expected: gnome })).toEqual([])
    expect(
      proxyDoorProblems({ result: settled('unsupported'), calls: [], expected: gnome })
    ).toEqual([])
    expect(proxyDoorProblems({ result: settled('later'), calls: [], expected: gnome })).toEqual([
      'the door answered "later"'
    ])
  })
})

describe('readAccentScript', () => {
  it('reads the raw colour, or the throw, or that the method is not there', () => {
    expect(readAccentScript({ systemPreferences: { getAccentColor: () => 'ff5500ff' } })).toEqual({
      platform: process.platform,
      hasMethod: true,
      raw: 'ff5500ff',
      error: null
    })
    expect(
      readAccentScript({
        systemPreferences: {
          getAccentColor: () => {
            throw new Error('not on this OS')
          }
        }
      })
    ).toMatchObject({ hasMethod: true, raw: null, error: 'not on this OS' })
    expect(readAccentScript({ systemPreferences: {} })).toMatchObject({
      hasMethod: false,
      raw: null
    })
    expect(readAccentScript({})).toMatchObject({ hasMethod: false })
  })
})

describe('readHostScript', () => {
  const saved = {}
  afterEach(() => {
    for (const key of LINUX_DESKTOP_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  it('reads the platform and the desktop keys that are set, and no other', () => {
    for (const key of LINUX_DESKTOP_ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.XDG_CURRENT_DESKTOP = 'ubuntu:GNOME'
    process.env.DESKTOP_SESSION = 'ubuntu'
    expect(readHostScript({}, LINUX_DESKTOP_ENV_KEYS)).toEqual({
      platform: process.platform,
      env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', DESKTOP_SESSION: 'ubuntu' }
    })
  })
})

describe('recordShellOpensScript', () => {
  afterEach(() => {
    delete globalThis.__smokeShellOpens
  })
  const shell = (over = {}) => ({
    openExternal: async () => undefined,
    openPath: async () => '',
    ...over
  })

  it('wraps both methods, records each call with the OS’s answer and lets it through', async () => {
    const seen = []
    const sh = shell({
      openExternal: async (url, options) => {
        seen.push(['openExternal', url, options])
      },
      openPath: async (p) => {
        seen.push(['openPath', p])
        return ''
      }
    })
    expect(recordShellOpensScript({ shell: sh })).toEqual({
      installed: { openExternal: true, openPath: true },
      calls: 0
    })
    await sh.openExternal('ms-settings:network-proxy', { activate: true })
    await sh.openPath('/System/Library/PreferencePanes/Network.prefPane')
    expect(seen).toEqual([
      ['openExternal', 'ms-settings:network-proxy', { activate: true }],
      ['openPath', '/System/Library/PreferencePanes/Network.prefPane']
    ])
    expect(readShellOpensScript()).toMatchObject([
      { method: 'openExternal', target: 'ms-settings:network-proxy', settled: true, error: null },
      {
        method: 'openPath',
        target: '/System/Library/PreferencePanes/Network.prefPane',
        settled: true,
        error: null
      }
    ])
  })
  it('keeps a rejection as the call’s error and still rejects the caller', async () => {
    const sh = shell({
      openExternal: async () => {
        throw new Error('Failed to open path')
      },
      openPath: async () => 'No application knows how to open it.'
    })
    recordShellOpensScript({ shell: sh })
    await expect(sh.openExternal('x-apple.systempreferences:nowhere')).rejects.toThrow(
      'Failed to open path'
    )
    expect(await sh.openPath('/nowhere.prefPane')).toBe('No application knows how to open it.')
    expect(readShellOpensScript()).toMatchObject([
      { method: 'openExternal', settled: true, error: 'Failed to open path' },
      { method: 'openPath', settled: true, error: 'No application knows how to open it.' }
    ])
  })
  it('installs once: a second install reports the record so far', async () => {
    const sh = shell()
    recordShellOpensScript({ shell: sh })
    await sh.openExternal('ms-settings:network-proxy')
    expect(recordShellOpensScript({ shell: sh })).toEqual({
      installed: { openExternal: true, openPath: true },
      calls: 1
    })
    expect(readShellOpensScript()).toHaveLength(1)
  })
  it('says which method it could not wrap', () => {
    expect(recordShellOpensScript({ shell: { openExternal: async () => undefined } })).toEqual({
      installed: { openExternal: true, openPath: false },
      calls: 0
    })
  })
  it('reads no calls before the wrapper is in', () => {
    expect(readShellOpensScript()).toEqual([])
  })
})

describe('macAppPattern', () => {
  it('finds the app by its executable inside the bundle, past pgrep’s 16-character name', () => {
    expect(macAppPattern('System Preferences')).toBe('MacOS/System Preferences')
    expect(
      new RegExp(macAppPattern('System Settings')).test(
        '/System/Applications/System Settings.app/Contents/MacOS/System Settings'
      )
    ).toBe(true)
  })
})
