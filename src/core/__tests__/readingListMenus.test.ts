import { describe, expect, it } from 'vitest'
import type { FormFactor, HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type {
  ChromeContextParams,
  ClipboardHost,
  DialogHost,
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
 * The reading list's entry points (W6-1; bookmarks-33, tabs-36, context-menus-98, sidepanel-54):
 * the star's menu with Add to Reading List beside the bookmark row and the way to the list, the
 * tab's menu row under the bookmark rows, the desktop link menu's row, the app menu's Reading
 * List ▸ submenu – each flipping to its Remove once the page is in the list, greyed for a page
 * the list does not hold, and the touch hosts' menus left as they were – and the row's own menu
 * on the page. The core opens an entry's page and marks it read.
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

interface Fixture {
  browser: Browser
  win: ZenWindow
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
  copied: string[]
  /** A loaded web page tab, active. */
  open: (url: string, title?: string) => string
  /** The star's menu for the tab (a right-click on the pill's star). */
  starMenu: (tabId: string) => Promise<MenuItemTemplate[]>
  tabMenu: (tabId: string) => MenuItemTemplate[]
  linkMenu: (tabId: string, url: string, text?: string) => MenuItemTemplate[]
  appMenu: () => MenuItemTemplate[]
}

function fixture(formFactor: FormFactor = 'desktop'): Fixture {
  let last: MenuItemTemplate[] = []
  const copied: string[] = []
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
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1600, height: 1000 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: () => undefined
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
    dialogs: stub<DialogHost>(),
    clipboard: stub<ClipboardHost>({
      writeText: (text: string) => {
        copied.push(text)
      },
      readText: () => Promise.resolve('')
    }),
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
  const win = browser.focusedWindow()
  if (formFactor !== 'desktop') browser.handleCommand(win, 'window.formFactor', { formFactor })
  const open = (url: string, title = 'Page'): string => {
    const tab = browser.tabs.createTab({ url, active: true }, win)
    tab.title = title
    return tab.id
  }
  const chrome = (tabId: string): ChromeContextParams => ({
    x: 800,
    y: 20,
    target: 'star',
    tabId,
    isEditable: false,
    selectionText: '',
    editFlags: NO_EDITS
  })
  return {
    browser,
    win,
    shown: () => last,
    copied,
    open,
    starMenu: async (tabId) => {
      await browser.menus.showChromeContextMenu(chrome(tabId), win)
      return last
    },
    tabMenu: (tabId) => {
      browser.handleCommand(win, 'tab.contextMenu', { tabId })
      return last
    },
    linkMenu: (tabId, url, text = '') => {
      browser.menus.showPageContextMenu(tabId, linkParams(url, text), win)
      return last
    },
    appMenu: () => {
      browser.menus.showAppMenu(win, { keyboard: false })
      return last
    }
  }
}

const NO_EDITS: PageContextParams['editFlags'] = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false
}

function linkParams(linkURL: string, linkText: string): PageContextParams {
  return {
    x: 120,
    y: 240,
    linkURL,
    linkText,
    srcURL: '',
    mediaType: 'none',
    selectionText: '',
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    pageURL: 'https://page.test/',
    frameURL: '',
    frameId: 0,
    editFlags: NO_EDITS
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

const URL = 'https://long.read/article'

describe('the star’s menu', () => {
  it('holds the bookmark row, Add to Reading List and Show Reading List, keyed', async () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    const menu = await f.starMenu(tab)
    expect(labels(menu)).toEqual([
      'Bookmark This Tab',
      'Add Tab to Reading List',
      '-',
      'Show Reading List'
    ])
    expect(menu.map((i) => i.key)).toEqual([
      'row.bookmark',
      'row.readingListAdd',
      undefined,
      'row.readingListShow'
    ])
    expect(item(menu, 'Bookmark This Tab').action).toBe('bookmark.add')
    item(menu, 'Add Tab to Reading List').click!()
    const [entry] = f.browser.readingList.list()
    expect(entry).toMatchObject({ url: URL, title: 'Long Read' })
    expect(entry.readAt).toBeUndefined()
    expect(f.browser.state.snapshot(f.win).readingList).toHaveLength(1)
  })

  it('flips to Remove Tab from Reading List once the page is in it, and Edit Bookmark… once starred', async () => {
    const f = fixture()
    const tab = f.open(URL)
    f.browser.readingList.add(URL, 'Long Read')
    f.browser.bookmarks.create({ title: 'Long Read', url: URL })
    const menu = await f.starMenu(tab)
    expect(labels(menu)).toEqual([
      'Edit Bookmark…',
      'Remove Tab from Reading List',
      '-',
      'Show Reading List'
    ])
    expect(item(menu, 'Remove Tab from Reading List').key).toBe('row.readingListRemove')
    item(menu, 'Remove Tab from Reading List').click!()
    expect(f.browser.readingList.list()).toEqual([])
  })

  it('greys the add for a page the list does not hold, and opens the page from Show Reading List', async () => {
    const f = fixture()
    const tab = f.open('zen://settings', 'Settings')
    const menu = await f.starMenu(tab)
    expect(item(menu, 'Add Tab to Reading List').enabled).toBe(false)
    item(menu, 'Show Reading List').click!()
    const urls = Object.values(f.browser.state.model.tabs).map((t) => t.url)
    expect(urls).toContain('zen://reading-list')
    // A second pick focuses the one page tab the window has (singleton), never a second.
    item(menu, 'Show Reading List').click!()
    expect(
      Object.values(f.browser.state.model.tabs).filter((t) => t.url === 'zen://reading-list')
    ).toHaveLength(1)
  })
})

describe('the tab’s menu', () => {
  it('seats Add Tab to Reading List under the bookmark rows on the desktop and flips it to Remove', () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    let menu = f.tabMenu(tab)
    const top = labels(menu)
    expect(top.indexOf('Add Tab to Reading List')).toBe(top.indexOf('Bookmark All Tabs…') + 1)
    expect(item(menu, 'Add Tab to Reading List').key).toBe('row.readingListAdd')
    item(menu, 'Add Tab to Reading List').click!()
    expect(f.browser.readingList.has(URL)).toBe(true)
    menu = f.tabMenu(tab)
    expect(labels(menu)).not.toContain('Add Tab to Reading List')
    expect(item(menu, 'Remove Tab from Reading List').key).toBe('row.readingListRemove')
    item(menu, 'Remove Tab from Reading List').click!()
    expect(f.browser.readingList.has(URL)).toBe(false)
  })

  it('keeps the row on the tablet and leaves the phone’s menu without it', () => {
    const tablet = fixture('tablet')
    expect(labels(tablet.tabMenu(tablet.open(URL)))).toContain('Add Tab to Reading List')
    const phone = fixture('phone')
    const menu = labels(phone.tabMenu(phone.open(URL)))
    expect(menu).not.toContain('Add Tab to Reading List')
    expect(menu).not.toContain('Remove Tab from Reading List')
  })
})

describe('the link menu', () => {
  it('closes the desktop’s transfer group with Add Link to Reading List, saving the link under its text', () => {
    const f = fixture()
    const tab = f.open('https://page.test/')
    const menu = f.linkMenu(tab, URL, 'Read this later')
    const top = labels(menu)
    // The transfer group's last row: after the copies (and the share where the host has one),
    // before the hairline that closes the group.
    expect(top.indexOf('Add Link to Reading List')).toBeGreaterThan(top.indexOf('Copy Link Text'))
    expect(top[top.indexOf('Add Link to Reading List') + 1]).toBe('-')
    const row = item(menu, 'Add Link to Reading List')
    expect(row.key).toBe('row.readingListAddLink')
    row.click!()
    expect(f.browser.readingList.list()[0]).toMatchObject({ url: URL, title: 'Read this later' })
    // A link with no text is titled by its host.
    item(f.linkMenu(tab, 'https://other.test/x'), 'Add Link to Reading List').click!()
    expect(f.browser.readingList.findByUrl('https://other.test/x')?.title).toBe('other.test')
    // A second add of the same link is one entry, its title refreshed from the new add
    // (here the bare host) and marked unread again.
    item(f.linkMenu(tab, URL), 'Add Link to Reading List').click!()
    expect(f.browser.readingList.list()).toHaveLength(2)
    const again = f.browser.readingList.findByUrl(URL)!
    expect(again.title).toBe('long.read')
    expect(again.readAt).toBeUndefined()
  })

  it('greys the row for a link the list does not hold and gives the touch hosts no row', () => {
    const f = fixture()
    const tab = f.open('https://page.test/')
    // A file link opens in a tab but is nothing the list keeps; a mail link has no row at all,
    // as it has no open targets.
    expect(
      item(f.linkMenu(tab, 'file:///tmp/notes.html'), 'Add Link to Reading List').enabled
    ).toBe(false)
    expect(labels(f.linkMenu(tab, 'mailto:a@b.test'))).not.toContain('Add Link to Reading List')
    for (const layout of ['tablet', 'phone'] as const) {
      const t = fixture(layout)
      expect(labels(t.linkMenu(t.open('https://page.test/'), URL))).not.toContain(
        'Add Link to Reading List'
      )
    }
  })
})

describe('the app menu', () => {
  it('has Chrome’s Reading List ▸ under Bookmarks with the tab’s add and Show Reading List', () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    const bookmarks = item(f.appMenu(), 'Bookmarks').submenu!
    const top = labels(bookmarks)
    expect(top.indexOf('Reading List')).toBe(top.indexOf('Show Bookmarks Bar') + 1)
    const reading = item(bookmarks, 'Reading List').submenu!
    expect(labels(reading)).toEqual(['Add Tab to Reading List', 'Show Reading List'])
    item(reading, 'Add Tab to Reading List').click!()
    expect(f.browser.readingList.has(URL)).toBe(true)
    const again = item(item(f.appMenu(), 'Bookmarks').submenu!, 'Reading List').submenu!
    expect(labels(again)).toEqual(['Remove Tab from Reading List', 'Show Reading List'])
    f.browser.tabs.closeTab(tab, false, f.win)
  })

  it('is the sidebar layouts’: the tablet has it, the phone does not', () => {
    const tablet = fixture('tablet')
    tablet.open(URL)
    expect(labels(item(tablet.appMenu(), 'Bookmarks').submenu!)).toContain('Reading List')
    const phone = fixture('phone')
    phone.open(URL)
    expect(labels(item(phone.appMenu(), 'Bookmarks').submenu!)).not.toContain('Reading List')
  })
})

describe('the row’s menu and the open', () => {
  it('offers Open, Open in New Tab, the read flip, Copy Link and Remove', () => {
    const f = fixture()
    f.open('https://page.test/')
    const entry = f.browser.readingList.add(URL, 'Long Read')!
    f.browser.handleCommand(f.win, 'readingList.contextMenu', { id: entry.id, x: 10, y: 10 })
    expect(labels(f.shown())).toEqual([
      'Open',
      'Open in New Tab',
      '-',
      'Mark as Read',
      '-',
      'Copy Link',
      'Remove'
    ])
    item(f.shown(), 'Mark as Read').click!()
    expect(f.browser.readingList.get(entry.id)!.readAt).toBeGreaterThan(0)
    f.browser.handleCommand(f.win, 'readingList.contextMenu', { id: entry.id })
    expect(labels(f.shown())).toContain('Mark as Unread')
    item(f.shown(), 'Copy Link').click!()
    expect(f.copied).toEqual([URL])
    item(f.shown(), 'Remove').click!()
    expect(f.browser.readingList.get(entry.id)).toBeNull()
    // A menu for an entry that is gone shows nothing new.
    const before = f.shown()
    f.browser.handleCommand(f.win, 'readingList.contextMenu', { id: entry.id })
    expect(f.shown()).toBe(before)
  })

  it('opens an entry in the current tab and marks it read; a new tab or a tab behind on request', () => {
    const f = fixture()
    const tab = f.open('https://page.test/')
    const entry = f.browser.readingList.add(URL, 'Long Read')!
    f.browser.handleCommand(f.win, 'readingList.open', { id: entry.id, tabId: tab })
    expect(f.browser.tabs.tab(tab)!.url).toBe(URL)
    expect(f.browser.readingList.get(entry.id)!.readAt).toBeGreaterThan(0)
    expect(f.browser.readingList.unreadCount).toBe(0)

    const other = f.browser.readingList.add('https://second.read/', 'Second')!
    const count = Object.keys(f.browser.state.model.tabs).length
    f.browser.handleCommand(f.win, 'readingList.open', {
      id: other.id,
      tabId: tab,
      newTab: true,
      background: true
    })
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(count + 1)
    // Behind: the tab in front is still the page it was.
    expect(f.browser.tabs.activeTabFor(f.win)!.id).toBe(tab)
    expect(other.readAt).toBeUndefined()
    expect(f.browser.readingList.get(other.id)!.readAt).toBeGreaterThan(0)
  })

  it('brings forward a tab already showing the page instead of loading a second copy', () => {
    const f = fixture()
    const showing = f.open(URL, 'Long Read')
    const front = f.open('https://page.test/')
    expect(f.browser.tabs.activeTabFor(f.win)!.id).toBe(front)
    const entry = f.browser.readingList.add(URL, 'Long Read')!
    const count = Object.keys(f.browser.state.model.tabs).length
    f.browser.handleCommand(f.win, 'readingList.open', { id: entry.id, tabId: front })
    expect(f.browser.tabs.activeTabFor(f.win)!.id).toBe(showing)
    expect(f.browser.tabs.tab(front)!.url).toBe('https://page.test/')
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(count)
    expect(f.browser.readingList.get(entry.id)!.readAt).toBeGreaterThan(0)
  })

  it('answers the commands: add by tab, remove by tab, set read, mark all read', () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    const added = f.browser.handleCommand(f.win, 'readingList.add', { tabId: tab })
    expect(added).toMatchObject({ url: URL, title: 'Long Read' })
    expect(f.browser.handleCommand(f.win, 'readingList.add', { tabId: null })).toMatchObject({
      id: (added as { id: string }).id
    })
    f.browser.readingList.add('https://second.read/', 'Second')
    expect(f.browser.handleCommand(f.win, 'readingList.markAllRead', undefined)).toBe(2)
    expect(f.browser.readingList.unreadCount).toBe(0)
    expect(
      f.browser.handleCommand(f.win, 'readingList.setRead', {
        id: (added as { id: string }).id,
        read: false
      })
    ).toBe(true)
    expect(f.browser.readingList.unreadCount).toBe(1)
    expect(f.browser.handleCommand(f.win, 'readingList.removeTab', { tabId: tab })).toBe(true)
    expect(f.browser.readingList.has(URL)).toBe(false)
    expect(
      f.browser.handleCommand(f.win, 'readingList.remove', { id: (added as { id: string }).id })
    ).toBe(false)
  })
})
