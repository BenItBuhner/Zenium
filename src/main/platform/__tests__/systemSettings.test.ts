import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Settings › System › "Open your computer's proxy settings" – the desktop host's door, per OS as
 * Chrome's `settings_utils::ShowNetworkProxySettings` opens it: the Windows Settings page, the
 * macOS Network › Proxies pane, the Linux desktop's own network settings tool found by Chrome's
 * table of desktops – or `unsupported`, where Chrome shows its help page, for the page's sentence.
 */

const fake = vi.hoisted(() => ({
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  openPath: vi.fn<(path: string) => Promise<string>>(),
  release: vi.fn<() => string>(),
  /** The executables on the fake PATH, by full path. */
  executables: new Set<string>(),
  /** Each `spawn`: the file, its arguments, its options. */
  spawns: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  /** The files whose spawn fails with an `error` event (ENOENT, EACCES). */
  failing: new Set<string>(),
  /** Whether the last spawned child was `unref`ed. */
  unrefs: [] as string[]
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => fake.openExternal(url),
    openPath: (path: string) => fake.openPath(path)
  }
}))

vi.mock('node:os', () => ({ release: () => fake.release() }))

vi.mock('node:fs/promises', () => ({
  constants: { X_OK: 1 },
  access: async (path: string) => {
    if (!fake.executables.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
}))

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], options: Record<string, unknown>) => {
    fake.spawns.push({ file, args, options })
    const child = new EventEmitter() as EventEmitter & { unref(): void }
    child.unref = () => {
      fake.unrefs.push(file)
    }
    queueMicrotask(() => {
      if (fake.failing.has(file)) child.emit('error', new Error(`spawn ${file} ENOENT`))
      else child.emit('spawn')
    })
    return child
  }
}))

import {
  LINUX_PROXY_COMMANDS,
  MAC_LEGACY_PROXY_PANE,
  MAC_NETWORK_PREF_PANE,
  MAC_PROXY_PANE,
  WINDOWS_PROXY_PAGE,
  linuxDesktop,
  openProxySettings
} from '../systemSettings'

function onPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true })
}

/** A PATH of two directories with these executables in the first. */
function pathWith(...files: string[]): NodeJS.ProcessEnv {
  for (const file of files) fake.executables.add(`/usr/bin/${file}`)
  return { PATH: '/usr/bin:/usr/local/bin' }
}

let restore: () => void = () => undefined
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

afterEach(() => {
  restore()
  fake.executables.clear()
  fake.failing.clear()
  fake.spawns.length = 0
  fake.unrefs.length = 0
  vi.clearAllMocks()
})

describe('the proxy settings door on Windows', () => {
  beforeEach(() => {
    restore = onPlatform('win32')
  })

  it('opens the Settings app’s Proxy page, ms-settings:network-proxy, as Chrome does (settings_utils_win.cc)', async () => {
    fake.openExternal.mockResolvedValue(undefined)
    expect(await openProxySettings({})).toBe('opened')
    expect(fake.openExternal.mock.calls).toEqual([[WINDOWS_PROXY_PAGE]])
    expect(fake.openPath).not.toHaveBeenCalled()
    expect(fake.spawns).toEqual([])
  })

  it('answers unsupported, with one warning, when the shell refuses the page', async () => {
    fake.openExternal.mockRejectedValue(new Error('no handler'))
    expect(await openProxySettings({})).toBe('unsupported')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(WINDOWS_PROXY_PAGE)
  })
})

describe('the proxy settings door on macOS', () => {
  beforeEach(() => {
    restore = onPlatform('darwin')
  })

  it('opens System Settings › Network › Proxies through the Network extension’s URL on Ventura and later (Darwin 22+; base/mac/mac_util.mm kNetwork_Proxies)', async () => {
    fake.release.mockReturnValue('23.4.0')
    fake.openExternal.mockResolvedValue(undefined)
    expect(await openProxySettings({})).toBe('opened')
    expect(fake.openExternal.mock.calls).toEqual([[MAC_PROXY_PANE]])
    expect(MAC_PROXY_PANE).toBe(
      'x-apple.systempreferences:com.apple.Network-Settings.extension?Proxies'
    )
    expect(fake.openPath).not.toHaveBeenCalled()
  })

  it('opens System Preferences’ Network pane at Proxies through the older URL on macOS 11 and 12 (Darwin 20, 21)', async () => {
    fake.openExternal.mockResolvedValue(undefined)
    for (const darwin of ['20.6.0', '21.6.0']) {
      fake.release.mockReturnValue(darwin)
      expect(await openProxySettings({}), darwin).toBe('opened')
    }
    expect(fake.openExternal.mock.calls).toEqual([[MAC_LEGACY_PROXY_PANE], [MAC_LEGACY_PROXY_PANE]])
  })

  it('falls back to the Network preference pane itself when the URL is refused, and answers unsupported when that is refused too', async () => {
    fake.release.mockReturnValue('24.0.0')
    fake.openExternal.mockRejectedValue(new Error('refused'))
    fake.openPath.mockResolvedValue('')
    expect(await openProxySettings({})).toBe('opened')
    expect(fake.openPath.mock.calls).toEqual([[MAC_NETWORK_PREF_PANE]])
    // `openPath` answers with the error message when it could not.
    fake.openPath.mockResolvedValue('The file does not exist.')
    expect(await openProxySettings({})).toBe('unsupported')
    // One warning per refusal: the URL's twice, the pane's once.
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.at(-1)![0]).toBe(
      `[zen] proxy settings: could not open ${MAC_NETWORK_PREF_PANE}: The file does not exist.`
    )
  })
})

describe('the proxy settings door on Linux', () => {
  beforeEach(() => {
    restore = onPlatform('linux')
  })

  it('reads the desktop as Chromium’s base::nix::GetDesktopEnvironment does: XDG_CURRENT_DESKTOP’s values in order, then DESKTOP_SESSION, then the GNOME and KDE session markers', () => {
    const table: Array<[NodeJS.ProcessEnv, ReturnType<typeof linuxDesktop>]> = [
      [{ XDG_CURRENT_DESKTOP: 'GNOME' }, 'gnome'],
      [{ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, 'gnome'],
      [{ XDG_CURRENT_DESKTOP: 'Unity' }, 'unity'],
      [{ XDG_CURRENT_DESKTOP: 'Unity', DESKTOP_SESSION: 'gnome-fallback-compiz' }, 'gnome'],
      [{ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, 'cinnamon'],
      [{ XDG_CURRENT_DESKTOP: 'KDE' }, 'kde4'],
      [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '5' }, 'kde5'],
      [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }, 'kde6'],
      [{ XDG_CURRENT_DESKTOP: 'Deepin' }, 'deepin'],
      [{ XDG_CURRENT_DESKTOP: 'Pantheon' }, 'pantheon'],
      [{ XDG_CURRENT_DESKTOP: 'XFCE' }, 'xfce'],
      [{ XDG_CURRENT_DESKTOP: 'UKUI' }, 'ukui'],
      [{ XDG_CURRENT_DESKTOP: 'LXQt' }, 'lxqt'],
      [{ XDG_CURRENT_DESKTOP: 'COSMIC' }, 'cosmic'],
      // A value the list does not know falls through to the older variables.
      [{ XDG_CURRENT_DESKTOP: 'Hyprland', DESKTOP_SESSION: 'gnome' }, 'gnome'],
      [{ DESKTOP_SESSION: 'deepin' }, 'deepin'],
      [{ DESKTOP_SESSION: 'mate' }, 'gnome'],
      [{ DESKTOP_SESSION: 'kde-plasma' }, 'kde4'],
      [{ DESKTOP_SESSION: 'kde' }, 'kde3'],
      [{ DESKTOP_SESSION: 'kde', KDE_SESSION_VERSION: '5' }, 'kde4'],
      [{ DESKTOP_SESSION: 'xfce4' }, 'xfce'],
      [{ DESKTOP_SESSION: 'xubuntu' }, 'xfce'],
      [{ DESKTOP_SESSION: 'ukui' }, 'ukui'],
      [{ DESKTOP_SESSION: 'default', GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' }, 'gnome'],
      [{ KDE_FULL_SESSION: 'true' }, 'kde3'],
      [{ KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '4' }, 'kde4'],
      // Xvfb on the VM: nothing set.
      [{}, 'other'],
      [{ XDG_CURRENT_DESKTOP: '' }, 'other']
    ]
    for (const [env, desktop] of table) expect(linuxDesktop(env), JSON.stringify(env)).toBe(desktop)
  })

  it('launches the desktop’s tool from Chrome’s table – detached, no stdio, unreferenced, an argument list – and answers opened', async () => {
    const cases: Array<[NodeJS.ProcessEnv, string, string[]]> = [
      [{ XDG_CURRENT_DESKTOP: 'GNOME' }, 'gnome-network-properties', []],
      [{ XDG_CURRENT_DESKTOP: 'Unity' }, 'gnome-network-properties', []],
      [{ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, 'cinnamon-settings', ['network']],
      [{ XDG_CURRENT_DESKTOP: 'KDE' }, 'kcmshell4', ['proxy']],
      [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '5' }, 'kcmshell5', ['proxy']],
      [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }, 'kcmshell6', ['kcm_proxy']],
      [{ DESKTOP_SESSION: 'kde' }, 'kcmshell', ['proxy']],
      [{ XDG_CURRENT_DESKTOP: 'Deepin' }, 'dde-control-center', ['-m', 'network']],
      [{ XDG_CURRENT_DESKTOP: 'COSMIC' }, 'cosmic-settings', ['network']]
    ]
    for (const [env, file, args] of cases) {
      fake.spawns.length = 0
      fake.unrefs.length = 0
      fake.executables.clear()
      expect(await openProxySettings({ ...env, ...pathWith(file) }), file).toBe('opened')
      expect(fake.spawns).toEqual([{ file, args, options: { detached: true, stdio: 'ignore' } }])
      expect(fake.unrefs).toEqual([file])
    }
    expect(fake.openExternal).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('tries GNOME 3’s control centre when GNOME 2’s tool is not on the PATH (Chrome’s order), for GNOME, Pantheon, UKUI and Unity alike', async () => {
    for (const desktop of ['GNOME', 'Pantheon', 'UKUI', 'Unity']) {
      fake.spawns.length = 0
      fake.executables.clear()
      const env = { XDG_CURRENT_DESKTOP: desktop, ...pathWith('gnome-control-center') }
      expect(await openProxySettings(env), desktop).toBe('opened')
      expect(fake.spawns).toEqual([
        {
          file: 'gnome-control-center',
          args: ['network'],
          options: { detached: true, stdio: 'ignore' }
        }
      ])
    }
    expect(LINUX_PROXY_COMMANDS.gnome).toEqual([
      ['gnome-network-properties'],
      ['gnome-control-center', 'network']
    ])
  })

  it('answers unsupported for a desktop outside Chrome’s table (XFCE, LXQt, none – Xvfb), launching nothing and warning only for a desktop it knows', async () => {
    for (const env of [{ XDG_CURRENT_DESKTOP: 'XFCE' }, { XDG_CURRENT_DESKTOP: 'LXQt' }, {}]) {
      expect(await openProxySettings({ ...env, ...pathWith('gnome-control-center') })).toBe(
        'unsupported'
      )
    }
    expect(fake.spawns).toEqual([])
    expect(fake.openExternal).not.toHaveBeenCalled()
    // Chrome logs "Could not find <desktop> network settings in $PATH" for a named desktop and
    // nothing for none; XFCE and LXQt are named.
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      '[zen] proxy settings: could not find xfce network settings in $PATH',
      '[zen] proxy settings: could not find lxqt network settings in $PATH'
    ])
  })

  it('answers unsupported when the desktop’s tool is not on the PATH, or fails to start, spawning nothing through a shell', async () => {
    // KDE 5 without kcmshell5 anywhere on the PATH.
    expect(
      await openProxySettings({
        XDG_CURRENT_DESKTOP: 'KDE',
        KDE_SESSION_VERSION: '5',
        PATH: '/usr/bin'
      })
    ).toBe('unsupported')
    expect(fake.spawns).toEqual([])
    expect(warn).toHaveBeenLastCalledWith(
      '[zen] proxy settings: could not find kde5 network settings in $PATH'
    )
    // The tool is there but the spawn fails: the failure is the answer, warned once.
    fake.failing.add('cinnamon-settings')
    expect(
      await openProxySettings({
        XDG_CURRENT_DESKTOP: 'X-Cinnamon',
        ...pathWith('cinnamon-settings')
      })
    ).toBe('unsupported')
    expect(fake.spawns.map((s) => s.file)).toEqual(['cinnamon-settings'])
    expect(fake.unrefs).toEqual([])
    expect(warn.mock.calls.at(-2)![0]).toBe(
      '[zen] proxy settings: could not start cinnamon-settings:'
    )
    // No PATH at all: nothing to search.
    expect(await openProxySettings({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('unsupported')
    expect(fake.spawns).toHaveLength(1)
  })
})

describe('the proxy settings door elsewhere', () => {
  it('answers unsupported on a platform without one', async () => {
    restore = onPlatform('freebsd')
    expect(await openProxySettings({ XDG_CURRENT_DESKTOP: 'GNOME', PATH: '/usr/bin' })).toBe(
      'unsupported'
    )
    expect(fake.spawns).toEqual([])
    expect(fake.openExternal).not.toHaveBeenCalled()
  })
})
