import { describe, expect, it, vi } from 'vitest'
import type { WindowChrome } from '../../../shared/types'
import type { Browser } from '../../../core/browser'
import type { ZenWindow } from '../../../core/window'
import { windowTypeForChrome } from '../../../core/extensions/api/windows'
import { ApiModel } from '../extensionApi/model'
import { WindowsApi } from '../extensionApi/windows'
import type { ApiContext, ApiHost } from '../extensionApi/types'
import type { ElectronTabViewHost } from '../views'

/**
 * A stand-in for Electron's `BrowserWindow`: what `ApiModel` reads of a Zenium window's frame
 * and what `WindowsApi.create({ type: 'popup' })` builds and reads back.
 */
const { FakeBrowserWindow } = vi.hoisted(() => {
  class FakeBrowserWindow {
    static next = 1
    static created: FakeBrowserWindow[] = []
    readonly id: number
    readonly options: Record<string, unknown>
    shown: 'active' | 'inactive' | null = null
    readonly webContents = {
      id: 500 + FakeBrowserWindow.next,
      setWindowOpenHandler: () => undefined,
      getURL: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/dialog.html',
      getTitle: () => 'Dialog',
      isLoading: () => false,
      isCurrentlyAudible: () => false,
      isAudioMuted: () => false
    }
    constructor(options: Record<string, unknown> = {}) {
      this.id = FakeBrowserWindow.next++
      this.options = options
      FakeBrowserWindow.created.push(this)
    }
    static fromWebContents(): null {
      return null
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return {
        x: 0,
        y: 0,
        width: Number(this.options.width ?? 1280),
        height: Number(this.options.height ?? 820)
      }
    }
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return this.getBounds()
    }
    isDestroyed(): boolean {
      return false
    }
    isFocused(): boolean {
      return false
    }
    isMinimized(): boolean {
      return false
    }
    isFullScreen(): boolean {
      return false
    }
    isMaximized(): boolean {
      return false
    }
    isAlwaysOnTop(): boolean {
      return false
    }
    isVisible(): boolean {
      return true
    }
    on(): this {
      return this
    }
    once(): this {
      return this
    }
    show(): void {
      this.shown = 'active'
    }
    showInactive(): void {
      this.shown = 'inactive'
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
  }
  return { FakeBrowserWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  webContents: { fromId: () => undefined }
}))

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

function zenWindow(chrome: WindowChrome, opts: { isPrivate?: boolean } = {}): ZenWindow {
  const bw = new FakeBrowserWindow()
  return {
    id: `w${bw.id}`,
    kind: opts.isPrivate ? 'private' : 'synced',
    chrome,
    isPrivate: opts.isPrivate ?? false,
    lastFocusedAt: bw.id,
    host: { alive: true, win: bw, isFocused: () => false }
  } as unknown as ZenWindow
}

function modelOver(windows: ZenWindow[]): ApiModel {
  const browser = {
    allWindows: () => windows,
    tabs: { all: () => [] },
    state: { tabs: [], spaces: [], folders: [] }
  } as unknown as Browser
  const views = {
    viewForTab: () => undefined,
    tabIdForWebContents: () => undefined
  } as unknown as ElectronTabViewHost
  return new ApiModel(browser, views)
}

describe('chrome.windows window types', () => {
  it('maps the chrome a window draws onto Chrome’s type', () => {
    expect(windowTypeForChrome('full')).toBe('normal')
    expect(windowTypeForChrome('popup')).toBe('popup')
    expect(windowTypeForChrome('app')).toBe('app')
  })

  it('reports the toolbar-only window a sized window.open makes as a popup, a tabbed window as normal, an app window as app', () => {
    const tabbed = zenWindow('full')
    const dialog = zenWindow('popup')
    const app = zenWindow('app')
    const model = modelOver([tabbed, dialog, app])
    const urls = (): boolean => true
    expect(model.chromeWindow(tabbed, false, urls).type).toBe('normal')
    expect(model.chromeWindow(dialog, false, urls).type).toBe('popup')
    expect(model.chromeWindow(app, false, urls).type).toBe('app')
    expect(model.windowTypeOf(model.windowIdOf(tabbed))).toBe('normal')
    expect(model.windowTypeOf(model.windowIdOf(dialog))).toBe('popup')
    expect(model.windowTypeOf(model.windowIdOf(app))).toBe('app')
    expect(model.windowTypeOf(9999)).toBe('normal')
    expect(model.chromeWindowById(model.windowIdOf(dialog), false, urls)?.type).toBe('popup')
  })

  it('windows.create({ type: "popup" }) reads back as a popup, in getAll and by id, and a normal-only query leaves it out', () => {
    const main = zenWindow('full')
    const model = modelOver([main])
    const host = {
      browser: {
        extensions: { list: () => [{ id: EXT, path: '/ext/' + EXT, allowFileAccess: false }] },
        tabs: { createTab: () => undefined },
        allWindows: () => [main]
      },
      model,
      sessions: { get: () => ({}) },
      scheduleTick: () => undefined
    } as unknown as ApiHost
    const ctx = {
      extensionId: EXT,
      extension: { id: EXT, path: '/ext/' + EXT, manifest: { name: 'Probe' }, sessions: [{}] },
      sender: { kind: 'worker' },
      window: main
    } as unknown as ApiContext
    const windows = new WindowsApi(host)
    const created = windows.handlers.create(ctx, {
      url: 'dialog.html',
      type: 'popup',
      width: 900,
      height: 600
    }) as { id: number; type: string; width?: number; height?: number; tabs?: unknown[] }
    expect(created.type).toBe('popup')
    expect([created.width, created.height]).toEqual([900, 600])
    expect(created.tabs).toHaveLength(1)
    expect(model.windowTypeOf(created.id)).toBe('popup')
    const all = windows.handlers.getAll(ctx, {}) as Array<{ id: number; type: string }>
    expect(all.map((w) => w.type).sort()).toEqual(['normal', 'popup'])
    const normalOnly = windows.handlers.getAll(ctx, { windowTypes: ['normal'] }) as Array<{
      id: number
    }>
    expect(normalOnly.map((w) => w.id)).toEqual([model.windowIdOf(main)])
    const popupsOnly = windows.handlers.getAll(ctx, { windowTypes: ['popup'] }) as Array<{
      id: number
    }>
    expect(popupsOnly.map((w) => w.id)).toEqual([created.id])
    expect((windows.handlers.get(ctx, created.id, {}) as { type: string }).type).toBe('popup')
  })
})
