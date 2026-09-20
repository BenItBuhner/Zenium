// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ExtensionAction,
  ExtensionInfo,
  MenuItemDescriptor,
  Space,
  Tab,
  UIState
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The phone's Extensions sheet (the app menu's Extensions row, `extensions.open`): one 44 px row
 * per enabled extension with an action, its icon, name and badge; a tap is the action click
 * through `extension.openPopup` and the sheet leaves; a hold opens Chrome's action context menu
 * as a menu sheet over it, whose Remove asks first; the last group leads to Settings ›
 * Extensions; with nothing to list the sheet says so and offers the install step (§9.17).
 * Rendered for real in happy-dom on the frame's dialog host, the frame loop cranked by hand.
 */

const SPACE = 'space'

/**
 * The core: every command is taken and recorded; `extension.actionMenuItems` answers the
 * extension's own action-context items (`ownItems`, per extension id), none by default.
 */
const ownItems = new Map<string, MenuItemDescriptor[]>()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) =>
  name === 'extension.actionMenuItems' ? (ownItems.get((args as { id: string }).id) ?? []) : null
)
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { ExtensionsSheetLayer } = await import('../ExtensionsSheet')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, openExtensionsSheet, uiStore } = await import('@renderer/lib/ui')
const { extensionRevealStore } = await import('@renderer/lib/extensions/manage')

// --- a profile ---------------------------------------------------------------------------------

const action = (over: Partial<ExtensionAction> = {}): ExtensionAction => ({
  badgeText: '',
  badgeBackgroundColor: null,
  badgeTextColor: null,
  title: '',
  icon: null,
  popup: null,
  enabled: true,
  ...over
})

const ext = (over: Partial<ExtensionInfo>): ExtensionInfo =>
  ({
    id: 'a'.repeat(32),
    name: 'Ext',
    version: '1.0',
    description: '',
    path: '/x',
    enabled: true,
    icon: 'data:image/png;base64,AAAA',
    popup: null,
    error: null,
    source: 'store',
    publisher: null,
    updateUrl: null,
    installedAt: 0,
    updatedAt: 0,
    pinned: false,
    toolbarPinned: false,
    allowFileAccess: false,
    allowPrivate: false,
    allowUserScripts: false,
    manifestVersion: 3,
    permissions: [],
    hostPermissions: [],
    optionsPage: null,
    newTabPage: null,
    newTabOverride: false,
    warnings: [],
    pendingWarnings: null,
    updateState: 'unknown',
    availableVersion: null,
    updateError: null,
    updateCheckedAt: null,
    errors: [],
    action: action(),
    ...over
  }) as ExtensionInfo

const VIMIUM = 'dbepggeogbaibhgnhhndojpepiihcmeb'
const UBLOCK = 'cjpalhdlnbpafiamejdnhcphjbkeiagm'
const DARK = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'

const three = (): ExtensionInfo[] => [
  ext({
    id: VIMIUM,
    name: 'Vimium',
    optionsPage: 'chrome-extension://dbepggeogbaibhgnhhndojpepiihcmeb/pages/options.html',
    action: action({ title: 'Vimium', popup: null })
  }),
  ext({
    id: UBLOCK,
    name: 'uBlock Origin',
    popup: 'popup.html',
    action: action({
      badgeText: '12',
      badgeBackgroundColor: '#1a237e',
      popup: `chrome-extension://${UBLOCK}/popup.html`
    })
  }),
  ext({ id: DARK, name: 'Dark Reader', action: action({ enabled: false }) }),
  ext({ id: 'f'.repeat(32), name: 'Off', enabled: false }),
  ext({ id: 'g'.repeat(32), name: 'Unloaded', action: undefined })
]

function stateOf(extensions: ExtensionInfo[]): UIState {
  const tab = {
    id: 't',
    spaceId: SPACE,
    containerId: 'default',
    url: 'https://a.example/',
    title: 'Alpha',
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: false,
    canGoForward: false
  } as unknown as Tab
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: [tab.id],
    activeTabId: tab.id,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false, extensions: true, pageTabs: true },
    tabs: { [tab.id]: tab },
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions,
    bookmarks: [],
    recentlyClosed: []
  } as unknown as UIState
}

// --- a clock and a frame loop ------------------------------------------------------------------

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: a sheet lands, a picked row's action runs. */
async function land(): Promise<void> {
  await act(async () => {
    frames.run(150)
  })
  await settle()
}

/** The browser shows `extensions`; the sheet is asked for as the app menu's row asks. */
async function show(extensions: ExtensionInfo[]): Promise<void> {
  act(() => browserStore.set({ state: stateOf(extensions) }))
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(FrameDialogHost, null, createElement(ExtensionsSheetLayer))))
  act(() => openExtensionsSheet())
  await settle()
  await land()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  frames.install()
  invoke.mockClear()
  ownItems.clear()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ extensionsSheetOpen: false })
  browserStore.set({ state: null })
  extensionRevealStore.set({ id: null })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames.now = 0
})

// --- helpers -----------------------------------------------------------------------------------

const CHASSIS = new Set(['overlay.snapshot', 'focus.content', 'extension.actionMenuItems'])
const menuRequests = (): unknown[] =>
  invoke.mock.calls.filter(([name]) => name === 'extension.actionMenuItems').map(([, args]) => args)
const menuItems = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.zen-ext-action-menu .zen-sheet-item')
]
const menuGroups = (): string[][] =>
  [...document.querySelectorAll<HTMLElement>('.zen-ext-action-menu ul')].map((ul) =>
    [...ul.querySelectorAll<HTMLElement>('.zen-sheet-item')].map((b) => b.textContent?.trim() ?? '')
  )
/** A descriptor as the core answers one. */
const own = (over: Partial<MenuItemDescriptor> & { id: string }): MenuItemDescriptor => ({
  type: 'normal',
  label: over.id,
  enabled: true,
  checked: false,
  icon: null,
  submenu: null,
  ...over
})
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls
    .filter(([name]) => !CHASSIS.has(name))
    .map(([name, args]) => [name, args] as [string, unknown])
const titles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs h2')].map(
    (h) => h.textContent?.trim() ?? ''
  )
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs .zen-phone-row')
]
const rowMain = (row: HTMLElement): HTMLElement =>
  row.querySelector<HTMLElement>('[role="button"]')!
const rowLabels = (): Array<string | null> =>
  rows().map((r) => rowMain(r).getAttribute('aria-label'))
const buttonByText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs button')].find(
    (b) => b.textContent?.trim() === text
  )
const hold = (row: HTMLElement): void => {
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
}

// --- the sheet ---------------------------------------------------------------------------------

describe('the phone Extensions sheet', () => {
  it('lists one row per enabled extension with an action – icon, name, badge – and the way to Settings › Extensions', async () => {
    await show(three())
    expect(titles()).toEqual(['Extensions'])
    expect(uiStore.get().extensionsSheetOpen).toBe(true)
    // A disabled extension and one without an action state are not listed (§9.17's sentence
    // says "with a toolbar action"); the last group is the management row.
    expect(rowLabels()).toEqual([
      'Vimium',
      'uBlock Origin, badge 12',
      'Dark Reader',
      'Manage extensions'
    ])
    const [vimium, ublock, dark] = rows()
    // The manifest icon in the leading box at 20; the badge trailing in the extension's colours.
    expect(vimium.querySelector('img')?.getAttribute('width')).toBe('20')
    const badge = ublock.querySelector<HTMLElement>('.zen-ext-phone-badge')!
    expect(badge.textContent).toBe('12')
    expect(badge.style.background).toBe('rgb(26 35 126)')
    expect(badge.closest('.zen-list-trailing')).not.toBeNull()
    expect(vimium.querySelector('.zen-ext-phone-badge')).toBeNull()
    // An action turned off for this tab keeps its row at the disabled number.
    expect(dark.hasAttribute('data-disabled')).toBe(true)
    expect(rowMain(dark).getAttribute('aria-disabled')).toBe('true')
    expect(vimium.hasAttribute('data-disabled')).toBe(false)
    // Groups are told apart by the hairline; the management row leaves, so it carries the chevron.
    expect(document.querySelector('.zen-frame-dialogs .zen-sheet-sep')).not.toBeNull()
    expect(rows()[3].querySelector('.lucide-chevron-right')).not.toBeNull()
  })

  it('a tap is the action click through the desktop button’s command path, and the sheet leaves with it', async () => {
    await show(three())
    act(() => rowMain(rows()[1]).click())
    await land()
    expect(commands()).toEqual([
      ['extension.openPopup', { id: UBLOCK, anchor: { x: 0, y: 0, width: 0, height: 0 } }]
    ])
    expect(titles()).toEqual([])
    expect(uiStore.get().extensionsSheetOpen).toBe(false)
  })

  it('an action turned off for this tab takes no tap', async () => {
    await show(three())
    act(() => rowMain(rows()[2]).click())
    await land()
    expect(commands()).toEqual([])
    expect(titles()).toEqual(['Extensions'])
  })

  it('the management row leads to the Settings category once the sheet is gone', async () => {
    await show(three())
    act(() => rowMain(rows()[3]).click())
    await land()
    expect(commands()).toEqual([['page.open', { id: 'settings', section: 'extensions' }]])
    expect(uiStore.get().extensionsSheetOpen).toBe(false)
  })

  it('a hold opens Chrome’s action context menu as a menu sheet over the list, named after the extension, Remove last under its hairline', async () => {
    await show(three())
    hold(rows()[0])
    await land()
    // Depth two (§9.24): the list stays under the menu.
    expect(titles()).toEqual(['Extensions', 'Vimium'])
    // Options and Manage Extension, then the destructive row alone in the last group (§10.4).
    expect(menuGroups()).toEqual([['Options', 'Manage Extension'], ['Remove from Zenium']])
    const items = menuItems()
    expect(items[2].hasAttribute('data-danger')).toBe(true)
    expect(items[0].hasAttribute('data-danger')).toBe(false)
    expect(document.querySelectorAll('.zen-ext-action-menu .zen-sheet-sep')).toHaveLength(1)
    // The extension's own items were asked for as the menu opened; it has none.
    expect(menuRequests()).toEqual([{ id: VIMIUM }])
    // Options: the menu leaves, then the list, then the options page opens as a tab.
    act(() => items[0].click())
    await land()
    await land()
    expect(commands()).toEqual([['extension.openOptions', { id: VIMIUM }]])
    expect(titles()).toEqual([])
  })

  it('offers no Options for an extension without an options page, and Manage Extension opens its details', async () => {
    await show(three())
    hold(rows()[1])
    await land()
    expect(menuGroups()).toEqual([['Manage Extension'], ['Remove from Zenium']])
    act(() => menuItems()[0].click())
    await land()
    await land()
    // Settings › Extensions with the extension's details asked for (`extensionRevealStore`).
    expect(commands()).toEqual([['page.open', { id: 'settings', section: 'extensions' }]])
    expect(extensionRevealStore.get().id).toBe(UBLOCK)
  })

  it('puts the extension’s own action-context items first, above a hairline, and a pick runs them against the page', async () => {
    ownItems.set(UBLOCK, [
      own({ id: 'action_1_1', label: 'Open Dashboard' }),
      own({ id: 'action_1_2', label: 'Block Element', enabled: false }),
      own({ id: 'action_1_3', label: 'Night Mode', type: 'checkbox', checked: true })
    ])
    await show(three())
    hold(rows()[1])
    await land()
    expect(titles()).toEqual(['Extensions', 'uBlock Origin'])
    expect(menuGroups()).toEqual([
      ['Open Dashboard', 'Block Element', 'Night Mode'],
      ['Manage Extension'],
      ['Remove from Zenium']
    ])
    expect(document.querySelectorAll('.zen-ext-action-menu .zen-sheet-sep')).toHaveLength(2)
    const items = menuItems()
    // An item the extension turned off takes no tap; a checked checkbox shows its check.
    expect((items[1] as HTMLButtonElement).disabled).toBe(true)
    expect(items[2].getAttribute('role')).toBe('menuitemcheckbox')
    expect(items[2].getAttribute('aria-checked')).toBe('true')
    expect(items[2].querySelector('.lucide-check')).not.toBeNull()
    expect(items[0].querySelector('.lucide-check')).toBeNull()
    // The pick: the menu leaves, the list leaves too (the page the item acts on is under them),
    // and the core is told which handle was picked.
    act(() => items[0].click())
    await land()
    await land()
    expect(commands()).toEqual([
      ['extension.actionMenuClick', { id: UBLOCK, itemId: 'action_1_1' }]
    ])
    expect(titles()).toEqual([])
    expect(uiStore.get().extensionsSheetOpen).toBe(false)
  })

  it('drills into one of the extension’s submenus, with Back in the header, and picks inside it', async () => {
    ownItems.set(VIMIUM, [
      own({ id: 'action_2_1', label: 'Open Dashboard' }),
      own({ id: 'sep', type: 'separator', label: '' }),
      own({
        id: 'action_2_2',
        label: 'More',
        submenu: [own({ id: 'action_2_3', label: 'Report an Issue' })]
      })
    ])
    await show(three())
    hold(rows()[0])
    await land()
    // The extension's separator breaks its items into groups; the submenu row carries the chevron.
    expect(menuGroups()).toEqual([
      ['Open Dashboard'],
      ['More'],
      ['Options', 'Manage Extension'],
      ['Remove from Zenium']
    ])
    const more = menuItems()[1]
    expect(more.querySelector('.lucide-chevron-right')).not.toBeNull()
    act(() => more.click())
    await settle()
    // Inside: the header names the submenu, Back leads out, only the submenu's items show.
    expect(titles()).toEqual(['Extensions', 'More'])
    expect(menuGroups()).toEqual([['Report an Issue']])
    const back = document.querySelector<HTMLElement>(
      '.zen-frame-dialogs .zen-sheet-header-control[data-side="leading"]'
    )!
    expect(back.getAttribute('aria-label')).toBe('Back')
    act(() => back.click())
    await settle()
    expect(titles()).toEqual(['Extensions', 'Vimium'])
    act(() => menuItems()[1].click())
    await settle()
    act(() => menuItems()[0].click())
    await land()
    await land()
    expect(commands()).toEqual([
      ['extension.actionMenuClick', { id: VIMIUM, itemId: 'action_2_3' }]
    ])
    expect(titles()).toEqual([])
  })

  it('Remove from Zenium asks first, in the menu’s place, and removes once the answer has landed', async () => {
    await show(three())
    hold(rows()[0])
    await land()
    act(() => buttonByText('Remove from Zenium')!.click())
    await land()
    // The menu has gone; the confirmation stands over the list with the Settings row's words.
    expect(titles()).toEqual(['Extensions', 'Remove Vimium?'])
    expect(document.querySelector('.zen-frame-dialogs .zen-sheet-title-block p')?.textContent).toBe(
      'Its settings and data on this device go with it.'
    )
    const remove = buttonByText('Remove')!
    expect(remove.hasAttribute('data-danger')).toBe(true)
    // Cancel keeps it.
    act(() => buttonByText('Cancel')!.click())
    await land()
    expect(commands()).toEqual([])
    expect(titles()).toEqual(['Extensions'])
    // Remove, answered: the command runs; the list stays and follows the core.
    hold(rows()[0])
    await land()
    act(() => buttonByText('Remove from Zenium')!.click())
    await land()
    act(() => buttonByText('Remove')!.click())
    await land()
    expect(commands()).toEqual([['extension.remove', { id: VIMIUM }]])
    expect(titles()).toEqual(['Extensions'])
    act(() => browserStore.set({ state: stateOf(three().filter((e) => e.id !== VIMIUM)) }))
    await settle()
    expect(rowLabels()).toEqual(['uBlock Origin, badge 12', 'Dark Reader', 'Manage extensions'])
  })

  it('says so with nothing to list, and offers the install step (§9.17)', async () => {
    await show([ext({ id: 'f'.repeat(32), name: 'Off', enabled: false })])
    const empty = document.querySelector<HTMLElement>('.zen-frame-dialogs .zen-phone-empty')!
    expect(empty.querySelector('p')?.textContent).toBe('No extensions with a toolbar action')
    expect(rowLabels()).toEqual(['Manage extensions'])
    const install = empty.querySelector<HTMLElement>('button')!
    expect(install.textContent).toBe('Install an extension')
    expect(install.classList.contains('zen-v2-button')).toBe(true)
    expect(install.hasAttribute('data-primary')).toBe(false)
    act(() => install.click())
    await land()
    expect(commands()).toEqual([['page.open', { id: 'settings', section: 'extensions' }]])
    expect(uiStore.get().extensionsSheetOpen).toBe(false)
  })
})
