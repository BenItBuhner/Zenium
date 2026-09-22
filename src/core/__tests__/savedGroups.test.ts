import { describe, expect, it } from 'vitest'
import { FOLDER_COLOR_NAMES, FOLDER_COLOR_ORDER } from '../../shared/defaults'
import type { FormFactor, HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import { createSpace, createTabRecord, isSavedFolder } from '../model'
import type {
  MenuHost,
  MenuItemTemplate,
  PageContextParams,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import { PERSISTED_VERSION } from '../state'
import type { ZenWindow } from '../window'

/**
 * Saved tab groups (TAB-16, Chrome for Android's Tab groups pane): closing a group's tabs keeps
 * the group as a saved one with their pages (`Folder.savedTabs`), "Open" brings them back into
 * it in order, and the group's name and colour survive the round trip; the link menu's "Open
 * Link in New Tab in Group" (TAB-15) for a tab in a group on a touch host; and the touch host's
 * group menu (TABLET-04, the tablet sidebar row's hold; `groupMenu`) by the group's state.
 */

/** The profile's files by name, `files` being what the store starts from and writes into. */
function memoryIo(files: Record<string, string> = {}): StoreIO {
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

interface Harness {
  browser: Browser
  win: ZenWindow
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
  /** The events sent to the window's chrome, in order. */
  sent: Array<{ name: string; payload: unknown }>
  /** A regular tab in the window's space, active unless said otherwise. */
  open: (url: string, opts?: { folderId?: string; active?: boolean }) => string
  /** A group of the window's space, with no editor opened for it. */
  group: (name: string) => string
  /** The space's tabs in order, as their URLs. */
  urls: () => string[]
}

/** A browser on a phone (or `formFactor`) over `files`, a profile's store – empty for a first run. */
function harness(
  formFactor: FormFactor = 'phone',
  privateTabs = true,
  files: Record<string, string> = {}
): Harness {
  let last: MenuItemTemplate[] = []
  const sent: Harness['sent'] = []
  const menus: MenuHost = {
    popup: (items) => {
      last = items
    }
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({
      windows: formFactor === 'desktop',
      nativeMenus: true,
      privateTabs
    }),
    io: memoryIo(files),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name, payload) => void sent.push({ name, payload })
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ index: 0, entries: [] })
        })
    }),
    menus,
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  browser.handleCommand(win, 'window.formFactor', { formFactor })
  return {
    browser,
    win,
    shown: () => last,
    sent,
    open: (url, opts = {}) =>
      browser.tabs.createTab({ url, active: opts.active ?? true, folderId: opts.folderId }, win).id,
    group: (name) =>
      browser.createFolder(win.activeSpaceId, name, '📁', win, { rename: false, color: 'blue' }).id,
    urls: () => win.activeSpace().tabIds.map((id) => browser.tabs.tab(id)!.url)
  }
}

const labels = (items: MenuItemTemplate[]): string[] =>
  items.map((i) => (i.type === 'separator' ? '-' : (i.label ?? '')))

function click(items: MenuItemTemplate[], label: string): void {
  const item = items.find((i) => i.label === label)
  if (!item?.click) throw new Error(`no clickable "${label}" in ${labels(items).join(', ')}`)
  item.click()
}

const linkParams = (linkURL: string): PageContextParams => ({
  x: 10,
  y: 10,
  linkURL,
  srcURL: '',
  mediaType: 'none',
  selectionText: '',
  isEditable: false,
  misspelledWord: '',
  dictionarySuggestions: [],
  pageURL: 'https://page.test/',
  frameURL: '',
  frameId: 0,
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false
  }
})

describe('a saved group (TAB-16)', () => {
  it('folder.close closes the tabs and keeps the group with their pages, in order', () => {
    const h = harness()
    const m = h.browser.state.model
    const loose = h.open('https://loose.test/')
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    const b = h.open('https://b.test/', { folderId: folder })
    const c = h.open('https://c.test/', { folderId: folder })
    m.tabs[b].title = 'B page'
    m.tabs[b].favicon = 'https://b.test/icon.png'
    expect(isSavedFolder(m, m.folders[folder])).toBe(false)

    h.browser.handleCommand(h.win, 'folder.close', { folderId: folder })

    for (const id of [a, b, c]) expect(h.browser.tabs.tab(id)).toBeUndefined()
    expect(h.browser.tabs.tab(loose)).toBeDefined()
    expect(m.folders[folder]).toMatchObject({ name: 'Trip', color: 'blue' })
    expect(m.folders[folder].savedTabs).toEqual([
      { url: 'https://a.test/', title: 'a.test', favicon: null },
      { url: 'https://b.test/', title: 'B page', favicon: 'https://b.test/icon.png' },
      { url: 'https://c.test/', title: 'c.test', favicon: null }
    ])
    expect(typeof m.folders[folder].lastUsedAt).toBe('number')
    expect(isSavedFolder(m, m.folders[folder])).toBe(true)
    // The tabs are filed too: the close has its undo, and the group is where they come back.
    expect(
      h.browser.state.recentlyClosed.map((e) => (e.kind === 'tab' ? e.folderId : e.kind))
    ).toEqual([folder, folder, folder])
    // Closing a group with no live tab changes nothing.
    h.browser.handleCommand(h.win, 'folder.close', { folderId: folder })
    expect(m.folders[folder].savedTabs).toHaveLength(3)
  })

  it('folder.open brings the pages back into the group in their order, the first active', () => {
    const h = harness()
    const m = h.browser.state.model
    const folder = h.group('Trip')
    h.open('https://a.test/', { folderId: folder })
    h.open('https://b.test/', { folderId: folder })
    h.browser.handleCommand(h.win, 'folder.close', { folderId: folder })
    h.browser.updateFolder(folder, { collapsed: true })
    const later = h.open('https://later.test/')
    expect(h.urls()).toEqual(['https://later.test/'])

    const active = h.browser.handleCommand(h.win, 'folder.open', { folderId: folder }) as string

    expect(h.urls()).toEqual(['https://later.test/', 'https://a.test/', 'https://b.test/'])
    const [restoredA, restoredB] = h.win.activeSpace().tabIds.slice(1)
    expect(m.tabs[restoredA].folderId).toBe(folder)
    expect(m.tabs[restoredB].folderId).toBe(folder)
    expect(active).toBe(restoredA)
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(restoredA)
    expect(h.browser.tabs.tab(later)).toBeDefined()
    const reopened = m.folders[folder]
    expect(reopened.savedTabs).toBeNull()
    expect(reopened.collapsed).toBe(false)
    expect(isSavedFolder(m, reopened)).toBe(false)
    // An open group is not restored again: it is unfolded and its first tab activated.
    h.browser.updateFolder(folder, { collapsed: true })
    h.browser.tabs.activateTab(later, h.win)
    expect(h.browser.handleCommand(h.win, 'folder.open', { folderId: folder })).toBe(restoredA)
    expect(m.folders[folder].collapsed).toBe(false)
    expect(h.urls()).toHaveLength(3)
    // Nothing to open: an empty group, or none.
    const empty = h.group('Empty')
    expect(h.browser.handleCommand(h.win, 'folder.open', { folderId: empty })).toBeNull()
    expect(h.browser.handleCommand(h.win, 'folder.open', { folderId: 'folder:gone' })).toBeNull()
  })

  it('members closed one by one leave the group with the last one, as Chrome’s saved group does', () => {
    const h = harness()
    const m = h.browser.state.model
    const folder = h.group('Reading')
    const a = h.open('https://a.test/', { folderId: folder })
    const b = h.open('https://b.test/', { folderId: folder })
    h.browser.tabs.closeTab(a, false, h.win)
    expect(m.folders[folder].savedTabs).toBeUndefined()
    expect(isSavedFolder(m, m.folders[folder])).toBe(false)
    h.browser.tabs.closeTab(b, false, h.win)
    expect(m.folders[folder].savedTabs).toEqual([
      { url: 'https://b.test/', title: 'b.test', favicon: null }
    ])
    expect(isSavedFolder(m, m.folders[folder])).toBe(true)
  })

  it('a tab joining a saved group opens it: the kept pages go, and the group counts as used', () => {
    const h = harness()
    const m = h.browser.state.model
    const folder = h.group('Trip')
    h.open('https://a.test/', { folderId: folder })
    h.browser.handleCommand(h.win, 'folder.close', { folderId: folder })
    m.folders[folder].lastUsedAt = 1
    const loose = h.open('https://loose.test/')
    h.browser.tabs.moveToFolder(loose, folder)
    expect(m.folders[folder].savedTabs).toBeNull()
    expect(m.folders[folder].lastUsedAt).toBeGreaterThan(1)
    expect(isSavedFolder(m, m.folders[folder])).toBe(false)

    // Undo of the close – the recently closed entry restored – opens it the same way.
    const again = h.group('Again')
    h.open('https://again.test/', { folderId: again })
    h.browser.handleCommand(h.win, 'folder.close', { folderId: again })
    expect(isSavedFolder(m, m.folders[again])).toBe(true)
    const entry = h.browser.state.recentlyClosed.find(
      (e) => e.kind === 'tab' && e.folderId === again
    )!
    h.browser.handleCommand(h.win, 'session.restoreClosed', { id: entry.id })
    expect(isSavedFolder(m, m.folders[again])).toBe(false)
    const restored = Object.values(m.tabs).find((t) => t.url === 'https://again.test/')!
    expect(restored.folderId).toBe(again)
    expect(m.folders[again].savedTabs).toBeNull()
  })

  it('rename and colour keep the saved pages; delete removes the group', () => {
    const h = harness()
    const m = h.browser.state.model
    const folder = h.group('Trip')
    h.open('https://a.test/', { folderId: folder })
    h.browser.handleCommand(h.win, 'folder.close', { folderId: folder })
    h.browser.handleCommand(h.win, 'folder.update', {
      folderId: folder,
      patch: { name: 'Holiday', color: 'pink' }
    })
    expect(m.folders[folder]).toMatchObject({
      name: 'Holiday',
      color: 'pink',
      savedTabs: [{ url: 'https://a.test/', title: 'a.test', favicon: null }]
    })
    expect(isSavedFolder(m, m.folders[folder])).toBe(true)
    h.browser.handleCommand(h.win, 'folder.delete', { folderId: folder, unpack: false })
    expect(m.folders[folder]).toBeUndefined()
  })

  it('activating a member marks the group used', () => {
    const h = harness()
    const m = h.browser.state.model
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    const loose = h.open('https://loose.test/')
    m.folders[folder].lastUsedAt = 1
    h.browser.tabs.activateTab(loose, h.win)
    expect(m.folders[folder].lastUsedAt).toBe(1)
    h.browser.tabs.activateTab(a, h.win)
    expect(m.folders[folder].lastUsedAt).toBe(m.tabs[a].lastActiveAt)
  })

  it('an old state file loads through the reader as it is, and the saved pages and the last use come back through it', async () => {
    // A profile written before saved groups (state.json v2): a folder with the fields of its day
    // and nothing of TAB-16's – no `savedTabs`, no `lastUsedAt` – holding one tab.
    const space = createSpace('Work', '')
    const folder = {
      id: 'folder_trip',
      spaceId: space.id,
      name: 'Trip',
      icon: '📁',
      collapsed: false
    }
    const tab = createTabRecord({
      spaceId: space.id,
      containerId: 'default',
      url: 'https://a.test/',
      title: 'a.test',
      folderId: folder.id
    })
    space.tabIds = [tab.id]
    space.activeTabId = tab.id
    const old = {
      version: 2,
      spaces: [space],
      tabs: [tab],
      essentialTabIds: [],
      activeSpaceId: space.id,
      settings: {},
      folders: [folder]
    }
    const files = { 'state.json': JSON.stringify(old) }

    // The real reader (`BrowserState.load`, which the browser's start runs) takes the folder
    // whole: no migration, no version bump, the optionals simply absent and the group as before.
    const h = harness('phone', true, files)
    const m = h.browser.state.model
    expect(m.folders[folder.id]).toEqual(folder)
    expect('savedTabs' in m.folders[folder.id]).toBe(false)
    expect('lastUsedAt' in m.folders[folder.id]).toBe(false)
    expect(isSavedFolder(m, m.folders[folder.id])).toBe(false)
    expect(m.tabs[tab.id]?.folderId).toBe(folder.id)

    // Closing the group writes the pages and the moment; the file is the current version.
    h.browser.handleCommand(h.win, 'folder.close', { folderId: folder.id })
    await h.browser.state.flush()
    const written = JSON.parse(files['state.json']) as { version: number; folders: unknown[] }
    expect(written.version).toBe(PERSISTED_VERSION)
    expect(written.folders).toEqual([
      {
        ...folder,
        savedTabs: [{ url: 'https://a.test/', title: 'a.test', favicon: null }],
        lastUsedAt: expect.any(Number)
      }
    ])

    // Read back through the same reader on a fresh browser: the saved group, its pages in order,
    // and Open bringing them back into it.
    const again = harness('phone', true, { 'state.json': files['state.json'] })
    const stored = again.browser.state.model.folders[folder.id]
    expect(stored.savedTabs).toEqual([{ url: 'https://a.test/', title: 'a.test', favicon: null }])
    expect(typeof stored.lastUsedAt).toBe('number')
    expect(isSavedFolder(again.browser.state.model, stored)).toBe(true)
    expect(again.urls()).not.toContain('https://a.test/')
    again.browser.handleCommand(again.win, 'folder.open', { folderId: folder.id })
    expect(again.urls()).toContain('https://a.test/')
    const reopened = again.urls().indexOf('https://a.test/')
    const reopenedTab = again.browser.tabs.tab(again.win.activeSpace().tabIds[reopened])!
    expect(reopenedTab.folderId).toBe(folder.id)
    expect(isSavedFolder(again.browser.state.model, stored)).toBe(false)
  })
})

describe('the link menu’s group item (TAB-15)', () => {
  const url = 'https://linked.test/'

  it('offers Open Link in New Tab in Group first for a tab in a group, on a touch host', () => {
    const h = harness('phone')
    const m = h.browser.state.model
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    h.open('https://b.test/', { folderId: folder })
    const loose = h.open('https://loose.test/')
    h.browser.tabs.activateTab(a, h.win)

    h.browser.menus.showPageContextMenu(a, linkParams(url), h.win)
    const menu = labels(h.shown())
    expect(menu.indexOf('Open Link in New Tab in Group')).toBe(0)
    expect(menu.indexOf('Open Link in New Tab')).toBe(1)
    expect(menu.indexOf('Open Link in Private Tab')).toBe(2)

    // In the group, behind the current tab, in the background.
    click(h.shown(), 'Open Link in New Tab in Group')
    const grouped = Object.values(m.tabs).find((t) => t.url === url)!
    expect(grouped.folderId).toBe(folder)
    expect(h.urls()).toEqual(['https://a.test/', url, 'https://b.test/', 'https://loose.test/'])
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(a)

    // The plain item then opens outside the group, after its last member.
    h.browser.menus.showPageContextMenu(a, linkParams('https://outside.test/'), h.win)
    click(h.shown(), 'Open Link in New Tab')
    const outside = Object.values(m.tabs).find((t) => t.url === 'https://outside.test/')!
    expect(outside.folderId).toBeNull()
    expect(h.urls()).toEqual([
      'https://a.test/',
      url,
      'https://b.test/',
      'https://outside.test/',
      'https://loose.test/'
    ])

    // A loose tab has no group to open into: the plain item alone, joining nothing.
    h.browser.menus.showPageContextMenu(loose, linkParams('https://from-loose.test/'), h.win)
    expect(labels(h.shown())).not.toContain('Open Link in New Tab in Group')
    click(h.shown(), 'Open Link in New Tab')
    expect(
      Object.values(m.tabs).find((t) => t.url === 'https://from-loose.test/')?.folderId
    ).toBeNull()
  })

  it('stays off the desktop menu, whose one item keeps joining the group', () => {
    const h = harness('desktop', false)
    const m = h.browser.state.model
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    h.browser.menus.showPageContextMenu(a, linkParams(url), h.win)
    expect(labels(h.shown())).not.toContain('Open Link in New Tab in Group')
    click(h.shown(), 'Open Link in New Tab')
    expect(Object.values(m.tabs).find((t) => t.url === url)?.folderId).toBe(folder)
  })
})

describe('the touch host’s group menu (TABLET-04; v2 §9.1, §6)', () => {
  const trip = (h: Harness): { folder: string; a: string; b: string } => {
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    const b = h.open('https://b.test/', { folderId: folder })
    h.open('https://loose.test/')
    return { folder, a, b }
  }
  const items = (h: Harness): MenuItemTemplate[] => h.shown().filter((i) => i.type !== 'separator')

  it('lists Chrome’s group items in Title Case, Delete Group alone in the danger ink', () => {
    const h = harness('tablet', false)
    const { folder } = trip(h)
    h.browser.menus.showFolderContextMenu(folder, h.win)
    expect(labels(h.shown())).toEqual([
      'Rename Group…',
      'Colour',
      'New Tab in Group',
      'Collapse Group',
      '-',
      'Ungroup',
      'Close Group (2 Tabs)',
      'Delete Group'
    ])
    // Close Group destroys nothing the saved group does not keep (§6): the plain ink.
    expect(
      items(h)
        .filter((i) => i.danger)
        .map((i) => i.label)
    ).toEqual(['Delete Group'])
    // Colour: Chrome's nine as radio items in their order, the group's own checked.
    const colour = h.shown().find((i) => i.label === 'Colour')!
    expect(colour.submenu?.map((i) => i.label)).toEqual(
      FOLDER_COLOR_ORDER.map((c) => FOLDER_COLOR_NAMES[c])
    )
    expect(colour.submenu?.every((i) => i.type === 'radio')).toBe(true)
    expect(colour.submenu?.filter((i) => i.checked).map((i) => i.label)).toEqual(['Blue'])
    click(colour.submenu!, 'Green')
    expect(h.browser.state.model.folders[folder].color).toBe('green')
  })

  it('Rename Group… asks the chrome to edit the name in place; Collapse and Expand fold the group; New Tab in Group joins one', () => {
    const h = harness('tablet', false)
    const { folder, a, b } = trip(h)
    h.browser.menus.showFolderContextMenu(folder, h.win)
    click(h.shown(), 'Rename Group…')
    expect(h.sent.filter((e) => e.name === 'folder.startRename').map((e) => e.payload)).toEqual([
      { folderId: folder }
    ])
    click(h.shown(), 'Collapse Group')
    expect(h.browser.state.model.folders[folder].collapsed).toBe(true)
    h.browser.menus.showFolderContextMenu(folder, h.win)
    expect(labels(h.shown())).toContain('Expand Group')
    click(h.shown(), 'Expand Group')
    expect(h.browser.state.model.folders[folder].collapsed).toBe(false)
    h.browser.menus.showFolderContextMenu(folder, h.win)
    click(h.shown(), 'New Tab in Group')
    const members = h.win
      .activeSpace()
      .tabIds.filter((id) => h.browser.tabs.tab(id)?.folderId === folder)
    expect(members).toHaveLength(3)
    expect(members.slice(0, 2)).toEqual([a, b])
  })

  it('Close Group leaves the group SAVED, whose menu leads with Open Group and has nothing to fold, ungroup or close', () => {
    const h = harness('tablet', false)
    const m = h.browser.state.model
    const { folder, a, b } = trip(h)
    h.browser.menus.showFolderContextMenu(folder, h.win)
    click(h.shown(), 'Close Group (2 Tabs)')
    expect(m.tabs[a]).toBeUndefined()
    expect(m.tabs[b]).toBeUndefined()
    expect(isSavedFolder(m, m.folders[folder])).toBe(true)
    expect(m.folders[folder].savedTabs?.map((t) => t.url)).toEqual([
      'https://a.test/',
      'https://b.test/'
    ])

    h.browser.menus.showFolderContextMenu(folder, h.win)
    expect(labels(h.shown())).toEqual([
      'Open Group (2 Tabs)',
      'Rename Group…',
      'Colour',
      'New Tab in Group',
      '-',
      'Delete Group'
    ])
    expect(
      items(h)
        .filter((i) => i.danger)
        .map((i) => i.label)
    ).toEqual(['Delete Group'])
    click(h.shown(), 'Open Group (2 Tabs)')
    expect(h.urls()).toEqual(['https://loose.test/', 'https://a.test/', 'https://b.test/'])
    expect(m.folders[folder].savedTabs ?? []).toEqual([])
    // Open again: the menu is the open group's, counting the pages that came back.
    h.browser.menus.showFolderContextMenu(folder, h.win)
    expect(labels(h.shown())).toContain('Close Group (2 Tabs)')
  })

  it('Ungroup keeps the tabs, loose; Delete Group closes them with the group; one member counts in the singular', () => {
    const h = harness('tablet', false)
    const m = h.browser.state.model
    const { folder, a, b } = trip(h)
    h.browser.menus.showFolderContextMenu(folder, h.win)
    click(h.shown(), 'Ungroup')
    expect(m.folders[folder]).toBeUndefined()
    expect(m.tabs[a].folderId).toBeNull()
    expect(m.tabs[b].folderId).toBeNull()
    expect(h.urls()).toEqual(['https://a.test/', 'https://b.test/', 'https://loose.test/'])

    const one = h.group('One')
    const c = h.open('https://c.test/', { folderId: one })
    h.browser.menus.showFolderContextMenu(one, h.win)
    expect(labels(h.shown())).toContain('Close Group (1 Tab)')
    click(h.shown(), 'Delete Group')
    expect(m.folders[one]).toBeUndefined()
    expect(m.tabs[c]).toBeUndefined()
  })

  it('is the desktop’s folder menu on a desktop window', () => {
    const h = harness('desktop', false)
    const { folder } = trip(h)
    h.browser.menus.showFolderContextMenu(folder, h.win)
    expect(labels(h.shown())).toContain('Edit Folder…')
    expect(labels(h.shown())).not.toContain('Rename Group…')
  })
})
