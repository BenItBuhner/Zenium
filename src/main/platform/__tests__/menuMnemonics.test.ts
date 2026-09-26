import { describe, expect, it } from 'vitest'
import type { HostCapabilities } from '../../../shared/types'
import { BOOKMARKS_BAR_ID } from '../../../shared/bookmarks'
import type { MenuItemTemplate } from '../../../core/platform'
import {
  ALL_EDITS,
  ANDROID,
  DESKTOP,
  NO_EDITS,
  VIDEO_FLAGS,
  chromeParams,
  pageHarness,
  pageParams,
  type HarnessOptions,
  type PageHarness
} from '../../../core/__tests__/menusFixture'
import {
  CHROME_MNEMONICS,
  ZENIUM_MNEMONICS,
  chooseMnemonics,
  escapeAmpersands,
  markMnemonic,
  mnemonicCandidates,
  parseMnemonic,
  tableEntry,
  tableLetterIndex,
  tableMnemonic,
  withMnemonics
} from '../menuMnemonics'

const marked = (labels: string[], os: NodeJS.Platform = 'linux'): string[] =>
  withMnemonics(
    labels.map((label) => ({ label })),
    os
  ).map((item) => item.label ?? '')

describe('the mnemonic letters', () => {
  it("are Chrome's for Chrome's items – the grd's letters, not the first letter", () => {
    // IDS_CONTENT_CONTEXT_INSPECTELEMENT is I&nspect; IDS_CONTENT_CONTEXT_CUT is Cu&t;
    // IDS_CONTENT_CONTEXT_COPYLINKLOCATION is Copy link addr&ess; IDS_RESTORE_TAB is R&eopen.
    expect(
      marked(['Back', 'Forward', 'Reload', 'Save Page As…', 'Print…', 'Inspect Element'])
    ).toEqual(['&Back', '&Forward', '&Reload', 'Save Page &As…', '&Print…', 'I&nspect Element'])
    expect(marked(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Delete', 'Select All'])).toEqual([
      '&Undo',
      '&Redo',
      'Cu&t',
      '&Copy',
      '&Paste',
      '&Delete',
      'Select &All'
    ])
    expect(marked(['Copy Link Address', 'Copy Link Text'])).toEqual([
      'Copy Link Addr&ess',
      'Copy Link Te&xt'
    ])
    // Chrome's strip menu doubles t (New &tab, &Task manager); Zenium's rows never share, so
    // the later Chrome row moves on to its next initial.
    expect(marked(['New Tab', 'Reopen Closed Tab', 'Task Manager', 'Close Window'])).toEqual([
      'New &Tab',
      'R&eopen Closed Tab',
      'Task &Manager',
      'Close Win&dow'
    ])
    expect(marked([`Search Google for “flowers”`, 'Go to https://example.com/'])).toEqual([
      '&Search Google for “flowers”',
      '&Go to https://example.com/'
    ])
  })

  it("follow Chrome's rule elsewhere: the first letter, another word's initial when that is taken, then a consonant", () => {
    expect(marked(['Sort Left', 'Sort Right', 'Sort Here'])).toEqual([
      '&Sort Left',
      'Sort &Right',
      'Sort &Here'
    ])
    // The initials go before the consonants inside a word; then the first free consonant.
    expect(marked(['Mute', 'Mend Tab', 'Manage Apps', 'Make Live Folder…', 'Mob'])).toEqual([
      '&Mute',
      'Mend &Tab',
      'Manage &Apps',
      'Make &Live Folder…',
      'Mo&b'
    ])
    // A small word's initial (in, to, as) is no initial in a Title Case label; a label with no
    // capitals – a spelling suggestion – keeps every word's.
    expect(marked(['Sort in Split View', 'Sort to Here', 'Sort as Text'])).toEqual([
      '&Sort in Split View',
      'Sort to &Here',
      'Sort as &Text'
    ])
    expect(marked(['tea for two', 'tea for one'])).toEqual(['&tea for two', 'tea &for one'])
    // Vowels last, digits after them; punctuation never carries the marker.
    expect(marked(['A', 'AE', 'A E 1', '…'])).toEqual(['&A', 'A&E', 'A E &1', '…'])
  })

  it("keep a row's Chrome letter when a neighbour's fallback would take it first", () => {
    // Zoom In's first letter is Z, which Zoom… (IDS_ZOOM_MENU, &Zoom) owns: the table's letters
    // are claimed before the rule fills the rest, whatever the rows' order.
    expect(marked(['Zoom In', 'Zoom Out', 'Zoom…'])).toEqual(['Zoom &In', 'Zoom &Out', '&Zoom…'])
    // Two Chrome items wanting one letter: the earlier row keeps it (Chrome's own duplicates only
    // move the selection; Zenium's rows never share).
    expect(marked(['Downloads', 'Delete Browsing Data…'])).toEqual([
      '&Downloads',
      'Delete &Browsing Data…'
    ])
  })

  it("claim Chrome's letters before Zenium's, whatever the rows' order", () => {
    // The bookmark menu's Open in New Tab (Zenium's T) stands above Cut (Chrome's Cu&t).
    expect(marked(['Open in New Tab', 'Open in New Private Window', 'Cut', 'Paste'])).toEqual([
      '&Open in New Tab',
      'Open in &New Private Window',
      'Cu&t',
      '&Paste'
    ])
    expect(tableEntry('Cut')).toEqual({ letter: 't', source: 'chrome' })
    expect(tableEntry('Open in New Tab')).toEqual({ letter: 'T', source: 'zenium' })
    expect(tableEntry('Open All (3) in New Window')).toEqual({ letter: 'W', source: 'zenium' })
    expect(tableEntry('Whatever')).toBeUndefined()
  })

  it('are unique within a level, case-insensitively, and a row whose every letter is taken goes without', () => {
    expect(marked(['Ab', 'aB', 'ab', 'AB', 'ba'])).toEqual(['&Ab', 'a&B', 'ab', 'AB', 'ba'])
    expect(chooseMnemonics(['x', 'X'])).toEqual([0, undefined])
  })

  it('move an earlier free-choice row on to its next letter when that is the only way a later row gets one', () => {
    // Greedily, Sort Left takes S, Sort Right R, and Sr is left with nothing; the matching
    // moves Sort Left on to L so that Sr can have its S.
    expect(marked(['Sort Left', 'Sort Right', 'Sr'])).toEqual(['Sort &Left', 'Sort &Right', '&Sr'])
    // A Chrome letter is never moved: Move is Windows' &Move, so Mr takes its r. Zenium's own
    // letters claim first but give way: Pin Tab's P moves on when a later row has only a p.
    expect(marked(['Move', 'Mr'])).toEqual(['&Move', 'M&r'])
    expect(marked(['Pin Tab', 'Pp'])).toEqual(['Pin &Tab', '&Pp'])
    // The moves chain: A needs Ab's a, Ab needs Bc's b, and Bc has a free c.
    expect(marked(['Ab', 'Bc', 'A'])).toEqual(['A&b', 'B&c', '&A'])
  })

  it('move a row that chose its own letter before one of Zenium’s table rows, and the fewest rows they can', () => {
    // Pt's letters are both taken: Pin Tab's P (Zenium's) and Ta's t (the rule's). Ta is the
    // one moved, on to its a – Pin Tab keeps its P even though its i is free too.
    expect(marked(['Pin Tab', 'Ta', 'Pt'])).toEqual(['&Pin Tab', 'T&a', 'P&t'])
    // Ac would rather have its A, but that means moving Ab, then Bc, then Cd; moving Cd alone
    // gives it its c, and the other two keep their initials.
    expect(marked(['Ab', 'Bc', 'Cd', 'Ac'])).toEqual(['&Ab', '&Bc', 'C&d', 'A&c'])
  })

  it('escape a literal & as && on every desktop, and never mark the & itself', () => {
    expect(escapeAmpersands('Tom & Jerry')).toBe('Tom && Jerry')
    expect(marked(['Tom & Jerry'])).toEqual(['&Tom && Jerry'])
    expect(marked(['& more'])).toEqual(['&& &more'])
    expect(marked(['Tom & Jerry', 'Rock & Roll'], 'darwin')).toEqual([
      'Tom && Jerry',
      'Rock && Roll'
    ])
    expect(marked(['&&'])).toEqual(['&&&&'])
  })

  it('are left out on macOS, whose menus draw no underline and whose Electron strips them anyway', () => {
    // Electron's Cocoa menu controller runs every title through FixUpWindowsStyleLabel: a lone
    // & is dropped and && becomes &. Marking there would be work for nothing; escaping is not.
    expect(marked(['Back', 'Forward', 'Reload'], 'darwin')).toEqual(['Back', 'Forward', 'Reload'])
    expect(marked(['Back', 'Forward', 'Reload'], 'win32')).toEqual(['&Back', '&Forward', '&Reload'])
  })

  it('mark every level of a submenu on its own, leaving the core’s descriptors untouched', () => {
    const items: MenuItemTemplate[] = [
      { label: 'Copy' },
      {
        label: 'Move to',
        submenu: [{ label: 'Copy Space' }, { type: 'separator' }, { label: 'Cut Space' }]
      }
    ]
    const out = withMnemonics(items, 'linux')
    expect(out.map((i) => i.label)).toEqual(['&Copy', '&Move to'])
    expect(out[1]!.submenu!.map((i) => i.label ?? '-')).toEqual(['&Copy Space', '-', 'Cut &Space'])
    expect(items[0]!.label).toBe('Copy')
    expect(items[1]!.submenu![0]!.label).toBe('Copy Space')
    expect(out[0]!.click).toBe(items[0]!.click)
  })

  it('read back as views’ MenuItemView reads them: the letter after the first lone &, the text without markers', () => {
    expect(parseMnemonic('Copy Link Addr&ess')).toEqual({
      text: 'Copy Link Address',
      mnemonic: 'e'
    })
    expect(parseMnemonic('&Tom && Jerry')).toEqual({ text: 'Tom & Jerry', mnemonic: 't' })
    expect(parseMnemonic('Tom && Jerry')).toEqual({ text: 'Tom & Jerry' })
    expect(parseMnemonic('&&&&')).toEqual({ text: '&&' })
    for (const label of ['Bookmark All Tabs…', 'Rock & Roll', 'Search Bing for “a & b”']) {
      const out = marked([label])[0]!
      expect(parseMnemonic(out).text).toBe(label)
    }
  })

  it('table letters are letters of their labels, so a Chrome letter never silently falls back', () => {
    for (const [label, letter] of [...CHROME_MNEMONICS, ...ZENIUM_MNEMONICS]) {
      expect(label.toLowerCase(), `${label} has no ${letter}`).toContain(letter.toLowerCase())
      expect(mnemonicCandidates(label)[0]).toBe(tableLetterIndex(label, letter))
      expect([...label][tableLetterIndex(label, letter)]!.toLowerCase()).toBe(letter.toLowerCase())
    }
    expect(tableLetterIndex('Save Page As…', 'A')).toBe(10)
    expect(tableLetterIndex('Save Page As…', 'a')).toBe(1)
    expect(tableLetterIndex('Save Page As…', 'z')).toBe(-1)
    expect(tableMnemonic('Save Video As…')).toBe('v')
    expect(tableMnemonic('Send to Ben’s Laptop')).toBeUndefined()
    expect(tableMnemonic('Nothing Like It')).toBeUndefined()
    // Chrome's letter is read in its own case first: Sa&ve, not the V of Video.
    expect(marked(['Save Video As…', 'Save Page As…', 'Zoom Out'])).toEqual([
      'Sa&ve Video As…',
      'Save Page &As…',
      'Zoom &Out'
    ])
    expect(markMnemonic('abc', undefined)).toBe('abc')
    expect(markMnemonic('abc', 7)).toBe('abc')
  })
})

// ---------------------------------------------------------------------------
// Every native menu Zenium can build, in representative states
// ---------------------------------------------------------------------------

const LINK = 'https://example.org/link'
const IMAGE = 'https://example.org/picture.png'
const VIDEO = 'https://example.org/clip.mp4'

interface Opening {
  name: string
  caps?: Partial<HostCapabilities>
  options?: HarnessOptions
  /** Opens the menu (awaited when it returns a promise); the harness's last popup is the one checked. */
  open: (h: PageHarness) => unknown
}

/** A second loaded tab beside the harness's, in the same window. */
const secondTab = (h: PageHarness, url = 'https://second.example/'): string =>
  h.browser.tabs.createTab({ url, active: false }, h.win).id

const OPENINGS: Opening[] = [
  { name: 'page: the plain page', open: (h) => h.menu(pageParams()) },
  {
    name: 'page: with a translate host and a speech engine',
    caps: { readAloud: true },
    options: { translate: true, speech: true },
    open: (h) => h.menu(pageParams())
  },
  { name: 'page: a link', open: (h) => h.menu(pageParams({ linkURL: LINK, linkText: 'Docs' })) },
  {
    name: 'page: a picture',
    open: (h) => h.menu(pageParams({ srcURL: IMAGE, mediaType: 'image' }))
  },
  {
    name: 'page: a picture that is a link',
    open: (h) => h.menu(pageParams({ srcURL: IMAGE, mediaType: 'image', linkURL: LINK }))
  },
  {
    name: 'page: a video',
    open: (h) => h.menu(pageParams({ srcURL: VIDEO, mediaType: 'video', mediaFlags: VIDEO_FLAGS }))
  },
  {
    name: 'page: an audio element',
    open: (h) => h.menu(pageParams({ srcURL: VIDEO, mediaType: 'audio', mediaFlags: VIDEO_FLAGS }))
  },
  {
    name: 'page: a selection',
    open: (h) =>
      h.menu(
        pageParams({ selectionText: 'quantum foam', editFlags: { ...NO_EDITS, canCopy: true } })
      )
  },
  {
    name: 'page: a selected address',
    open: (h) =>
      h.menu(
        pageParams({
          selectionText: 'https://example.org/',
          editFlags: { ...NO_EDITS, canCopy: true }
        })
      )
  },
  {
    name: 'page: a selection with a translate host',
    options: { translate: true },
    open: (h) =>
      h.menu(
        pageParams({ selectionText: 'quantum foam', editFlags: { ...NO_EDITS, canCopy: true } })
      )
  },
  {
    name: 'page: an editable field',
    open: (h) => h.menu(pageParams({ isEditable: true, editFlags: ALL_EDITS }))
  },
  {
    name: 'page: a misspelling in an editable field',
    options: { spellcheck: { available: ['en-US', 'de-DE'] } },
    open: (h) =>
      h.menu(
        pageParams({
          isEditable: true,
          editFlags: ALL_EDITS,
          misspelledWord: 'teh',
          dictionarySuggestions: ['the', 'tech', 'ten']
        })
      )
  },
  {
    name: 'page: a frame',
    open: (h) => h.menu(pageParams({ frameURL: 'https://frames.example/inner', frameId: 7 }))
  },
  { name: 'tab: a lone tab', open: (h) => h.browser.menus.showTabContextMenu(h.tabId, h.win) },
  {
    name: 'tab: one of several, pinned, with a folder in the space',
    open: (h) => {
      secondTab(h)
      secondTab(h, 'https://third.example/')
      h.browser.createFolder(h.win.activeSpaceId, 'Trip', '📁', h.win, { rename: false })
      h.browser.tabs.togglePin(h.tabId, h.win)
      h.browser.menus.showTabContextMenu(h.tabId, h.win)
    }
  },
  {
    name: 'tab: a tab in a folder',
    open: (h) => {
      const folder = h.browser.createFolder(h.win.activeSpaceId, 'Trip', '📁', h.win, {
        rename: false
      })
      const id = h.browser.tabs.createTab(
        { url: LINK, active: true, folderId: folder.id },
        h.win
      ).id
      h.browser.menus.showTabContextMenu(id, h.win)
    }
  },
  {
    name: 'tab: a selection of tabs',
    open: (h) => h.browser.menus.showSelectionContextMenu([h.tabId, secondTab(h)], h.win)
  },
  { name: 'strip: the empty area', open: (h) => h.browser.menus.showNewTabContextMenu(h.win) },
  {
    name: 'strip: the empty area on Windows, the system items leading',
    options: { os: 'win32' },
    open: (h) => h.browser.menus.showNewTabContextMenu(h.win)
  },
  {
    name: 'split: a pane header',
    open: (h) => {
      const b = secondTab(h)
      h.browser.tabs.createSplit([h.tabId, b], 'vertical', h.win)
      h.browser.handleCommand(h.win, 'split.paneMenu', { tabId: b, x: 10, y: 20 })
    }
  },
  {
    name: 'space: a space button',
    open: (h) =>
      h.browser.handleCommand(h.win, 'space.contextMenu', {
        spaceId: h.win.activeSpaceId,
        x: 30,
        y: 900
      })
  },
  {
    name: 'folder: a tab folder',
    open: (h) => {
      const folder = h.browser.createFolder(h.win.activeSpaceId, 'Trip', '📁', h.win, {
        rename: false
      })
      h.browser.tabs.createTab({ url: LINK, active: false, folderId: folder.id }, h.win)
      h.browser.menus.showFolderContextMenu(folder.id, h.win)
    }
  },
  {
    name: 'omnibox: the address field',
    open: (h) =>
      h.browser.menus.showChromeContextMenu(
        chromeParams({ target: 'urlbar', tabId: h.tabId, isEditable: true, editFlags: ALL_EDITS }),
        h.win
      )
  },
  {
    name: 'omnibox: the site pill',
    open: (h) =>
      h.browser.menus.showChromeContextMenu(
        chromeParams({ target: 'urlpill', tabId: h.tabId }),
        h.win
      )
  },
  {
    name: 'omnibox: the reload button with the developer tools open',
    open: (h) => {
      h.browser.state.devtoolsOpenFor.add(h.tabId)
      return h.browser.menus.showChromeContextMenu(
        chromeParams({ target: 'reload', tabId: h.tabId }),
        h.win
      )
    }
  },
  {
    name: 'omnibox: the star',
    open: (h) =>
      h.browser.menus.showChromeContextMenu(chromeParams({ target: 'star', tabId: h.tabId }), h.win)
  },
  {
    name: "chrome: a text field of the chrome's own",
    open: (h) =>
      h.browser.menus.showChromeContextMenu(
        chromeParams({ isEditable: true, editFlags: ALL_EDITS, selectionText: 'foam' }),
        h.win
      )
  },
  {
    name: 'chrome: a selection in the chrome',
    open: (h) =>
      h.browser.menus.showChromeContextMenu(
        chromeParams({ selectionText: 'foam', editFlags: { ...NO_EDITS, canCopy: true } }),
        h.win
      )
  },
  {
    name: 'bookmarks bar: a bookmark',
    open: (h) => {
      const mark = h.browser.bookmarks.create({
        parentId: BOOKMARKS_BAR_ID,
        title: 'Docs',
        url: LINK
      })!
      h.browser.handleCommand(h.win, 'bookmark.contextMenu', {
        ids: [mark.id],
        folderId: BOOKMARKS_BAR_ID,
        x: 10,
        y: 10,
        surface: 'bar'
      })
    }
  },
  {
    name: 'bookmarks bar: a folder',
    open: (h) => {
      const folder = h.browser.bookmarks.createFolder(BOOKMARKS_BAR_ID, 'Reading')!
      h.browser.bookmarks.create({ parentId: folder.id, title: 'A', url: LINK })
      h.browser.handleCommand(h.win, 'bookmark.contextMenu', {
        ids: [folder.id],
        folderId: BOOKMARKS_BAR_ID,
        x: 10,
        y: 10,
        surface: 'bar'
      })
    }
  },
  {
    name: 'bookmarks bar: the bar itself',
    open: (h) =>
      h.browser.handleCommand(h.win, 'bookmark.contextMenu', {
        ids: [],
        folderId: BOOKMARKS_BAR_ID,
        x: 10,
        y: 10,
        surface: 'bar'
      })
  },
  {
    name: 'bookmark manager: several bookmarks',
    open: (h) => {
      const a = h.browser.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: 'A', url: LINK })!
      const b = h.browser.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: 'B', url: IMAGE })!
      h.browser.handleCommand(h.win, 'bookmark.contextMenu', {
        ids: [a.id, b.id],
        folderId: BOOKMARKS_BAR_ID,
        x: 10,
        y: 10,
        surface: 'manager'
      })
    }
  },
  {
    name: 'bookmarks: the toolbar menu',
    open: (h) => {
      h.browser.bookmarks.create({ parentId: BOOKMARKS_BAR_ID, title: 'Tom & Jerry', url: LINK })
      h.browser.handleCommand(h.win, 'bookmark.menu', { x: 10, y: 10 })
    }
  },
  {
    name: 'history: a row',
    open: (h) => h.browser.handleCommand(h.win, 'history.contextMenu', { visitId: 'v1', url: LINK })
  },
  {
    name: 'history: a day heading',
    open: (h) =>
      h.browser.handleCommand(h.win, 'history.dayMenu', { dayKey: '2026-09-26', count: 3 })
  },
  {
    name: 'downloads: a download in flight',
    open: (h) => {
      const id = h.browser.downloads.begin({
        url: 'https://example.com/report.pdf',
        filename: 'report.pdf',
        totalBytes: 100,
        mimeType: 'application/pdf'
      }).id
      h.browser.handleCommand(h.win, 'download.contextMenu', { id })
    }
  },
  {
    name: 'downloads: a finished download',
    open: (h) => {
      const id = h.browser.downloads.begin({
        url: 'https://example.com/report.pdf',
        filename: 'report.pdf',
        totalBytes: 100,
        mimeType: 'application/pdf'
      }).id
      h.browser.downloads.finish(id, 'completed')
      h.browser.handleCommand(h.win, 'download.contextMenu', { id })
    }
  },
  {
    name: 'reading list: an entry',
    open: (h) => {
      const entry = h.browser.readingList.add(LINK, 'Long Read')!
      h.browser.handleCommand(h.win, 'readingList.contextMenu', { id: entry.id })
    }
  },
  {
    name: 'omnibox: a history suggestion',
    open: (h) =>
      h.browser.handleCommand(h.win, 'urlbar.suggestionContextMenu', {
        id: 'history:1',
        kind: 'history'
      })
  },
  {
    name: 'new tab page: a tile',
    open: (h) => {
      h.browser.newTab.addShortcut('Docs', LINK)
      h.browser.handleCommand(h.win, 'newtab.tileContextMenu', {
        url: LINK,
        title: 'Docs',
        tabId: h.tabId
      })
    }
  }
]

/** Every level of a template: the top and each submenu's rows. */
function levels(items: MenuItemTemplate[]): MenuItemTemplate[][] {
  return [items, ...items.flatMap((item) => (item.submenu ? levels(item.submenu) : []))]
}

function describeLevel(rows: MenuItemTemplate[]): string {
  return rows.map((row) => (row.type === 'separator' ? '-' : (row.label ?? '?'))).join(' | ')
}

describe('every native menu the core builds, marked for Windows and Linux', () => {
  it.each(OPENINGS.map((o) => [o.name, o] as const))('%s', async (_name, opening) => {
    const h = pageHarness({ ...DESKTOP, ...opening.caps }, opening.options ?? {})
    const before = h.popups()
    await opening.open(h)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.popups(), 'the state opened no menu').toBe(before + 1)
    expect(h.where()?.source, 'a renderer-drawn menu is not a native one').not.toBe('app')
    const original = h.shown()
    expect(original.length).toBeGreaterThan(0)
    const out = withMnemonics(original, 'linux')
    const originals = levels(original)
    levels(out).forEach((rows, levelIndex) => {
      const seen = new Map<string, string>()
      const labelled = rows.filter((row) => row.type !== 'separator' && row.label !== undefined)
      rows.forEach((row, rowIndex) => {
        if (row.type === 'separator' || row.label === undefined) return
        const { text, mnemonic } = parseMnemonic(row.label)
        const source = originals[levelIndex]![rowIndex]!.label!
        // The words are the core's, whatever the markers – `&` doubled, nothing else changed.
        expect(text).toBe(source)
        if (mnemonic === undefined) {
          // A row goes without only when the level is crowded past its letters: every letter
          // the row has is some other row's mnemonic (the tab menu's two dozen rows draw on
          // twenty-one distinct letters; three spelling suggestions may share Cu&t's t). views'
          // SelectByChar still reaches an unmarked row by its first letter when no mnemonic
          // claims it, as it reaches Chrome's own unmarked rows.
          if (labelled.length > 1) {
            const held = new Set(
              labelled
                .map((row) => parseMnemonic(row.label!).mnemonic)
                .filter((m) => m !== undefined)
            )
            const letters = [...source.toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c))
            const free = letters.filter((c) => !held.has(c))
            expect(
              free,
              `"${source}" unmarked with ${free.join(',')} free in [${describeLevel(rows)}]`
            ).toEqual([])
          }
          return
        }
        expect(
          seen.get(mnemonic),
          `"${source}" and "${seen.get(mnemonic)}" share "${mnemonic}" in [${describeLevel(rows)}]`
        ).toBeUndefined()
        seen.set(mnemonic, source)
        // The table's letter. A Chrome row keeps Chrome's letter unless an earlier Chrome row of
        // the level has the same one (Chrome's own duplicates: &Add to dictionary / Select &all).
        // A Zenium row may be moved on to another of its letters to make room for a crowded
        // neighbour, but only when the letter it wanted is in use.
        const entry = tableEntry(source)
        if (entry !== undefined && entry.letter.toLowerCase() !== mnemonic) {
          const wanted = entry.letter.toLowerCase()
          if (entry.source === 'chrome') {
            const outranked = originals[levelIndex]!.some((row, i) => {
              const rival = row.label === undefined ? undefined : tableEntry(row.label)
              return (
                i < rowIndex && rival?.source === 'chrome' && rival.letter.toLowerCase() === wanted
              )
            })
            expect(
              outranked,
              `"${source}" lost Chrome's "${entry.letter}" in [${describeLevel(rows)}]`
            ).toBe(true)
          } else {
            const held = labelled.some(
              (row, i) =>
                i !== labelled.indexOf(rows[rowIndex]!) &&
                parseMnemonic(row.label!).mnemonic === wanted
            )
            expect(
              held,
              `"${source}" gave up its free "${entry.letter}" in [${describeLevel(rows)}]`
            ).toBe(true)
          }
        }
      })
    })
  })

  it('the phone gets no markers: its host draws the labels as text, and the core’s descriptors carry none', () => {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    h.menu(pageParams({ linkURL: LINK }))
    for (const item of h.shown()) expect(item.label ?? '').not.toContain('&')
  })
})
