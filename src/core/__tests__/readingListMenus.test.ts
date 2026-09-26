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
  /** Every toast the window was sent, in order. */
  toasts: () => string[]
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
  const sent: { name: string; payload: unknown }[] = []
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
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
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
    toasts: () =>
      sent.filter((s) => s.name === 'toast').map((s) => (s.payload as { message: string }).message),
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
      'Bookmark This Page',
      'Add to Reading List',
      '-',
      'Show Reading List'
    ])
    expect(menu.map((i) => i.key)).toEqual([
      'row.bookmark',
      'row.readingListAdd',
      undefined,
      'row.readingListShow'
    ])
    expect(item(menu, 'Bookmark This Page').action).toBe('bookmark.add')
    item(menu, 'Add to Reading List').click!()
    const [entry] = f.browser.readingList.list()
    expect(entry).toMatchObject({ url: URL, title: 'Long Read' })
    expect(entry.readAt).toBeUndefined()
    expect(f.browser.state.snapshot(f.win).readingList).toHaveLength(1)
  })

  it('flips to Remove from Reading List once the page is in it, and Remove Bookmark once starred', async () => {
    const f = fixture()
    const tab = f.open(URL)
    f.browser.readingList.add(URL, 'Long Read')
    f.browser.bookmarks.create({ title: 'Long Read', url: URL })
    const menu = await f.starMenu(tab)
    expect(labels(menu)).toEqual([
      'Remove Bookmark',
      'Remove from Reading List',
      '-',
      'Show Reading List'
    ])
    expect(item(menu, 'Remove from Reading List').key).toBe('row.readingListRemove')
    item(menu, 'Remove from Reading List').click!()
    expect(f.browser.readingList.list()).toEqual([])
    // The bookmark row is the app menu's toggle: Remove Bookmark takes the bookmark away.
    item(menu, 'Remove Bookmark').click!()
    expect(f.browser.bookmarks.has(URL)).toBe(false)
  })

  it('words both rows for the page (the lead’s C5 on #511) while the tab row and the app menu keep the tab’s', async () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    const readingRows = (): string[] =>
      labels(item(item(f.appMenu(), 'Bookmarks').submenu!, 'Reading List').submenu!)
    // Unlisted: the star says "Add to Reading List"; the tab row and Reading List ▸ say "Tab".
    expect(labels(await f.starMenu(tab))[1]).toBe('Add to Reading List')
    expect(labels(f.tabMenu(tab))).toContain('Add Tab to Reading List')
    expect(readingRows()[0]).toBe('Add Tab to Reading List')
    // Listed: the same three seats, the same one act, each in its subject's words.
    item(await f.starMenu(tab), 'Add to Reading List').click!()
    expect(labels(await f.starMenu(tab))[1]).toBe('Remove from Reading List')
    expect(labels(f.tabMenu(tab))).toContain('Remove Tab from Reading List')
    expect(readingRows()[0]).toBe('Remove Tab from Reading List')
    // No star row ever carries the tab's wording, and the link row keeps its own subject.
    for (const l of labels(await f.starMenu(tab))) expect(l).not.toMatch(/\bTab\b/)
    expect(labels(f.linkMenu(tab, 'https://other.test/x', 'Other'))).toContain(
      'Add Link to Reading List'
    )
  })

  it('reads the bookmark row in the app menu’s words: one pair for the page across both menus', async () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    const appRow = (): string =>
      labels(item(f.appMenu(), 'Bookmarks').submenu!).find((l) => /Bookmark/.test(l))!
    expect(labels(await f.starMenu(tab))[0]).toBe(appRow())
    item(await f.starMenu(tab), 'Bookmark This Page').click!()
    expect(f.browser.bookmarks.has(URL)).toBe(true)
    expect(labels(await f.starMenu(tab))[0]).toBe('Remove Bookmark')
    expect(appRow()).toBe('Remove Bookmark')
  })

  it('greys the add for a page the list does not hold, and opens the page from Show Reading List', async () => {
    const f = fixture()
    const tab = f.open('zen://settings', 'Settings')
    const menu = await f.starMenu(tab)
    expect(item(menu, 'Add to Reading List').enabled).toBe(false)
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

  it('greys the row for a link the list does not hold', () => {
    const f = fixture()
    const tab = f.open('https://page.test/')
    // A file link opens in a tab but is nothing the list keeps; a mail link has no row at all,
    // as it has no open targets.
    expect(
      item(f.linkMenu(tab, 'file:///tmp/notes.html'), 'Add Link to Reading List').enabled
    ).toBe(false)
    expect(labels(f.linkMenu(tab, 'mailto:a@b.test'))).not.toContain('Add Link to Reading List')
  })

  it('closes the touch hosts’ transfer group with the same row since the phone has its panel (HB-20)', () => {
    // One link menu on both touch hosts (the lead's ruling after #492): the row is the last of
    // the transfer group on each, after Share Link…, saving the link under its text as the
    // desktop's does; a mail link has no row, as on the desktop.
    for (const layout of ['tablet', 'phone'] as const) {
      const t = fixture(layout)
      const tab = t.open('https://page.test/')
      const top = labels(t.linkMenu(tab, URL, 'Read this later'))
      const at = top.indexOf('Add Link to Reading List')
      expect(at).toBe(top.indexOf('Share Link…') + 1)
      expect(top[at + 1]).toBe('-')
      item(t.linkMenu(tab, URL, 'Read this later'), 'Add Link to Reading List').click!()
      expect(t.browser.readingList.list()[0]).toMatchObject({ url: URL, title: 'Read this later' })
      expect(t.toasts()).toContain('Added to reading list')
      expect(labels(t.linkMenu(tab, 'mailto:a@b.test'))).not.toContain('Add Link to Reading List')
    }
  })
})

describe('one feedback rule for one action', () => {
  it('toasts "Added to reading list" from every add – the star’s, the tab’s, the link’s, the app menu’s, the command', async () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    item(await f.starMenu(tab), 'Add to Reading List').click!()
    expect(f.toasts()).toEqual(['Added to reading list'])
    // The link row's add is the same act from where the list cannot be seen: the same word.
    item(f.linkMenu(tab, 'https://other.test/x', 'Other'), 'Add Link to Reading List').click!()
    expect(f.toasts()).toEqual(['Added to reading list', 'Added to reading list'])
    // A re-add of a listed page (marked unread again) reports the same; a link the list does
    // not hold reports nothing – there was nothing done.
    item(f.tabMenu(tab), 'Remove Tab from Reading List').click!()
    item(f.tabMenu(tab), 'Add Tab to Reading List').click!()
    f.browser.handleCommand(f.win, 'readingList.add', { tabId: null })
    expect(f.browser.addLinkToReadingList('file:///tmp/a.html', 'a', f.win)).toBeNull()
    expect(f.toasts().filter((t) => t === 'Added to reading list')).toHaveLength(4)
    expect(f.browser.readingList.list()).toHaveLength(2)
  })

  it('toasts "Removed from reading list" from the menus’ Remove rows, and nothing from the page’s own rows', async () => {
    const f = fixture()
    const tab = f.open(URL, 'Long Read')
    f.browser.readingList.add(URL, 'Long Read')
    item(await f.starMenu(tab), 'Remove from Reading List').click!()
    expect(f.toasts()).toEqual(['Removed from reading list'])
    // Nothing to remove: no toast – the row is not offered, and the command reports false.
    expect(f.browser.handleCommand(f.win, 'readingList.removeTab', { tabId: tab })).toBe(false)
    expect(f.toasts()).toHaveLength(1)
    f.browser.readingList.add(URL, 'Long Read')
    const reading = item(item(f.appMenu(), 'Bookmarks').submenu!, 'Reading List').submenu!
    item(reading, 'Remove Tab from Reading List').click!()
    expect(f.toasts()).toEqual(['Removed from reading list', 'Removed from reading list'])
    // The page's row menu and its Delete key remove a row the user watches leave: no toast.
    const entry = f.browser.readingList.add(URL, 'Long Read')!
    f.browser.handleCommand(f.win, 'readingList.contextMenu', { id: entry.id })
    item(f.shown(), 'Remove').click!()
    const again = f.browser.readingList.add(URL, 'Long Read')!
    f.browser.handleCommand(f.win, 'readingList.remove', { id: again.id })
    expect(f.browser.readingList.list()).toEqual([])
    expect(f.toasts()).toHaveLength(2)
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

  it('is the sidebar layouts’ submenu: the tablet has it, the phone’s Bookmarks ▸ does not', () => {
    const tablet = fixture('tablet')
    tablet.open(URL)
    expect(labels(item(tablet.appMenu(), 'Bookmarks').submenu!)).toContain('Reading List')
    const phone = fixture('phone')
    phone.open(URL)
    expect(labels(item(phone.appMenu(), 'Bookmarks').submenu!)).not.toContain('Reading List')
  })

  it('on the phone is two flat rows (HB-20): Reading List after Bookmarks, and the page’s verb among the saves', () => {
    const phone = fixture('phone')
    const tab = phone.open(URL, 'Long Read')
    let menu = phone.appMenu()
    let top = labels(menu)
    // The list, a library row after Bookmarks in the page's noun (History and Downloads are
    // nouns there too), keyed as the desktop's Show Reading List is.
    expect(top.indexOf('Reading List')).toBe(top.indexOf('Bookmarks') + 1)
    expect(item(menu, 'Reading List').key).toBe('row.readingListShow')
    // The verb in the star's words, seated among the page's saves – after Share… (the harness
    // has no devices and no home screen, so Print… follows it here) – under one key for both
    // of its states so the user's menu order names one row.
    expect(top.indexOf('Add to Reading List')).toBe(top.indexOf('Share…') + 1)
    expect(top.indexOf('Add to Reading List')).toBe(top.indexOf('Print…') - 1)
    expect(item(menu, 'Add to Reading List').key).toBe('row.readingList')
    expect(item(menu, 'Add to Reading List').enabled).not.toBe(false)
    item(menu, 'Add to Reading List').click!()
    expect(phone.browser.readingList.has(URL)).toBe(true)
    expect(phone.toasts()).toContain('Added to reading list')
    menu = phone.appMenu()
    top = labels(menu)
    expect(top).not.toContain('Add to Reading List')
    expect(top.indexOf('Remove from Reading List')).toBe(top.indexOf('Share…') + 1)
    expect(item(menu, 'Remove from Reading List').key).toBe('row.readingList')
    item(menu, 'Remove from Reading List').click!()
    expect(phone.browser.readingList.has(URL)).toBe(false)
    expect(phone.toasts()).toContain('Removed from reading list')
    // The tab's words never reach the phone's list.
    expect(top).not.toContain('Add Tab to Reading List')
    expect(top).not.toContain('Remove Tab from Reading List')
    // A page the list does not hold greys the verb rather than dropping it (§9.17).
    phone.browser.tabs.closeTab(tab, false, phone.win)
    phone.open('zen://settings')
    expect(item(phone.appMenu(), 'Add to Reading List').enabled).toBe(false)
  })

  it('on the phone Reading List opens the list from the menu row', () => {
    const phone = fixture('phone')
    phone.open(URL)
    const opened: string[] = []
    const { pages } = phone.browser
    const original = pages.open.bind(pages)
    pages.open = (id, section, win, ...rest) => {
      opened.push(id)
      return original(id, section, win, ...rest)
    }
    item(phone.appMenu(), 'Reading List').click!()
    expect(opened).toEqual(['reading-list'])
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
