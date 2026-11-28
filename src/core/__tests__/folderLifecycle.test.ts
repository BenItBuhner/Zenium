import { describe, expect, it, vi } from 'vitest'
import { FOLDER_COLOR_ORDER } from '../../shared/defaults'
import type {
  FormFactor,
  HostCapabilities,
  Platform as PlatformOs,
  Suggestion
} from '../../shared/types'
import { NEW_FOLDER_NAME } from '../../shared/groupNames'
import { Browser } from '../browser'
import { closeBootTabs } from './bootTab'
import { isPrivateFolder } from '../model'
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
import type { ZenWindow } from '../window'

/**
 * Folders without saved groups: Close Folder closes the tabs and the folder stays; a folder an
 * older build saved is migrated; the link menu's "Open Link in New Tab in Folder" (TAB-15) for a
 * tab on a touch host; the one folder menu; private tabs in folders; the omnibox's group row.
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
  closeBootTabs(browser)
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

/**
 * Let the state broadcast of the tick go out, and the events queued behind it (`afterBroadcast`:
 * `folder.edit` names a fresh folder, so it waits for the commit's broadcast and flushes on the
 * next `setImmediate`). A read of `sent` before this sees none of them, whatever was asked.
 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

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

describe('a folder outlives its tabs (Zen has no saved groups)', () => {
  it('folder.close closes the tabs to Recently Closed and keeps the folder, empty and folded', () => {
    const h = harness()
    const m = h.browser.state.model
    const loose = h.open('https://loose.test/')
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    const b = h.open('https://b.test/', { folderId: folder })

    h.browser.handleCommand(h.win, 'folder.close', { folderId: folder })

    for (const id of [a, b]) expect(h.browser.tabs.tab(id)).toBeUndefined()
    expect(h.browser.tabs.tab(loose)).toBeDefined()
    expect(m.folders[folder]).toMatchObject({ name: 'Trip', color: 'blue', collapsed: true })
    expect(m.folders[folder]).not.toHaveProperty('savedTabs')
    expect(h.browser.state.recentlyClosed.filter((e) => e.kind === 'tab')).toHaveLength(2)
    // Its menu offers no Open Folder and nothing to close; New Tab in Folder fills it again.
    h.browser.menus.showFolderContextMenu(folder, h.win)
    const menu = labels(h.shown())
    expect(menu.some((l) => l.startsWith('Open Folder'))).toBe(false)
    expect(menu.some((l) => l.startsWith('Close Folder'))).toBe(false)
    const made = h.browser.newTabInFolder(folder, h.win)
    expect(m.tabs[made].folderId).toBe(folder)
    expect(m.folders[folder].collapsed).toBe(false)
  })

  it('the last tab closing leaves the folder where it was, with no pages kept', () => {
    const h = harness()
    const m = h.browser.state.model
    h.open('https://loose.test/')
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    h.browser.tabs.closeTab(a, true, h.win)
    expect(m.folders[folder]).toBeDefined()
    expect(m.folders[folder]).not.toHaveProperty('savedTabs')
  })

  it('a folder an older build saved comes back with its pages as unloaded tabs when the session continues', () => {
    const h = harness()
    const m = h.browser.state.model
    h.open('https://loose.test/')
    const folder = h.group('Trip')
    Object.assign(m.folders[folder], {
      savedTabs: [
        { url: 'https://a.test/', title: 'A page', favicon: null },
        { url: 'https://b.test/', title: '' }
      ],
      lastUsedAt: 5
    })
    h.browser.state.migrateSavedFolders(true)
    expect(m.folders[folder]).not.toHaveProperty('savedTabs')
    expect(m.folders[folder].collapsed).toBe(true)
    const members = Object.values(m.tabs).filter((t) => t.folderId === folder)
    expect(members.map((t) => [t.url, t.discarded])).toEqual([
      ['https://a.test/', true],
      ['https://b.test/', true]
    ])
    expect(members[0].title).toBe('A page')
    expect(h.urls()).toContain('https://b.test/')
  })

  it('a saved folder whose session is forgotten at launch keeps its pages as a bookmarks folder', () => {
    const h = harness()
    const m = h.browser.state.model
    const folder = h.group('Trip')
    Object.assign(m.folders[folder], { savedTabs: [{ url: 'https://a.test/', title: 'A page' }] })
    h.browser.state.migrateSavedFolders(false)
    expect(m.folders[folder]).not.toHaveProperty('savedTabs')
    expect(Object.values(m.tabs).some((t) => t.folderId === folder)).toBe(false)
    const kept = h.browser.state.bookmarks.find((n) => n.type === 'folder' && n.title === 'Trip')
    expect(kept).toBeDefined()
    expect(
      h.browser.state.bookmarks.filter((n) => n.parentId === kept?.id).map((n) => n.url)
    ).toEqual(['https://a.test/'])
  })
})

describe('the link menu’s group item (TAB-15)', () => {
  const url = 'https://linked.test/'

  it('offers Open Link in New Tab in Folder for a tab in a group, on a touch host: the phone’s second row, behind Open Link in New Tab (Chrome 152’s pair), the private row third', () => {
    const h = harness('phone')
    const m = h.browser.state.model
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    h.open('https://b.test/', { folderId: folder })
    const loose = h.open('https://loose.test/')
    h.browser.tabs.activateTab(a, h.win)

    h.browser.menus.showPageContextMenu(a, linkParams(url), h.win)
    const menu = labels(h.shown())
    expect(menu.indexOf('Open Link in New Tab')).toBe(0)
    expect(menu.indexOf('Open Link in New Tab in Folder')).toBe(1)
    expect(menu.indexOf('Open Link in Private Tab')).toBe(2)

    // In the group, behind the current tab, in the background.
    click(h.shown(), 'Open Link in New Tab in Folder')
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

    // A loose tab keeps the pair in the same order – its group row makes the group (PUI-17,
    // below) – and the plain item joins nothing.
    h.browser.menus.showPageContextMenu(loose, linkParams('https://from-loose.test/'), h.win)
    expect(labels(h.shown()).slice(0, 2)).toEqual([
      'Open Link in New Tab',
      'Open Link in New Tab in Folder'
    ])
    click(h.shown(), 'Open Link in New Tab')
    expect(
      Object.values(m.tabs).find((t) => t.url === 'https://from-loose.test/')?.folderId
    ).toBeNull()
    expect(m.tabs[loose].folderId).toBeNull()
  })

  it('makes the group for a tab in none: the opener and the new tab, a group of two (PUI-17)', async () => {
    const h = harness('phone')
    const m = h.browser.state.model
    const other = h.open('https://other.test/')
    const loose = h.open('https://loose.test/')
    const before = Object.keys(m.folders)
    h.browser.menus.showPageContextMenu(loose, linkParams(url), h.win)
    // The phone's second row, right behind Open Link in New Tab (the lead's order, below).
    expect(labels(h.shown()).indexOf('Open Link in New Tab in Folder')).toBe(1)

    click(h.shown(), 'Open Link in New Tab in Folder')
    const made = Object.keys(m.folders).filter((id) => !before.includes(id))
    expect(made).toHaveLength(1)
    const folder = m.folders[made[0]]
    // Named by the touch hosts' shared default (§6: a group a touch host makes is named
    // "Group", never "New Folder"), as the tab menu's Add Tab to New Folder names its own on
    // this host – coloured as that row colours its own, open, and with no editor over it: the
    // row is the gesture.
    expect(folder).toMatchObject({
      name: NEW_FOLDER_NAME,
      icon: '📁',
      spaceId: h.win.activeSpaceId,
      collapsed: false
    })
    expect(FOLDER_COLOR_ORDER).toContain(folder.color)
    // The editor's `folder.edit` would go out behind the commit's broadcast, on the next tick:
    // the tick is let go first, so a folder that had asked for its editor would have sent it.
    await tick()
    expect(h.sent.map((e) => e.name)).not.toContain('folder.edit')
    // Both in it – the opener kept its slot, the new tab behind it in the background – and
    // the tab beside them left out.
    const opened = Object.values(m.tabs).find((t) => t.url === url)!
    expect(m.tabs[loose].folderId).toBe(folder.id)
    expect(opened.folderId).toBe(folder.id)
    expect(opened.openerTabId).toBe(loose)
    expect(m.tabs[other].folderId).toBeNull()
    expect(h.urls()).toEqual(['https://other.test/', 'https://loose.test/', url])
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(loose)

    // The opener is in a group now: the row's next open joins that group (TAB-15), makes none.
    h.browser.menus.showPageContextMenu(loose, linkParams('https://third.test/'), h.win)
    click(h.shown(), 'Open Link in New Tab in Folder')
    expect(Object.keys(m.folders)).toHaveLength(before.length + 1)
    expect(Object.values(m.tabs).find((t) => t.url === 'https://third.test/')?.folderId).toBe(
      folder.id
    )
    // Behind the first, as consecutive background opens from one page keep their order.
    expect(h.urls()).toEqual([
      'https://other.test/',
      'https://loose.test/',
      url,
      'https://third.test/'
    ])
  })

  it('offers no group to make for a tab the groups skip: an essential, a pinned or a private one', () => {
    const h = harness('phone')
    const m = h.browser.state.model
    const { tabs } = h.browser
    const essential = tabs.createTab({ url: 'https://e.test/', essential: true }, h.win).id
    const pinned = tabs.createTab({ url: 'https://p.test/', pinned: true }, h.win).id
    const priv = tabs.newPrivateTab('https://priv.test/', h.win)!
    expect(tabs.isPrivate(m.tabs[priv])).toBe(true)
    const folders = Object.keys(m.folders).length
    for (const id of [essential, pinned, priv]) {
      h.browser.menus.showPageContextMenu(id, linkParams(url), h.win)
      const menu = labels(h.shown())
      expect(menu).not.toContain('Open Link in New Tab in Folder')
      expect(menu.indexOf('Open Link in New Tab')).toBe(0)
    }
    expect(Object.keys(m.folders)).toHaveLength(folders)
  })

  it('lists the phone’s rows in the lead’s order – Chrome 152’s within Zenium’s groups: New Tab · New Tab in Folder · Private Tab · Glance · Container | Copy Link Address · Copy Link Text · Save Link As… · Share Link… | Boosts', () => {
    // The design gate's ruling on #492's (b): Chrome for Android 152 seats "Open in new tab"
    // before "Open in new tab in group" and "Download link" after the two copies; the phone
    // follows it and keeps Zenium's three groups with their hairlines. Pinned whole. Share
    // Link… is the group's last row: the hand-off out of the app (#492's rule).
    const h = harness('phone')
    const loose = h.open('https://loose.test/')
    h.browser.menus.showPageContextMenu(loose, { ...linkParams(url), linkText: 'Linked' }, h.win)
    expect(labels(h.shown())).toEqual([
      'Open Link in New Tab',
      'Open Link in New Tab in Folder',
      'Open Link in Private Tab',
      'Open Link in Glance',
      'Open Link in New Container Tab',
      '-',
      'Copy Link Address',
      'Copy Link Text',
      'Save Link As…',
      'Share Link…',
      '-',
      'Boosts',
      // The harness's stubbed capabilities offer devtools; the device's (off) draw no such row.
      'Inspect Element'
    ])
    // A host without private tabs (a WebView keeping no profiles) leaves the private row out,
    // the rest as they are; a link whose text is its address has no Copy Link Text.
    const g = harness('phone', false)
    const onG = g.open('https://loose.test/')
    g.browser.menus.showPageContextMenu(onG, linkParams(url), g.win)
    expect(labels(g.shown())).toEqual([
      'Open Link in New Tab',
      'Open Link in New Tab in Folder',
      'Open Link in Glance',
      'Open Link in New Container Tab',
      '-',
      'Copy Link Address',
      'Save Link As…',
      'Share Link…',
      '-',
      'Boosts',
      'Inspect Element'
    ])
  })

  it('lists the tablet’s rows in the lead’s order too – one link menu on both touch hosts: New Tab · New Tab in Folder · Private Tab · Glance · Split View · Container | Copy Link Address · Copy Link Text · Save Link As… · Share Link… | Boosts', () => {
    // The design lead's ruling after #492: the tablet's link menu takes the phone's ruled order,
    // the hairlines kept. Split View is the tablet's own row (the phone draws no panes) and
    // keeps its seat between Glance and Container. Pinned whole.
    const t = harness('tablet')
    const onTablet = t.open('https://loose.test/')
    t.browser.menus.showPageContextMenu(onTablet, { ...linkParams(url), linkText: 'Linked' }, t.win)
    expect(labels(t.shown())).toEqual([
      'Open Link in New Tab',
      'Open Link in New Tab in Folder',
      'Open Link in Private Tab',
      'Open Link in Glance',
      'Open Link in Split View',
      'Open Link in New Container Tab',
      '-',
      'Copy Link Address',
      'Copy Link Text',
      'Save Link As…',
      'Share Link…',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    // A tablet whose WebView keeps no profiles leaves the private row out, the rest as they
    // are; a link whose text is its address has no Copy Link Text.
    const g = harness('tablet', false)
    const onG = g.open('https://loose.test/')
    g.browser.menus.showPageContextMenu(onG, linkParams(url), g.win)
    expect(labels(g.shown())).toEqual([
      'Open Link in New Tab',
      'Open Link in New Tab in Folder',
      'Open Link in Glance',
      'Open Link in Split View',
      'Open Link in New Container Tab',
      '-',
      'Copy Link Address',
      'Save Link As…',
      'Share Link…',
      '-',
      'Boosts',
      'Inspect Element'
    ])
  })

  it('on the tablet a private opener gets no group row (#492’s limit) and a tab in a group gets the pair in the ruled order', () => {
    // A private tab on the tablet: the plain row leads, no group row is made for it.
    const t = harness('tablet')
    const priv = t.browser.tabs.newPrivateTab('https://priv.test/', t.win)!
    t.browser.menus.showPageContextMenu(priv, linkParams(url), t.win)
    const menu = labels(t.shown())
    expect(menu.indexOf('Open Link in New Tab')).toBe(0)
    expect(menu).not.toContain('Open Link in New Tab in Folder')
    // A tablet tab in a group: the pair in the ruled order, the group row right under the plain.
    const folder = t.group('Trip')
    const a = t.open('https://a.test/', { folderId: folder })
    t.browser.menus.showPageContextMenu(a, linkParams(url), t.win)
    const grouped = labels(t.shown())
    expect(grouped.indexOf('Open Link in New Tab')).toBe(0)
    expect(grouped.indexOf('Open Link in New Tab in Folder')).toBe(1)
  })

  it('leaves the desktop menu for a tab in no group as it was: Chrome desktop’s one item, byte for byte', () => {
    const d = harness('desktop', false)
    const m = d.browser.state.model
    const onDesktop = d.open('https://loose.test/')
    d.browser.menus.showPageContextMenu(onDesktop, linkParams(url), d.win)
    expect(labels(d.shown())).toEqual([
      'Open Link in New Tab',
      'Open Link in New Window',
      'Open Link in New Private Window',
      'Open Link in Glance',
      'Open Link in Split View',
      'Open Link in New Container Tab',
      '-',
      'Save Link As…',
      'Copy Link Address',
      'Share Link…',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    click(d.shown(), 'Open Link in New Tab')
    expect(Object.values(m.tabs).find((t) => t.url === url)?.folderId).toBeNull()
    expect(Object.keys(m.folders)).toHaveLength(0)
  })

  it('stays off the desktop menu, whose one item keeps joining the group', () => {
    const h = harness('desktop', false)
    const m = h.browser.state.model
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    h.browser.menus.showPageContextMenu(a, linkParams(url), h.win)
    expect(labels(h.shown())).not.toContain('Open Link in New Tab in Folder')
    click(h.shown(), 'Open Link in New Tab')
    expect(Object.values(m.tabs).find((t) => t.url === url)?.folderId).toBe(folder)
  })
})

describe('one folder menu on every host', () => {
  const trip = (h: Harness): { folder: string; a: string; b: string } => {
    const folder = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: folder })
    const b = h.open('https://b.test/', { folderId: folder })
    h.open('https://loose.test/')
    return { folder, a, b }
  }

  it('Close Folder (N Tabs) emits folder.closeUndoable with the group’s id and closes nothing itself (TAB-16, option C)', () => {
    const h = harness('tablet', false)
    const m = h.browser.state.model
    const { folder, a, b } = trip(h)
    const closeFolder = vi.spyOn(h.browser, 'closeFolder')
    h.browser.menus.showFolderContextMenu(folder, h.win)
    h.sent.length = 0
    click(h.shown(), 'Close Folder (2 Tabs)')
    expect(h.sent.map((e) => [e.name, e.payload])).toEqual([
      ['folder.closeUndoable', { folderId: folder }]
    ])
    // The core's close is the chrome's to ask for (`folder.close`), once its undo is armed.
    expect(closeFolder).not.toHaveBeenCalled()
    expect(m.tabs[a]).toBeDefined()
    expect(m.tabs[b]).toBeDefined()
    // Ungroup and Delete Group keep their paths: the core's own, and the ask.
    h.browser.menus.showFolderContextMenu(folder, h.win)
    h.sent.length = 0
    click(h.shown(), 'Delete Folder')
    expect(h.sent.map((e) => e.name)).toEqual(['folder.confirmDelete'])
    h.browser.menus.showFolderContextMenu(folder, h.win)
    click(h.shown(), 'Unpack Folder')
    expect(m.folders[folder]).toBeUndefined()
    expect(m.tabs[a]?.folderId ?? null).toBeNull()
    expect(h.sent.filter((e) => e.name === 'folder.closeUndoable')).toEqual([])
  })

  it('is the same menu on the tablet and the desktop, with no Group word in it', () => {
    const rows = (formFactor: 'tablet' | 'desktop'): string[] => {
      const h = harness(formFactor, false)
      const { folder } = trip(h)
      h.browser.menus.showFolderContextMenu(folder, h.win)
      return labels(h.shown())
    }
    expect(rows('tablet')).toEqual(rows('desktop'))
    expect(rows('tablet')).toContain('Edit Folder…')
    expect(rows('tablet').some((l) => /Group/.test(l))).toBe(false)
  })

  it('the desktop’s Close Folder (N Tabs) calls the core’s closeFolder itself and emits no folder.closeUndoable (the touch hosts’ path is theirs alone)', () => {
    const h = harness('desktop', false)
    const m = h.browser.state.model
    const { folder, a, b } = trip(h)
    const closeFolder = vi.spyOn(h.browser, 'closeFolder')
    h.browser.menus.showFolderContextMenu(folder, h.win)
    h.sent.length = 0
    click(h.shown(), 'Close Folder (2 Tabs)')
    // The pin that fails should `showFolderContextMenu`'s Close Folder stop calling `closeFolder`:
    // the core closes the folder at the click, no event asks the chrome to.
    expect(closeFolder).toHaveBeenCalledTimes(1)
    expect(closeFolder).toHaveBeenCalledWith(folder, h.win)
    expect(h.sent.filter((e) => e.name === 'folder.closeUndoable')).toEqual([])
    expect(m.tabs[a]).toBeUndefined()
    expect(m.tabs[b]).toBeUndefined()
    expect(m.folders[folder]).toMatchObject({ collapsed: true })
  })
})

describe('private browsing and the space’s groups (a private group named on no regular surface)', () => {
  /**
   * "Move Tab ▸ Move to Folder ▸" – "Move to Group ▸" on a touch host (TABLET-22): the folders a
   * menu offers, by label.
   */
  const foldersOffered = (items: MenuItemTemplate[]): string[] => {
    const move = items.find((i) => i.label === 'Move Tab')?.submenu ?? []
    const into =
      move.find((i) => i.label === 'Move to Group' || i.label === 'Move to Folder')?.submenu ?? []
    return labels(into).filter((l) => l !== '-' && l !== 'New Group…' && l !== 'New Folder…')
  }

  it('PRIVATE-BROWSING LEAK, fixed: a regular tab’s menu names no group that private tabs alone fill; a private tab’s names every folder of its space', () => {
    const h = harness('tablet')
    const m = h.browser.state.model
    const trip = h.group('Trip')
    const ghost = h.group('Ghost')
    const regular = h.open('https://a.test/', { folderId: trip })
    const loose = h.open('https://loose.test/')
    // A private tab dropped into Ghost on the tablet's sidebar (`dropTab` has no private guard):
    // Ghost is now a PRIVATE group – private tabs alone live in it, nothing saved.
    const p = h.browser.tabs.newPrivateTab('https://p.test/', h.win)!
    expect(h.browser.tabs.dropTab(p, `folder:${ghost}`, h.win)).toBe(true)
    expect(m.tabs[p].folderId).toBe(ghost)
    expect(isPrivateFolder(m, m.folders[ghost])).toBe(true)
    expect(isPrivateFolder(m, m.folders[trip])).toBe(false)

    // A regular tab's menu: Trip to move to, Ghost's name nowhere in the template.
    h.browser.menus.showTabContextMenu(loose, h.win)
    expect(foldersOffered(h.shown())).toEqual(['📁 Trip'])
    expect(JSON.stringify(h.shown())).not.toContain('Ghost')
    // A selection with a regular tab in it: the same.
    h.browser.menus.showSelectionContextMenu([loose, regular], h.win)
    expect(JSON.stringify(h.shown())).not.toContain('Ghost')
    // The private tab's own menu is inside private mode: every folder of the space, its own too.
    h.browser.menus.showTabContextMenu(p, h.win)
    expect(foldersOffered(h.shown())).toEqual(['📁 Trip', '📁 Ghost'])

    // A regular tab joining Ghost makes it a regular group again, named to every tab's menu;
    // the private member stays no part of the pane's count (the renderer's `regularMembers`).
    h.browser.tabs.moveToFolder(loose, ghost)
    expect(isPrivateFolder(m, m.folders[ghost])).toBe(false)
    h.browser.menus.showTabContextMenu(regular, h.win)
    expect(foldersOffered(h.shown())).toEqual(['📁 Trip', '📁 Ghost'])
  })

  it('a private tab in a group is no member of it for the regular profile: it neither counts nor marks it used, and Close Group, Delete Group and New Tab in Group leave it be', () => {
    const h = harness('tablet')
    const m = h.browser.state.model
    const trip = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: trip })
    h.open('https://b.test/', { folderId: trip })
    h.open('https://loose.test/')

    // Close Group with a private tab in it: the regular members close, the private tab – none
    // of the group's "2 Tabs" – stays open where it was.
    const attached = h.browser.tabs.newPrivateTab('https://p.test/', h.win)!
    h.browser.tabs.moveToFolder(attached, trip)
    h.browser.menus.showFolderContextMenu(trip, h.win)
    expect(labels(h.shown())).toContain('Close Folder (2 Tabs)')
    // The pick asks the chrome for the undoable close (`folder.closeUndoable`); the chrome
    // answers with the core's `folder.close`, whose count is the regular members'.
    h.sent.length = 0
    click(h.shown(), 'Close Folder (2 Tabs)')
    expect(h.sent.map((e) => [e.name, e.payload])).toEqual([
      ['folder.closeUndoable', { folderId: trip }]
    ])
    h.browser.handleCommand(h.win, 'folder.close', { folderId: trip })
    expect(m.tabs[a]).toBeUndefined()
    expect(m.tabs[attached]?.folderId).toBe(trip)
    expect(m.folders[trip]).toMatchObject({ name: 'Trip', collapsed: true })
    expect(isPrivateFolder(m, m.folders[trip])).toBe(true)
    const lastUsed = m.folders[trip].lastUsedAt

    // A private tab viewed in it and closing from it leaves the folder's last use as it was –
    // no trace of the private session on it.
    const q = h.browser.tabs.newPrivateTab('https://q.test/', h.win)!
    h.browser.tabs.moveToFolder(q, trip)
    h.browser.tabs.activateTab(q, h.win)
    expect(m.folders[trip].lastUsedAt).toBe(lastUsed)
    h.browser.tabs.closeTab(q, true, h.win)
    expect(m.folders[trip].lastUsedAt).toBe(lastUsed)

    // Open Folder has no regular tab to show: the private one is not brought into view.
    expect(h.browser.openFolder(trip, h.win)).toBeNull()
    const opened = h.open('https://c.test/', { folderId: trip })

    // New Tab in Group makes a regular tab of the space, after the last regular member, though
    // the private tab sits last in the group.
    h.browser.tabs.moveTab(
      attached,
      { spaceId: h.win.activeSpaceId, section: 'regular', index: Number.MAX_SAFE_INTEGER },
      h.win
    )
    const made = h.browser.newTabInFolder(trip, h.win)
    expect(h.browser.tabs.isPrivate(m.tabs[made])).toBe(false)
    expect(m.tabs[made].containerId).toBe(m.tabs[opened].containerId)
    expect(m.tabs[made].folderId).toBe(trip)

    // Delete Group closes the group's regular tabs; the private tab, ungrouped, stays open.
    h.browser.deleteFolder(trip, false)
    expect(m.folders[trip]).toBeUndefined()
    expect(m.tabs[opened]).toBeUndefined()
    expect(m.tabs[made]).toBeUndefined()
    expect(m.tabs[attached]).toBeDefined()
    expect(m.tabs[attached].folderId).toBeNull()
  })

  it('touches no desktop menu: a private window’s menus offer no folder, a regular window’s space holds no private tab', () => {
    const h = harness('desktop', false)
    const m = h.browser.state.model
    const trip = h.group('Trip')
    const a = h.open('https://a.test/', { folderId: trip })
    const loose = h.open('https://loose.test/')
    // No private tab reaches a regular space on the desktop: private browsing is a window of its
    // own, whose tabs live in its own space (`newPrivateTab` is the tab hosts' alone).
    expect(h.browser.tabs.newPrivateTab('https://p.test/', h.win)).toBeNull()
    expect(Object.values(m.tabs).some((t) => h.browser.tabs.isPrivate(t))).toBe(false)
    expect(Object.values(m.folders).some((f) => isPrivateFolder(m, f))).toBe(false)
    h.browser.menus.showTabContextMenu(loose, h.win)
    expect(foldersOffered(h.shown())).toEqual(['📁 Trip'])
    h.browser.menus.showTabContextMenu(a, h.win)
    expect(foldersOffered(h.shown())).toEqual(['📁 Trip'])
  })
})

describe('the omnibox’s tab group row (OMN-15)', () => {
  it('typing a group’s name offers the group, and its pick opens it as the pane’s Open does', async () => {
    const h = harness()
    const m = h.browser.state.model
    const trip = h.group('Trip')
    const a = h.open('https://hotel.test/booking', { folderId: trip })
    h.open('https://flights.test/', { folderId: trip })
    const loose = h.open('https://loose.test/')
    h.browser.updateFolder(trip, { collapsed: true })
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(loose)
    // The local sources alone: no engine, answer or intranet lookups from this harness's host.
    h.browser.state.settings.searchSuggestions = false
    h.browser.platform.net.resolveHost = undefined

    const rows = (await h.browser.handleCommand(h.win, 'urlbar.suggest', {
      query: 'tri',
      tabId: loose,
      grouped: true
    })) as Suggestion[]
    const row = rows.find((r) => r.kind === 'folder')!
    expect(row).toMatchObject({
      title: 'Trip',
      subtitle: 'hotel.test, flights.test',
      targetId: trip,
      group: 'Tabs and tab groups'
    })
    // The pick is the group's Open (`folder.open`): unfolded, its first tab shown, used now.
    expect(h.browser.handleCommand(h.win, 'folder.open', { folderId: row.targetId! })).toBe(a)
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(a)
    expect(m.folders[trip].collapsed).toBe(false)
    expect(typeof m.folders[trip].lastUsedAt).toBe('number')

    // A folder whose tabs closed has no pages to offer.
    h.browser.handleCommand(h.win, 'folder.close', { folderId: trip })
    const closed = (await h.browser.handleCommand(h.win, 'urlbar.suggest', {
      query: 'hotel',
      tabId: loose,
      grouped: true
    })) as Suggestion[]
    expect(closed.find((r) => r.kind === 'folder')).toBeUndefined()
  })
})
