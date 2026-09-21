import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import { FILE_URL_WITHOUT_ACCESS_ERROR, isFileNavigation } from '../../../core/extensions/api/tabs'
import { TabsApi } from '../extensionApi/tabs'
import { WindowsApi } from '../extensionApi/windows'
import type { ApiContext, ApiHost } from '../extensionApi/types'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const FILE_URL = 'file:///home/user/notes/index.html'

interface World {
  tabs: TabsApi
  windows: WindowsApi
  /** The extension's "Allow access to file URLs" switch. */
  fileAccess: { on: boolean }
  created: Array<{ url?: string }>
  navigated: Array<{ tabId: string; url: string }>
  ctx: ApiContext
}

function world(): World {
  const fileAccess = { on: false }
  const created: World['created'] = []
  const navigated: World['navigated'] = []
  const win = { id: 'w1' } as unknown as ZenWindow
  const tab = { id: 't1', url: 'https://example.com/', pinned: false, essential: false } as Tab
  const model = {
    zenWindow: () => win,
    zenTab: (id: number) => (id === 7 ? tab : undefined),
    chromeTabId: () => 7,
    chromeTab: (t: Tab) => ({ id: 7, url: t.url }),
    windowOfTab: () => win,
    lastFocusedWindow: () => win,
    setOpener: () => undefined,
    browserWindowOf: () => undefined,
    chromeWindow: () => ({ id: 1 }),
    windowIds: () => [1],
    windowIdOf: () => 1
  }
  const browser = {
    extensions: {
      list: () => [{ id: EXT, path: '/ext/' + EXT, allowFileAccess: fileAccess.on }]
    },
    tabs: {
      createTab: (options: { url?: string }) => {
        created.push({ url: options.url })
        return { ...tab, id: 't-new', url: options.url ?? '' }
      },
      navigate: (tabId: string, url: string) => navigated.push({ tabId, url }),
      activeTabFor: () => tab,
      togglePin: () => undefined,
      toggleMute: () => undefined,
      activateTab: () => undefined
    },
    createWindow: () => win
  }
  const host = {
    browser,
    model,
    canSeeTab: () => true,
    sessions: { get: () => ({}) }
  } as unknown as ApiHost
  const ctx = {
    extensionId: EXT,
    extension: { id: EXT, path: '/ext/' + EXT, manifest: { name: 'Probe' }, sessions: [{}] },
    sender: { kind: 'worker' },
    window: win
  } as unknown as ApiContext
  return {
    tabs: new TabsApi(host),
    windows: new WindowsApi(host),
    fileAccess,
    created,
    navigated,
    ctx
  }
}

describe('file URLs in API-triggered navigations', () => {
  it('names a file navigation by its scheme only', () => {
    expect(isFileNavigation(FILE_URL)).toBe(true)
    expect(isFileNavigation('FILE:///C:/notes.txt')).toBe(true)
    expect(isFileNavigation('https://example.com/file:///x')).toBe(false)
    expect(isFileNavigation('chrome-extension://abc/file.html')).toBe(false)
    expect(FILE_URL_WITHOUT_ACCESS_ERROR).toBe(
      'Cannot navigate to a file URL without local file access.'
    )
  })

  it("tabs.create and tabs.update refuse a file URL with Chrome's text while the switch is off, and navigate once it is on", () => {
    const w = world()
    expect(() => w.tabs.handlers.create(w.ctx, { url: FILE_URL })).toThrow(
      FILE_URL_WITHOUT_ACCESS_ERROR
    )
    expect(() => w.tabs.handlers.update(w.ctx, 7, { url: FILE_URL })).toThrow(
      FILE_URL_WITHOUT_ACCESS_ERROR
    )
    expect(() => w.tabs.handlers.update(w.ctx, undefined, { url: 'FILE:///tmp/a.html' })).toThrow(
      FILE_URL_WITHOUT_ACCESS_ERROR
    )
    expect(w.created).toEqual([])
    expect(w.navigated).toEqual([])
    // Other schemes are untouched by the switch.
    w.tabs.handlers.create(w.ctx, { url: 'https://example.org/' })
    w.tabs.handlers.update(w.ctx, 7, { url: 'page.html' })
    expect(w.created).toEqual([{ url: 'https://example.org/' }])
    expect(w.navigated).toEqual([{ tabId: 't1', url: `chrome-extension://${EXT}/page.html` }])
    // The user turns "Allow access to file URLs" on: the same calls go through.
    w.fileAccess.on = true
    w.tabs.handlers.create(w.ctx, { url: FILE_URL })
    w.tabs.handlers.update(w.ctx, 7, { url: FILE_URL })
    expect(w.created.at(-1)).toEqual({ url: FILE_URL })
    expect(w.navigated.at(-1)).toEqual({ tabId: 't1', url: FILE_URL })
  })

  it('windows.create refuses a file URL the same way, before it opens anything', () => {
    const w = world()
    expect(() => w.windows.handlers.create(w.ctx, { url: FILE_URL })).toThrow(
      FILE_URL_WITHOUT_ACCESS_ERROR
    )
    expect(() =>
      w.windows.handlers.create(w.ctx, { url: ['https://example.com/', FILE_URL], type: 'popup' })
    ).toThrow(FILE_URL_WITHOUT_ACCESS_ERROR)
    expect(w.created).toEqual([])
    w.fileAccess.on = true
    w.windows.handlers.create(w.ctx, { url: FILE_URL })
    expect(w.created).toEqual([{ url: FILE_URL }])
  })
})
