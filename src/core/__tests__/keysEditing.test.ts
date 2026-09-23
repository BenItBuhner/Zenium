import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as Os } from '../../shared/types'
import { Browser } from '../browser'
import type {
  AppHost,
  KeyEventInput,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * ⌘← / ⌘→ as Back / Forward on macOS (history-14) without taking the caret's keys from a text
 * field: the chord yields in the chrome (its fields say nothing) and in a page whose focused
 * frame reported a field under the keyboard (`shared/editingFocus` → `KeyboardHandler.
 * setEditing`), as Chrome does by giving the page the key first. ⌘[ / ⌘] stay Back / Forward
 * everywhere.
 */

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

function fakePlatform(io: StoreIO, os: Os): Platform {
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pageControls: false
  })
  return {
    info: { os, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: () => {}
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          getZoom: () => 1
        })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
}

function start(os: Os = 'darwin'): {
  browser: Browser
  win: ZenWindow
  tabId: string
  ran: string[]
} {
  const browser = new Browser(fakePlatform(memoryIo(), os))
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
  const ran: string[] = []
  vi.spyOn(browser.actions, 'run').mockImplementation((action) => {
    ran.push(action)
  })
  return { browser, win, tabId: tab.id, ran }
}

const press = (
  key: string,
  mods: Partial<Pick<KeyEventInput, 'shift' | 'alt' | 'control' | 'meta'>> = {}
): KeyEventInput => ({
  type: 'keyDown',
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  isAutoRepeat: false,
  ...mods
})

describe('⌘← and ⌘→ from a page on macOS', () => {
  it('go Back and Forward while no text field has the keyboard', () => {
    const { browser, win, tabId, ran } = start()
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), tabId, win)).toBe(true)
    expect(browser.keys.handle(press('ArrowRight', { meta: true }), tabId, win)).toBe(true)
    expect(ran).toEqual(['nav.back', 'nav.forward'])
  })

  it('stay the caret\u2019s while the focused frame reports a text field, and come back with it', () => {
    const { browser, win, tabId, ran } = start()
    browser.keys.setEditing(tabId, true)
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), tabId, win)).toBe(false)
    expect(browser.keys.handle(press('ArrowRight', { meta: true }), tabId, win)).toBe(false)
    // The brackets are nobody's caret keys: Back all the same.
    expect(browser.keys.handle(press('[', { meta: true }), tabId, win)).toBe(true)
    expect(ran).toEqual(['nav.back'])
    browser.keys.setEditing(tabId, false)
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), tabId, win)).toBe(true)
    expect(ran).toEqual(['nav.back', 'nav.back'])
  })

  it('one tab\u2019s field does not hold another tab\u2019s keys', () => {
    const { browser, win, tabId, ran } = start()
    const other = browser.tabs.createTab({ url: 'https://example.org/', active: false }, win).id
    browser.keys.setEditing(other, true)
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), tabId, win)).toBe(true)
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), other, win)).toBe(false)
    expect(ran).toEqual(['nav.back'])
  })

  it('arrive over the page-message channel', () => {
    const { browser, win, tabId, ran } = start()
    browser.handlePageMessage(tabId, { type: 'editing', editing: true })
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), tabId, win)).toBe(false)
    browser.handlePageMessage(tabId, { type: 'editing', editing: false })
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), tabId, win)).toBe(true)
    expect(ran).toEqual(['nav.back'])
  })

  it('a closed tab\u2019s report is forgotten', () => {
    const { browser, win, tabId } = start()
    const other = browser.tabs.createTab({ url: 'https://example.org/', active: false }, win).id
    browser.keys.setEditing(other, true)
    browser.tabs.closeTab(other, false, win)
    browser.keys.setEditing(tabId, false)
    expect(browser.keys['editing'].size).toBe(0)
  })
})

describe('⌘← and ⌘→ from the chrome on macOS', () => {
  it('are left to the chrome document (the address bar\u2019s caret), ⌘[ is not', () => {
    const { browser, win, ran } = start()
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), null, win)).toBe(false)
    expect(browser.keys.handle(press('ArrowRight', { meta: true }), null, win)).toBe(false)
    expect(browser.keys.handle(press('[', { meta: true }), null, win)).toBe(true)
    expect(browser.keys.handle(press(']', { meta: true }), null, win)).toBe(true)
    expect(ran).toEqual(['nav.back', 'nav.forward'])
  })
})

describe('off macOS', () => {
  it('Alt+← goes Back from a text field as in Chrome, and ⌘ chords are not bound', () => {
    const { browser, win, tabId, ran } = start('linux')
    browser.keys.setEditing(tabId, true)
    expect(browser.keys.handle(press('ArrowLeft', { alt: true }), tabId, win)).toBe(true)
    expect(browser.keys.handle(press('ArrowLeft', { meta: true }), tabId, win)).toBe(false)
    expect(ran).toEqual(['nav.back'])
  })
})
