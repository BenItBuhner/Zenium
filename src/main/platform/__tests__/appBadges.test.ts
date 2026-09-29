import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBadge } from '../../../shared/appBadge'
import type { AppBadgeListener } from '../../../core/webapp'

/*
 * The desktop's drawing of installed apps' badges (MW-51): on Windows each of the app's windows
 * gets the badge as an overlay on its own taskbar button, with the accessible description, and
 * loses it with the badge; a window of the app that opens later gets it as it shows; every
 * change is handed to the dock arbiter on every platform, and nothing else is drawn off Windows.
 */

const appEvents = new EventEmitter()
vi.mock('electron', () => ({
  app: appEvents,
  BrowserWindow: class {},
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => ({ png: buffer })
  }
}))

const { ElectronAppBadges } = await import('../appBadges')

class FakeBrowserWindow extends EventEmitter {
  readonly setOverlayIcon = vi.fn()
}

interface FakeWindow {
  app: { appId: string | null } | null
  host: { alive: boolean; win: FakeBrowserWindow }
}

function fakeWindow(appId: string | null, alive = true): FakeWindow {
  return { app: appId === null ? null : { appId }, host: { alive, win: new FakeBrowserWindow() } }
}

interface Fixture {
  windows: FakeWindow[]
  badges: Map<string, AppBadge>
  set: (appId: string, badge: AppBadge | null) => void
  dock: { setApp: ReturnType<typeof vi.fn> }
  host: InstanceType<typeof ElectronAppBadges>
}

function fixture(platform: NodeJS.Platform, windows: FakeWindow[]): Fixture {
  const badges = new Map<string, AppBadge>()
  let listener: AppBadgeListener | null = null
  const browser = {
    allWindows: () => windows,
    webApps: {
      badgeOf: (appId: string) => badges.get(appId) ?? null,
      onBadgeChange: (l: AppBadgeListener) => {
        listener = l
        return () => {
          listener = null
        }
      }
    }
  }
  const dock = { setApp: vi.fn() }
  const host = new ElectronAppBadges(browser as never, dock as never, () => platform)
  return {
    windows,
    badges,
    dock,
    host,
    set: (appId, badge) => {
      if (badge) badges.set(appId, badge)
      else badges.delete(appId)
      listener?.(appId, badge)
    }
  }
}

const count = (value: number): AppBadge => ({ kind: 'count', value })
const FLAG: AppBadge = { kind: 'flag' }

/** The overlay calls a window's button saw: the PNG's presence and the description. */
const overlays = (win: FakeWindow): Array<[boolean, string]> =>
  win.host.win.setOverlayIcon.mock.calls.map((c) => [
    Boolean((c[0] as { png?: Buffer } | null)?.png),
    c[1] as string
  ])

describe('ElectronAppBadges', () => {
  beforeEach(() => appEvents.removeAllListeners())

  it('on Windows puts the badge on each of the app’s windows’ buttons with its description, and clears it with the badge', () => {
    const browserWin = fakeWindow(null)
    const first = fakeWindow('app-a')
    const second = fakeWindow('app-a')
    const other = fakeWindow('app-b')
    const f = fixture('win32', [browserWin, first, second, other])
    f.set('app-a', count(3))
    expect(overlays(first)).toEqual([[true, '3 unread notifications']])
    expect(overlays(second)).toEqual([[true, '3 unread notifications']])
    expect(overlays(browserWin)).toEqual([])
    expect(overlays(other)).toEqual([])
    // The same label again is not redrawn; a change is.
    f.set('app-a', count(3))
    expect(overlays(first)).toHaveLength(1)
    f.set('app-a', count(1))
    f.set('app-a', count(100))
    f.set('app-a', FLAG)
    expect(overlays(first).map((o) => o[1])).toEqual([
      '3 unread notifications',
      '1 unread notification',
      'More than 99 unread notifications',
      'Unread notifications'
    ])
    // Cleared: the overlay comes off, with no description.
    f.set('app-a', null)
    expect(overlays(first).at(-1)).toEqual([false, ''])
    expect(overlays(second).at(-1)).toEqual([false, ''])
    // Every change went to the dock arbiter as well.
    expect(f.dock.setApp.mock.calls).toEqual([
      ['app-a', count(3)],
      ['app-a', count(3)],
      ['app-a', count(1)],
      ['app-a', count(100)],
      ['app-a', FLAG],
      ['app-a', null]
    ])
  })

  it('draws one image per label and reuses it across windows and changes', () => {
    const first = fakeWindow('app-a')
    const second = fakeWindow('app-a')
    const f = fixture('win32', [first, second])
    f.set('app-a', count(2))
    f.set('app-a', count(5))
    f.set('app-a', count(2))
    const images = (win: FakeWindow): unknown[] =>
      win.host.win.setOverlayIcon.mock.calls.map((c) => c[0])
    expect(images(first)[0]).toBe(images(second)[0])
    expect(images(first)[0]).toBe(images(first)[2])
    expect(images(first)[0]).not.toBe(images(first)[1])
  })

  it('gives a window of a badged app that opens later its overlay as it shows, and skips a dead one', () => {
    const first = fakeWindow('app-a')
    const f = fixture('win32', [first])
    f.set('app-a', count(7))
    const late = fakeWindow('app-a')
    f.windows.push(late)
    appEvents.emit('browser-window-created', {}, late.host.win)
    expect(overlays(late)).toEqual([])
    late.host.win.emit('show')
    expect(overlays(late)).toEqual([[true, '7 unread notifications']])
    // A window whose host is gone is left alone.
    const dead = fakeWindow('app-a', false)
    f.windows.push(dead)
    f.set('app-a', count(8))
    expect(overlays(dead)).toEqual([])
    expect(overlays(late).at(-1)).toEqual([true, '8 unread notifications'])
  })

  it('off Windows draws no overlay and only feeds the dock arbiter', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const win = fakeWindow('app-a')
      const f = fixture(platform, [win])
      f.set('app-a', count(3))
      f.set('app-a', null)
      expect(overlays(win)).toEqual([])
      expect(f.dock.setApp.mock.calls).toEqual([
        ['app-a', count(3)],
        ['app-a', null]
      ])
    }
  })
})
