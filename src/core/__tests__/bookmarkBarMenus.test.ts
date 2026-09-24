import { describe, expect, it } from 'vitest'
import { BOOKMARKS_BAR_ID } from '../../shared/bookmarks'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type {
  DialogHost,
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import { folderTabs } from '../model'
import type { ZenWindow } from '../window'

/**
 * The bookmarks bar's and the manager's bookmark menus on the desktop (W5-11): Chrome's "Open
 * all in new tab group" as Open All (N) in New Tab Folder (bookmarks-41, context-menus-110) –
 * the folder's pages as the tabs of a new tab folder named after it, the threshold's question
 * asked with the window's §9.23 confirmation – and the phone's menu untouched by the row.
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

interface Sent {
  name: string
  payload: unknown
  winId: string
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  sent: Sent[]
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
  /** How many times the host's own confirmation dialog was asked (the phone's route). */
  confirms: () => number
}

function fixture(options: { confirm?: boolean } = {}): Fixture {
  const sent: Sent[] = []
  let last: MenuItemTemplate[] = []
  let confirms = 0
  const menus: MenuHost = {
    popup: (items) => {
      last = items
    }
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, pageTabs: true }),
    io: memoryIo(),
    windows: {
      create: (win: ZenWindow) =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1600, height: 1000 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload, winId: win.id })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getZoom: () => 1,
          executeJavaScript: () => Promise.resolve(true)
        })
    }),
    menus,
    dialogs: stub<DialogHost>({
      confirm: () => {
        confirms += 1
        return Promise.resolve(options.confirm ?? false)
      }
    }),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return {
    browser,
    win: browser.focusedWindow(),
    sent,
    shown: () => last,
    confirms: () => confirms
  }
}

/** Labels in order, separators as `-`. */
function labels(items: MenuItemTemplate[]): string[] {
  return items.map((item) => (item.type === 'separator' ? '-' : (item.label ?? '')))
}

function item(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no row ${label} among ${labels(items).join(', ')}`)
  return found
}

/** A bookmark folder on the bar holding `count` pages, `Folder/…`. */
function folderWith(f: Fixture, title: string, count: number): string {
  const folder = f.browser.bookmarks.createFolder(BOOKMARKS_BAR_ID, title)!
  for (let i = 0; i < count; i++)
    f.browser.bookmarks.create({ parentId: folder.id, title: `P${i}`, url: `https://p${i}.test/` })
  return folder.id
}

function menuFor(f: Fixture, ids: string[], surface: 'bar' | 'manager' = 'bar'): string[] {
  f.browser.handleCommand(f.win, 'bookmark.contextMenu', {
    ids,
    folderId: BOOKMARKS_BAR_ID,
    x: 10,
    y: 10,
    surface
  })
  return labels(f.shown())
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('Open All (N) in New Tab Folder (bookmarks-41)', () => {
  it("is the folder menu's fourth open row on the bar and in the manager, after the window rows", () => {
    const f = fixture()
    const folderId = folderWith(f, 'Reading', 3)
    for (const surface of ['bar', 'manager'] as const) {
      const rows = menuFor(f, [folderId], surface)
      expect(rows.slice(0, 4)).toEqual([
        'Open All (3)',
        'Open All (3) in New Window',
        'Open All (3) in New Private Window',
        'Open All (3) in New Tab Folder'
      ])
    }
  })

  it('an empty folder offers the row disabled, as its siblings are', () => {
    const f = fixture()
    const folderId = folderWith(f, 'Empty', 0)
    menuFor(f, [folderId])
    expect(item(f.shown(), 'Open All (0) in New Tab Folder').enabled).toBe(false)
  })

  it('a page has no such row, and neither has a mixed selection – nothing names the group', () => {
    const f = fixture()
    const folderId = folderWith(f, 'Reading', 2)
    const page = f.browser.bookmarks.tree.children(folderId)[0]
    expect(menuFor(f, [page.id])).not.toContain('Open in New Tab Folder')
    expect(menuFor(f, [page.id]).some((l) => l.includes('New Tab Folder'))).toBe(false)
    const rows = menuFor(f, [folderId, page.id], 'manager')
    expect(rows.some((l) => l.includes('New Tab Folder'))).toBe(false)
  })

  it("is the desktop's alone: the phone's folder menu keeps its three open rows", () => {
    const f = fixture()
    const folderId = folderWith(f, 'Reading', 3)
    f.browser.handleCommand(f.win, 'window.formFactor', { formFactor: 'phone' })
    const rows = menuFor(f, [folderId])
    expect(rows.some((l) => l.includes('New Tab Folder'))).toBe(false)
    expect(rows.slice(0, 3)).toEqual([
      'Open All (3)',
      'Open All (3) in New Window',
      'Open All (3) in New Private Window'
    ])
  })

  it("opens the folder's pages as the tabs of a new tab folder named after it, the first active, in the window's space, no editor asked for", async () => {
    const f = fixture()
    const folderId = folderWith(f, 'Reading', 3)
    const before = Object.keys(f.browser.state.model.folders)
    menuFor(f, [folderId])
    item(f.shown(), 'Open All (3) in New Tab Folder').click!()
    await settle()

    const made = Object.values(f.browser.state.model.folders).filter((x) => !before.includes(x.id))
    expect(made).toHaveLength(1)
    const [folder] = made
    expect(folder.name).toBe('Reading')
    expect(folder.spaceId).toBe(f.win.activeSpace().id)
    expect(folder.color).toBeDefined()
    expect(folder.collapsed).toBe(false)
    const members = folderTabs(f.browser.state.model, folder.id)
    expect(members.map((t) => t.url)).toEqual([
      'https://p0.test/',
      'https://p1.test/',
      'https://p2.test/'
    ])
    expect(f.win.selectedTabIn(f.win.activeSpace())).toBe(members[0].id)
    // The name is given: no group editor bubble, unlike "Add tab to new group".
    expect(f.sent.some((s) => s.name === 'folder.edit')).toBe(false)
    // The pages count as used.
    for (const t of members) {
      const [node] = f.browser.bookmarks.findByUrl(t.url)
      expect(node.dateLastUsed).toBeDefined()
    }
  })

  it('a private window gets a group of its own space, private tabs and all', async () => {
    const f = fixture()
    const folderId = folderWith(f, 'Reading', 2)
    const priv = f.browser.createWindow({ kind: 'private', from: f.win })!
    f.browser.handleCommand(priv, 'bookmark.contextMenu', {
      ids: [folderId],
      folderId: BOOKMARKS_BAR_ID,
      x: 1,
      y: 1,
      surface: 'bar'
    })
    item(f.shown(), 'Open All (2) in New Tab Folder').click!()
    await settle()
    const folder = Object.values(f.browser.state.model.folders).find((x) => x.name === 'Reading')!
    expect(folder.spaceId).toBe(priv.localSpace!.id)
    const members = folderTabs(f.browser.state.model, folder.id)
    expect(members).toHaveLength(2)
    expect(members.every((t) => f.browser.tabs.isPrivate(t))).toBe(true)
  })
})

describe("the threshold's question (Chrome's 15, `OPEN_ALL_PROMPT_AT`)", () => {
  it('14 pages open without a word; 15 raise the §9.23 window prompt on the desktop, and a no makes no folder and no tab', async () => {
    const f = fixture()
    const small = folderWith(f, 'Fourteen', 14)
    menuFor(f, [small])
    item(f.shown(), 'Open All (14) in New Tab Folder').click!()
    await settle()
    expect(f.win.prompt).toBeNull()
    expect(Object.values(f.browser.state.model.folders).some((x) => x.name === 'Fourteen')).toBe(
      true
    )

    const tabsBefore = Object.keys(f.browser.state.model.tabs).length
    const big = folderWith(f, 'Fifteen', 15)
    menuFor(f, [big])
    item(f.shown(), 'Open All (15) in New Tab Folder').click!()
    await settle()
    expect(f.win.prompt).toMatchObject({ kind: 'open-bookmarks', count: 15, downloads: null })
    // The host's own dialog is not the desktop's route.
    expect(f.confirms()).toBe(0)
    f.browser.windowPrompts.respond(f.win.prompt!.id, false)
    await settle()
    expect(f.win.prompt).toBeNull()
    expect(Object.values(f.browser.state.model.folders).some((x) => x.name === 'Fifteen')).toBe(
      false
    )
    expect(Object.keys(f.browser.state.model.tabs).length).toBe(tabsBefore)
  })

  it('a yes opens them all into the folder, and the plain Open All asks the same way', async () => {
    const f = fixture()
    const big = folderWith(f, 'Fifteen', 15)
    menuFor(f, [big])
    item(f.shown(), 'Open All (15) in New Tab Folder').click!()
    await settle()
    f.browser.windowPrompts.respond(f.win.prompt!.id, true)
    await settle()
    const folder = Object.values(f.browser.state.model.folders).find((x) => x.name === 'Fifteen')!
    expect(folderTabs(f.browser.state.model, folder.id)).toHaveLength(15)

    const tabsBefore = Object.keys(f.browser.state.model.tabs).length
    menuFor(f, [big])
    item(f.shown(), 'Open All (15)').click!()
    await settle()
    expect(f.win.prompt).toMatchObject({ kind: 'open-bookmarks', count: 15 })
    f.browser.windowPrompts.respond(f.win.prompt!.id, true)
    await settle()
    expect(Object.keys(f.browser.state.model.tabs).length).toBe(tabsBefore + 15)
  })

  it("the phone keeps the host's own confirmation", async () => {
    const f = fixture({ confirm: true })
    const big = folderWith(f, 'Fifteen', 15)
    f.browser.handleCommand(f.win, 'window.formFactor', { formFactor: 'phone' })
    const tabsBefore = Object.keys(f.browser.state.model.tabs).length
    menuFor(f, [big])
    item(f.shown(), 'Open All (15)').click!()
    await settle()
    expect(f.win.prompt).toBeNull()
    expect(f.confirms()).toBe(1)
    expect(Object.keys(f.browser.state.model.tabs).length).toBe(tabsBefore + 15)
  })
})
