import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { FOLDER_COLOR_ORDER } from '../../shared/defaults'
import { Browser } from '../browser'
import type {
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/**
 * Folders are Zenium's tab groups (tabs-13/14, context-menus-91, session-22): the group editor
 * bubble on the desktop drives `folder.update` / `folder.newTab` / `folder.delete`, the tab and
 * folder menus carry Chrome's grouping items, and the core colours a new group as Chrome does.
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

interface Harness {
  browser: Browser
  win: ZenWindow
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
  /** The events sent to the window's chrome, in order, as `name` with their payload. */
  sent: Array<{ name: string; payload: unknown }>
  /** A regular tab in the window's space. */
  open: (url: string, opts?: { folderId?: string; containerId?: string }) => string
}

function harness(): Harness {
  let last: MenuItemTemplate[] = []
  const sent: Harness['sent'] = []
  const menus: MenuHost = {
    popup: (items) => {
      last = items
    }
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
    io: memoryIo(),
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
          send: (name, payload) => void sent.push({ name, payload })
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({ isDestroyed: () => false, isVisible: () => false, getZoom: () => 1 })
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
  return {
    browser,
    win,
    shown: () => last,
    sent,
    open: (url, opts = {}) => browser.tabs.createTab({ url, active: true, ...opts }, win).id
  }
}

/** Labels in order, separators as `-`, submenus flattened one level as `Parent > Child`. */
function labels(items: MenuItemTemplate[]): string[] {
  return items.flatMap((item) => {
    if (item.type === 'separator') return ['-']
    const label = item.label ?? ''
    return item.submenu
      ? [label, ...item.submenu.map((sub) => `${label} > ${sub.label ?? '-'}`)]
      : [label]
  })
}

function item(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no "${label}" in ${labels(items).join(', ')}`)
  return found
}

/** The tab row's moves live under Firefox's "Move Tab ▸" (v2 §6 Menus). */
function moveTab(items: MenuItemTemplate[]): MenuItemTemplate[] {
  return item(items, 'Move Tab').submenu!
}

const palette = FOLDER_COLOR_ORDER
const events = (h: Harness, name: string): unknown[] =>
  h.sent.filter((e) => e.name === name).map((e) => e.payload)
/** Let the state broadcast of the tick go out (and the events queued behind it). */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('making a folder (tab group)', () => {
  it('folder.create colours the group with the next free colour and opens its editor', async () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const first = h.browser.handleCommand(h.win, 'folder.create', {
      spaceId: space,
      name: 'Research',
      icon: '📁'
    }) as string
    expect(h.browser.state.model.folders[first]).toMatchObject({
      name: 'Research',
      color: palette[0],
      collapsed: false
    })
    // The editor hangs from the folder's header: the event waits for the state that holds it.
    expect(events(h, 'folder.edit')).toEqual([])
    await tick()
    expect(events(h, 'folder.edit')).toEqual([{ folderId: first }])
    const stateAt = h.sent.findIndex((e) => e.name === 'state')
    const editAt = h.sent.findIndex((e) => e.name === 'folder.edit')
    expect(stateAt).toBeGreaterThanOrEqual(0)
    expect(editAt).toBeGreaterThan(stateAt)
    expect(events(h, 'folder.startRename')).toEqual([])
    const second = h.browser.handleCommand(h.win, 'folder.create', {
      spaceId: space,
      name: 'More',
      icon: '📁',
      rename: false
    }) as string
    expect(h.browser.state.model.folders[second].color).toBe(palette[1])
    await tick()
    expect(events(h, 'folder.edit')).toEqual([{ folderId: first }])
  })

  it('keeps a colour the caller picked', () => {
    const h = harness()
    const id = h.browser.handleCommand(h.win, 'folder.create', {
      spaceId: h.win.activeSpaceId,
      name: 'Pink',
      icon: '📁',
      color: 'pink'
    }) as string
    expect(h.browser.state.model.folders[id].color).toBe('pink')
  })

  it('Add Tab to New Folder wraps the tab in a coloured folder and opens the editor', async () => {
    const h = harness()
    const tab = h.open('https://a.test/')
    h.browser.newFolderWithTab(h.win.activeSpaceId, tab, h.win)
    const folders = Object.values(h.browser.state.model.folders)
    expect(folders).toHaveLength(1)
    expect(folders[0]).toMatchObject({ name: 'New Folder', color: palette[0] })
    expect(h.browser.tabs.tab(tab)?.folderId).toBe(folders[0].id)
    await tick()
    expect(events(h, 'folder.edit')).toEqual([{ folderId: folders[0].id }])
  })
})

describe('the folder’s state', () => {
  it('folder.update sets the name, colour and collapsed state, and a blank name falls back', () => {
    const h = harness()
    const id = h.browser.createFolder(h.win.activeSpaceId, 'Docs', '📁', h.win, {
      rename: false
    }).id
    h.browser.handleCommand(h.win, 'folder.update', {
      folderId: id,
      patch: { name: 'Papers', color: 'cyan', collapsed: true }
    })
    expect(h.browser.state.model.folders[id]).toMatchObject({
      name: 'Papers',
      color: 'cyan',
      collapsed: true
    })
    h.browser.handleCommand(h.win, 'folder.update', { folderId: id, patch: { name: '   ' } })
    expect(h.browser.state.model.folders[id].name).toBe('Folder')
    // A folder that is gone is left alone rather than resurrected.
    h.browser.handleCommand(h.win, 'folder.update', {
      folderId: 'folder:gone',
      patch: { name: 'x' }
    })
    expect(h.browser.state.model.folders['folder:gone']).toBeUndefined()
  })

  it('folder.newTab opens an active new tab at the end of the folder, in its last member’s container, and unfolds it', () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const loose = h.open('https://loose.test/')
    const folder = h.browser.createFolder(space, 'Docs', '📁', h.win, { rename: false })
    const a = h.open('https://a.test/', { folderId: folder.id })
    const b = h.open('https://b.test/', { folderId: folder.id, containerId: 'work' })
    const after = h.open('https://after.test/')
    h.browser.updateFolder(folder.id, { collapsed: true })
    const created = h.browser.handleCommand(h.win, 'folder.newTab', {
      folderId: folder.id
    }) as string
    const tab = h.browser.tabs.tab(created)!
    expect(tab.folderId).toBe(folder.id)
    expect(tab.spaceId).toBe(space)
    expect(tab.containerId).toBe('work')
    expect(h.win.activeSpace().tabIds).toEqual([loose, a, b, created, after])
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(created)
    expect(h.browser.state.model.folders[folder.id].collapsed).toBe(false)
    expect(() => h.browser.newTabInFolder('folder:gone', h.win)).toThrow('Folder not found')
  })

  it('unpacking keeps the tabs and closing sends them to the recently closed list', () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const unpacked = h.browser.createFolder(space, 'Keep', '📁', h.win, { rename: false })
    const kept = h.open('https://kept.test/', { folderId: unpacked.id })
    h.browser.handleCommand(h.win, 'folder.delete', { folderId: unpacked.id, unpack: true })
    expect(h.browser.state.model.folders[unpacked.id]).toBeUndefined()
    expect(h.browser.tabs.tab(kept)?.folderId).toBeNull()
    expect(h.browser.state.recentlyClosed).toEqual([])

    const closed = h.browser.createFolder(space, 'Go', '📁', h.win, { rename: false })
    const x = h.open('https://x.test/', { folderId: closed.id })
    const y = h.open('https://y.test/', { folderId: closed.id })
    h.browser.handleCommand(h.win, 'folder.delete', { folderId: closed.id, unpack: false })
    expect(h.browser.state.model.folders[closed.id]).toBeUndefined()
    expect(h.browser.tabs.tab(x)).toBeUndefined()
    expect(h.browser.tabs.tab(y)).toBeUndefined()
    expect(h.browser.tabs.tab(kept)).toBeDefined()
    expect(
      h.browser.state.recentlyClosed.map((e) => (e.kind === 'tab' ? e.tab.url : e.kind)).sort()
    ).toEqual(['https://x.test/', 'https://y.test/'])
  })
})

describe('the tab menu’s group items (context-menus-91)', () => {
  it('offers Add Tab to New Folder while the space has no folder', () => {
    const h = harness()
    const tab = h.open('https://a.test/')
    h.browser.menus.showTabContextMenu(tab, h.win)
    const shown = labels(moveTab(h.shown()))
    expect(shown).toContain('Add Tab to New Folder')
    expect(shown).not.toContain('Move to Folder')
    expect(shown).not.toContain('Remove from Folder')
    item(moveTab(h.shown()), 'Add Tab to New Folder').click!()
    expect(h.browser.tabs.tab(tab)?.folderId).toBe(Object.keys(h.browser.state.model.folders)[0])
  })

  it('lists the space’s folders under Move to Folder with the tab’s own checked, and Remove from Folder', () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const docs = h.browser.createFolder(space, 'Docs', '📁', h.win, { rename: false })
    const play = h.browser.createFolder(space, 'Play', '🎮', h.win, { rename: false })
    const tab = h.open('https://a.test/', { folderId: docs.id })
    h.browser.menus.showTabContextMenu(tab, h.win)
    const shown = labels(moveTab(h.shown()))
    expect(shown).toEqual(
      expect.arrayContaining([
        'Move to Folder',
        'Move to Folder > New Folder…',
        'Move to Folder > -',
        'Move to Folder > 📁 Docs',
        'Move to Folder > 🎮 Play',
        'Remove from Folder'
      ])
    )
    expect(shown).not.toContain('Add Tab to New Folder')
    const submenu = item(moveTab(h.shown()), 'Move to Folder').submenu!
    expect(submenu.find((i) => i.label === '📁 Docs')).toMatchObject({
      type: 'checkbox',
      checked: true
    })
    expect(submenu.find((i) => i.label === '🎮 Play')).toMatchObject({
      type: 'checkbox',
      checked: false
    })
    submenu.find((i) => i.label === '🎮 Play')!.click!()
    expect(h.browser.tabs.tab(tab)?.folderId).toBe(play.id)
    h.browser.menus.showTabContextMenu(tab, h.win)
    item(moveTab(h.shown()), 'Remove from Folder').click!()
    expect(h.browser.tabs.tab(tab)?.folderId).toBeNull()
    h.browser.menus.showTabContextMenu(tab, h.win)
    expect(labels(moveTab(h.shown()))).not.toContain('Remove from Folder')
  })

  it('greys the group items for a pinned tab, which cannot join a folder', () => {
    const h = harness()
    const tab = h.open('https://a.test/')
    h.browser.tabs.togglePin(tab, h.win)
    h.browser.menus.showTabContextMenu(tab, h.win)
    expect(item(moveTab(h.shown()), 'Add Tab to New Folder').enabled).toBe(false)
  })
})

describe('the folder header menu (tabs-13)', () => {
  it('has Chrome’s group items around Zenium’s live folder ones', () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const folder = h.browser.createFolder(space, 'Docs', '📁', h.win, { rename: false })
    h.open('https://a.test/', { folderId: folder.id })
    h.open('https://b.test/', { folderId: folder.id })
    h.browser.menus.showFolderContextMenu(folder.id, h.win)
    expect(labels(h.shown())).toEqual([
      'Edit Folder…',
      'Rename Folder…',
      'New Tab in Folder',
      'Collapse Folder',
      '-',
      'Make Live Folder…',
      '-',
      'Unpack Folder',
      'Close Folder (2 Tabs)',
      'Delete Folder'
    ])
    h.sent.length = 0
    item(h.shown(), 'Edit Folder…').click!()
    expect(events(h, 'folder.edit')).toEqual([{ folderId: folder.id }])
    item(h.shown(), 'Collapse Folder').click!()
    expect(h.browser.state.model.folders[folder.id].collapsed).toBe(true)
    h.browser.menus.showFolderContextMenu(folder.id, h.win)
    expect(labels(h.shown())).toContain('Expand Folder')
  })

  it('reads Close Folder (1 Tab) for one member and Delete Folder for none', () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const one = h.browser.createFolder(space, 'One', '📁', h.win, { rename: false })
    h.open('https://a.test/', { folderId: one.id })
    h.browser.menus.showFolderContextMenu(one.id, h.win)
    expect(labels(h.shown())).toContain('Close Folder (1 Tab)')
    const empty = h.browser.createFolder(space, 'Empty', '📁', h.win, { rename: false })
    h.browser.menus.showFolderContextMenu(empty.id, h.win)
    expect(labels(h.shown())).toContain('Delete Folder')
    item(h.shown(), 'Delete Folder').click!()
    expect(h.browser.state.model.folders[empty.id]).toBeUndefined()
  })

  it('Close Folder (N Tabs) keeps the folder SAVED with its pages, folded; its menu then leads with Open Folder (N Tabs) and offers nothing to unpack or close', () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const folder = h.browser.createFolder(space, 'Docs', '📁', h.win, { rename: false })
    const a = h.open('https://a.test/', { folderId: folder.id })
    const b = h.open('https://b.test/', { folderId: folder.id })
    h.browser.menus.showFolderContextMenu(folder.id, h.win)
    const close = item(h.shown(), 'Close Folder (2 Tabs)')
    expect(close.danger).toBeUndefined()
    close.click!()
    const saved = h.browser.state.model.folders[folder.id]
    expect(saved).toBeDefined()
    expect(saved.collapsed).toBe(true)
    expect(saved.savedTabs?.map((p) => p.url)).toEqual(['https://a.test/', 'https://b.test/'])
    expect(h.browser.tabs.tab(a)).toBeUndefined()
    expect(h.browser.tabs.tab(b)).toBeUndefined()
    h.browser.menus.showFolderContextMenu(folder.id, h.win)
    const shown = labels(h.shown())
    expect(shown[0]).toBe('Open Folder (2 Tabs)')
    expect(shown).toEqual(
      expect.arrayContaining(['Edit Folder…', 'Rename Folder…', 'Expand Folder', 'Delete Folder'])
    )
    expect(shown).not.toContain('Unpack Folder')
    expect(shown.some((l) => l.startsWith('Close Folder'))).toBe(false)
    // Open Folder brings the pages back as the folder's tabs, the folder unfolded and live again.
    item(h.shown(), 'Open Folder (2 Tabs)').click!()
    const opened = h.browser.state.model.folders[folder.id]
    expect(opened.savedTabs ?? null).toBeNull()
    expect(opened.collapsed).toBe(false)
    const members = h.win
      .activeSpace()
      .tabIds.filter((id) => h.browser.tabs.tab(id)?.folderId === folder.id)
      .map((id) => h.browser.tabs.tab(id)!.url)
    expect(members).toEqual(['https://a.test/', 'https://b.test/'])
  })

  it('Delete Folder asks the chrome first when the folder holds tabs or saved pages, and deletes an empty one outright', () => {
    const h = harness()
    const space = h.win.activeSpaceId
    const docs = h.browser.createFolder(space, 'Docs', '📁', h.win, { rename: false })
    const a = h.open('https://a.test/', { folderId: docs.id })
    h.browser.menus.showFolderContextMenu(docs.id, h.win)
    const del = item(h.shown(), 'Delete Folder')
    expect(del.danger).toBe(true)
    h.sent.length = 0
    del.click!()
    // The prompt is the chrome's (§9.23): nothing deleted yet, the window asked to show it.
    expect(events(h, 'folder.confirmDelete')).toEqual([{ folderId: docs.id }])
    expect(h.browser.state.model.folders[docs.id]).toBeDefined()
    expect(h.browser.tabs.tab(a)).toBeDefined()
    // The chrome's confirm: the folder and its tabs go.
    h.browser.handleCommand(h.win, 'folder.delete', { folderId: docs.id, unpack: false })
    expect(h.browser.state.model.folders[docs.id]).toBeUndefined()
    expect(h.browser.tabs.tab(a)).toBeUndefined()

    // A saved folder holds its pages: asked too.
    const trip = h.browser.createFolder(space, 'Trip', '📁', h.win, { rename: false })
    h.open('https://t.test/', { folderId: trip.id })
    h.browser.handleCommand(h.win, 'folder.close', { folderId: trip.id })
    expect(h.browser.state.model.folders[trip.id].savedTabs).toHaveLength(1)
    h.sent.length = 0
    h.browser.menus.showFolderContextMenu(trip.id, h.win)
    item(h.shown(), 'Delete Folder').click!()
    expect(events(h, 'folder.confirmDelete')).toEqual([{ folderId: trip.id }])
    expect(h.browser.state.model.folders[trip.id]).toBeDefined()

    // An empty folder: nothing to lose, gone without a prompt.
    const empty = h.browser.createFolder(space, 'Empty', '📁', h.win, { rename: false })
    h.sent.length = 0
    h.browser.menus.showFolderContextMenu(empty.id, h.win)
    item(h.shown(), 'Delete Folder').click!()
    expect(events(h, 'folder.confirmDelete')).toEqual([])
    expect(h.browser.state.model.folders[empty.id]).toBeUndefined()
  })

  it('New Tab in Folder opens the tab through the same path as the bubble', () => {
    const h = harness()
    const folder = h.browser.createFolder(h.win.activeSpaceId, 'Docs', '📁', h.win, {
      rename: false
    })
    const a = h.open('https://a.test/', { folderId: folder.id })
    h.browser.menus.showFolderContextMenu(folder.id, h.win)
    item(h.shown(), 'New Tab in Folder').click!()
    const members = h.win
      .activeSpace()
      .tabIds.filter((id) => h.browser.tabs.tab(id)?.folderId === folder.id)
    expect(members).toHaveLength(2)
    expect(members[0]).toBe(a)
    expect(h.win.selectedTabIn(h.win.activeSpace())).toBe(members[1])
  })

  it('shows nothing for a folder that is gone', () => {
    const h = harness()
    h.browser.menus.showFolderContextMenu('folder:gone', h.win)
    expect(h.shown()).toEqual([])
  })
})
