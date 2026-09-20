import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { HostCapabilities } from '../../../shared/types'
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '../../../shared/bookmarks'
import type { StoreIO } from '../../platform'
import { BookmarkService } from '../../bookmarks'
import { BrowserState } from '../../state'
import { parseBinaryPlist } from '../bplist'
import { parseChromiumBookmarks } from '../chromiumBookmarks'
import {
  decodeFirefoxBackup,
  firefoxBookmarksFromBackup,
  firefoxBookmarksFromPlaces,
  newestFirefoxBackup
} from '../firefoxBookmarks'
import { decodeLz4Block, decodeMozLz4, isMozLz4 } from '../mozlz4'
import { parseSafariBookmarks } from '../safariBookmarks'
import { countBookmarks, dedupeByUrl, type ImportedBookmarkItem } from '../types'
import { firefoxPlacesSchema, lz4CompressBlock, memoryDatabase, mozlz4Encode } from './helpers'

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

const NOW = Date.UTC(2026, 8, 20)
/** 13350000000000000 WebKit microseconds. */
const WEBKIT_2024 = 1705526400000

function titles(items: ImportedBookmarkItem[]): unknown[] {
  return items.map((i) =>
    i.type === 'folder' ? { folder: i.title, children: titles(i.children) } : i.title || i.url
  )
}

describe('Chrome / Edge Bookmarks JSON', () => {
  it('maps the three roots to the toolbar, the unfiled root and a Mobile bookmarks folder', () => {
    const result = parseChromiumBookmarks(fixture('chrome-bookmarks.json').toString(), NOW)
    expect(titles(result.items)).toEqual([
      {
        folder: 'Bookmarks bar',
        children: [
          'Zenium',
          { folder: 'Work', children: ['Chromium', 'https://developer.chrome.com/'] }
        ]
      },
      { folder: 'Other bookmarks', children: ['Zenium (again)', 'Undated'] },
      { folder: 'Mobile bookmarks', children: ['Phone page'] }
    ])
    const [bar, other, mobile] = result.items as [
      Extract<ImportedBookmarkItem, { type: 'folder' }>,
      Extract<ImportedBookmarkItem, { type: 'folder' }>,
      Extract<ImportedBookmarkItem, { type: 'folder' }>
    ]
    expect([bar.toolbar, bar.unfiled]).toEqual([true, false])
    expect([other.toolbar, other.unfiled]).toEqual([false, true])
    expect([mobile.toolbar, mobile.unfiled]).toEqual([false, false])
    // chrome://settings/ is not importable.
    expect(result.skipped).toBe(1)
    expect(countBookmarks(result.items)).toBe(6)
  })

  it('keeps date_added (WebKit microseconds) and leaves a zero date to the planner', () => {
    const result = parseChromiumBookmarks(fixture('chrome-bookmarks.json').toString(), NOW)
    const bar = result.items[0]
    if (bar.type !== 'folder') throw new Error('bar')
    expect(bar.children[0]).toMatchObject({ url: 'https://zenium.app/', addDate: WEBKIT_2024 })
    const work = bar.children[1]
    if (work.type !== 'folder') throw new Error('work')
    expect(work.addDate).toBe(WEBKIT_2024 + 50_000)
    expect(work.lastModified).toBe(WEBKIT_2024 + 200_000)
    const other = result.items[1]
    if (other.type !== 'folder') throw new Error('other')
    expect(other.children[1]).not.toHaveProperty('addDate')
  })

  it('brings account roots along as named folders and rejects a file without roots', () => {
    const text = JSON.stringify({
      roots: {
        bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [] },
        other: { type: 'folder', name: 'Other bookmarks', children: [] },
        account_bookmark_bar: {
          type: 'folder',
          name: 'Account bar',
          children: [{ type: 'url', name: 'A', url: 'https://a.example/' }]
        },
        synced: { type: 'folder', name: 'Mobile bookmarks', children: [] }
      }
    })
    const result = parseChromiumBookmarks(text, NOW)
    expect(titles(result.items)).toEqual([
      { folder: 'Bookmarks bar', children: [] },
      { folder: 'Other bookmarks', children: [] },
      { folder: 'Account bar', children: ['A'] }
    ])
    expect(() => parseChromiumBookmarks('{"version":1}', NOW)).toThrow(/no roots/)
    expect(() => parseChromiumBookmarks('{', NOW)).toThrow(/not valid JSON/)
  })
})

describe('Firefox places.sqlite', () => {
  const PR_2023 = 1_690_000_000_000 // 2023-07-22, in ms

  function places(): ReturnType<typeof memoryDatabase> {
    return memoryDatabase((db) => {
      firefoxPlacesSchema(db)
      const place = db.prepare('INSERT INTO moz_places(id, url, title, guid) VALUES (?, ?, ?, ?)')
      place.run(1, 'https://www.mozilla.org/', 'Mozilla', 'p1')
      place.run(2, 'https://zenium.app/', 'Zenium', 'p2')
      place.run(3, 'place:type=6&sort=14&maxResults=10', 'Recent Tags', 'p3')
      place.run(4, 'https://m.example.org/', 'Phone', 'p4')
      const bm = db.prepare(
        'INSERT INTO moz_bookmarks(id, type, fk, parent, position, title, dateAdded, lastModified, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      bm.run(1, 2, null, 0, 0, '', 0, 0, 'root________')
      bm.run(2, 2, null, 1, 0, 'menu', 0, 0, 'menu________')
      bm.run(3, 2, null, 1, 1, 'toolbar', 0, 0, 'toolbar_____')
      bm.run(4, 2, null, 1, 2, 'tags', 0, 0, 'tags________')
      bm.run(5, 2, null, 1, 3, 'unfiled', 0, 0, 'unfiled_____')
      bm.run(6, 2, null, 1, 4, 'mobile', 0, 0, 'mobile______')
      // Toolbar: Mozilla, then a folder "Dev" holding Zenium; a separator between them.
      bm.run(10, 1, 1, 3, 0, 'Mozilla', PR_2023 * 1000, PR_2023 * 1000, 'b10')
      bm.run(11, 3, null, 3, 1, null, PR_2023 * 1000, PR_2023 * 1000, 'b11')
      bm.run(12, 2, null, 3, 2, 'Dev', (PR_2023 + 1000) * 1000, (PR_2023 + 2000) * 1000, 'b12')
      bm.run(13, 1, 2, 12, 0, 'Zenium', (PR_2023 + 3000) * 1000, (PR_2023 + 3000) * 1000, 'b13')
      // Menu: the Recent Tags query (skipped); unfiled: Zenium again; mobile: Phone.
      bm.run(14, 1, 3, 2, 0, 'Recent Tags', 0, 0, 'b14')
      bm.run(15, 1, 2, 5, 0, 'Zenium (unfiled)', 0, 0, 'b15')
      bm.run(16, 1, 4, 6, 0, 'Phone', 0, 0, 'b16')
      // A tag folder under tags: never a bookmark.
      bm.run(17, 2, null, 4, 0, 'tag', 0, 0, 'b17')
    })
  }

  it('rebuilds the four roots from moz_bookmarks and moz_places in position order', () => {
    const db = places()
    const result = firefoxBookmarksFromPlaces(db, NOW)
    db.close()
    expect(titles(result.items)).toEqual([
      {
        folder: 'Bookmarks Toolbar',
        children: ['Mozilla', { folder: 'Dev', children: ['Zenium'] }]
      },
      { folder: 'Bookmarks Menu', children: [] },
      { folder: 'Other Bookmarks', children: ['Zenium (unfiled)'] },
      { folder: 'Mobile Bookmarks', children: ['Phone'] }
    ])
    const [toolbar, menu, unfiled, mobile] = result.items
    expect(toolbar.type === 'folder' && toolbar.toolbar).toBe(true)
    expect(menu.type === 'folder' && menu.unfiled).toBe(true)
    expect(unfiled.type === 'folder' && unfiled.unfiled).toBe(true)
    expect(mobile.type === 'folder' && !mobile.toolbar && !mobile.unfiled).toBe(true)
    // The separator and the place: query.
    expect(result.skipped).toBe(2)
  })

  it('converts PRTime microseconds to epoch milliseconds', () => {
    const db = places()
    const result = firefoxBookmarksFromPlaces(db, NOW)
    db.close()
    const toolbar = result.items[0]
    if (toolbar.type !== 'folder') throw new Error('toolbar')
    expect(toolbar.children[0]).toMatchObject({ addDate: PR_2023 })
    const dev = toolbar.children[1]
    if (dev.type !== 'folder') throw new Error('dev')
    expect([dev.addDate, dev.lastModified]).toEqual([PR_2023 + 1000, PR_2023 + 2000])
  })

  it('refuses a database without bookmark roots', () => {
    const db = memoryDatabase(firefoxPlacesSchema)
    expect(() => firefoxBookmarksFromPlaces(db, NOW)).toThrow(/no bookmark roots/)
    db.close()
  })
})

describe('Firefox bookmark backups (mozlz4)', () => {
  const BACKUP = {
    guid: 'root________',
    title: '',
    index: 0,
    dateAdded: 1_600_000_000_000_000,
    lastModified: 1_600_000_000_000_000,
    id: 1,
    typeCode: 2,
    type: 'text/x-moz-place-container',
    root: 'placesRoot',
    children: [
      {
        guid: 'menu________',
        title: 'menu',
        typeCode: 2,
        type: 'text/x-moz-place-container',
        root: 'bookmarksMenuFolder',
        children: [
          {
            guid: 'm1',
            title: 'Mozilla Firefox',
            typeCode: 2,
            type: 'text/x-moz-place-container',
            children: [
              {
                guid: 'm2',
                title: 'Get Help',
                typeCode: 1,
                type: 'text/x-moz-place',
                uri: 'https://support.mozilla.org/products/firefox',
                dateAdded: 1_690_000_000_000_000,
                iconUri: 'fake-favicon-uri:https://support.mozilla.org/products/firefox'
              }
            ]
          },
          { guid: 'sep', typeCode: 3, type: 'text/x-moz-place-separator', title: '' }
        ]
      },
      {
        guid: 'toolbar_____',
        title: 'toolbar',
        typeCode: 2,
        type: 'text/x-moz-place-container',
        root: 'toolbarFolder',
        children: [
          {
            guid: 't1',
            title: 'Zenium',
            typeCode: 1,
            type: 'text/x-moz-place',
            uri: 'https://zenium.app/',
            iconUri: 'https://zenium.app/favicon.ico',
            dateAdded: 1_690_000_000_000_000
          }
        ]
      },
      {
        guid: 'tags________',
        title: 'tags',
        typeCode: 2,
        type: 'text/x-moz-place-container',
        root: 'tagsFolder',
        children: [
          {
            guid: 'tg',
            title: 'tag',
            typeCode: 2,
            type: 'text/x-moz-place-container',
            children: []
          }
        ]
      },
      {
        guid: 'unfiled_____',
        title: 'unfiled',
        typeCode: 2,
        type: 'text/x-moz-place-container',
        root: 'unfiledBookmarksFolder',
        children: []
      },
      {
        guid: 'mobile______',
        title: 'mobile',
        typeCode: 2,
        type: 'text/x-moz-place-container',
        root: 'mobileFolder',
        children: []
      }
    ]
  }

  it('round-trips through the block decoder, matches and long literal runs included', () => {
    const text = `${'a'.repeat(300)}${JSON.stringify(BACKUP)}${'b'.repeat(40)}${JSON.stringify(BACKUP)}`
    const raw = new TextEncoder().encode(text)
    const block = lz4CompressBlock(raw)
    expect(block.length).toBeLessThan(raw.length / 2)
    expect(new TextDecoder().decode(decodeLz4Block(block, raw.length))).toBe(text)
    const small = new TextEncoder().encode('tiny')
    expect(decodeLz4Block(lz4CompressBlock(small), 4)).toEqual(small)
    expect(() => decodeLz4Block(block, raw.length + 1)).toThrow(/malformed/)
    expect(() => decodeLz4Block(new Uint8Array([0x10]), 1)).toThrow(/malformed/)
  })

  it('opens the mozLz40 container and reads the roots by their role', () => {
    const bytes = mozlz4Encode(JSON.stringify(BACKUP))
    expect(isMozLz4(bytes)).toBe(true)
    expect(isMozLz4(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(JSON.parse(decodeMozLz4(bytes))).toEqual(BACKUP)
    const result = firefoxBookmarksFromBackup(decodeFirefoxBackup(bytes), NOW)
    expect(titles(result.items)).toEqual([
      {
        folder: 'Bookmarks Menu',
        children: [{ folder: 'Mozilla Firefox', children: ['Get Help'] }]
      },
      { folder: 'Bookmarks Toolbar', children: ['Zenium'] },
      { folder: 'Other Bookmarks', children: [] }
    ])
    const toolbar = result.items[1]
    if (toolbar.type !== 'folder') throw new Error('toolbar')
    expect(toolbar.toolbar).toBe(true)
    expect(toolbar.children[0]).toMatchObject({
      url: 'https://zenium.app/',
      icon: 'https://zenium.app/favicon.ico',
      addDate: 1_690_000_000_000
    })
    const menu = result.items[0]
    if (menu.type !== 'folder') throw new Error('menu')
    const help = menu.children[0]
    if (help.type !== 'folder') throw new Error('help')
    // A fake-favicon-uri is not a favicon.
    expect(help.children[0]).not.toHaveProperty('icon')
    expect(result.skipped).toBe(1)
    // A plain .json backup reads the same way.
    expect(
      firefoxBookmarksFromBackup(
        decodeFirefoxBackup(new TextEncoder().encode(JSON.stringify(BACKUP))),
        NOW
      ).items
    ).toHaveLength(3)
  })

  it('picks the newest backup by its dated name', () => {
    expect(
      newestFirefoxBackup([
        'bookmarks-2024-01-05_12_abc.jsonlz4',
        'bookmarks-2024-03-01_9_xyz.jsonlz4',
        'bookmarks-2023-12-31_40_def.json',
        'notes.txt'
      ])
    ).toBe('bookmarks-2024-03-01_9_xyz.jsonlz4')
    expect(newestFirefoxBackup([])).toBeNull()
  })
})

describe('Safari Bookmarks.plist', () => {
  it('parses the binary plist (python plistlib fixture) with every value type', () => {
    const root = parseBinaryPlist(fixture('safari-bookmarks.plist'))
    if (
      !root ||
      typeof root !== 'object' ||
      Array.isArray(root) ||
      root instanceof Uint8Array ||
      root instanceof Date
    )
      throw new Error('root')
    expect(root.WebBookmarkFileVersion).toBe(1)
    const sync = root.Sync
    expect(sync).toMatchObject({ CloudKitMigrationState: 2, Enabled: true, Ratio: 0.5 })
    if (
      !sync ||
      typeof sync !== 'object' ||
      Array.isArray(sync) ||
      sync instanceof Uint8Array ||
      sync instanceof Date
    )
      throw new Error('sync')
    expect(Array.from(sync.Data as Uint8Array)).toEqual([1, 2, 3, 4])
    const children = root.Children
    if (!Array.isArray(children)) throw new Error('children')
    const reading = children[3]
    if (
      !reading ||
      typeof reading !== 'object' ||
      Array.isArray(reading) ||
      reading instanceof Uint8Array ||
      reading instanceof Date
    )
      throw new Error('reading')
    expect(reading.ShouldOmitFromUI).toBe(true)
    const entry = (reading.Children as Array<Record<string, unknown>>)[0]
    const list = entry.ReadingList as Record<string, unknown>
    expect(list.DateAdded).toBeInstanceOf(Date)
    expect((list.DateAdded as Date).toISOString()).toBe('2024-05-06T07:08:09.000Z')
    expect(() => parseBinaryPlist(new Uint8Array([1, 2, 3]))).toThrow()
  })

  it('imports the bar as the toolbar and the menu as unfiled, leaving the Reading List and proxies', () => {
    const result = parseSafariBookmarks(fixture('safari-bookmarks.plist'))
    expect(titles(result.items)).toEqual([
      {
        folder: 'Favorites',
        children: ['Apple', { folder: 'News', children: ['Hacker News', 'Apple again'] }]
      },
      { folder: 'Bookmarks Menu', children: ['Apple Developer', { folder: 'Empty', children: [] }] }
    ])
    const [bar, menu] = result.items
    expect(bar.type === 'folder' && bar.toolbar).toBe(true)
    expect(menu.type === 'folder' && menu.unfiled).toBe(true)
    // The javascript: bookmarklet, the History proxy, the Reading List's entry.
    expect(result.skipped).toBe(3)
  })
})

describe('dedupeByUrl', () => {
  it('drops a URL seen earlier in the same import, folders kept', () => {
    const result = parseSafariBookmarks(fixture('safari-bookmarks.plist'))
    const deduped = dedupeByUrl(result.items)
    expect(deduped.duplicates).toBe(1)
    expect(deduped.bookmarks).toBe(3)
    expect(titles(deduped.items)).toEqual([
      { folder: 'Favorites', children: ['Apple', { folder: 'News', children: ['Hacker News'] }] },
      { folder: 'Bookmarks Menu', children: ['Apple Developer', { folder: 'Empty', children: [] }] }
    ])
  })
})

describe('BookmarkService.importDocument', () => {
  function service(): BookmarkService {
    const io: StoreIO = {
      readSync: () => null,
      write: async () => undefined,
      writeSync: () => undefined
    }
    const state = new BrowserState(io, 'linux', {} as HostCapabilities, '0.0')
    state.load()
    return new BookmarkService(state)
  }

  it("files a browser's tree like Chrome: into the roots while the bar is empty, then into a named folder", () => {
    const bookmarks = service()
    const doc = parseChromiumBookmarks(fixture('chrome-bookmarks.json').toString(), NOW)
    const first = bookmarks.importDocument(
      { title: 'x', items: doc.items },
      'Imported From Chrome'
    )!
    expect(first.folderId).toBe(BOOKMARKS_BAR_ID)
    expect(bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual([
      'Zenium',
      'Work'
    ])
    expect(bookmarks.tree.children(OTHER_BOOKMARKS_ID).map((n) => n.title)).toEqual([
      'Zenium (again)',
      'Undated',
      'Mobile bookmarks'
    ])
    const zenium = bookmarks.tree.children(BOOKMARKS_BAR_ID)[0]
    expect(zenium.dateAdded).toBe(WEBKIT_2024)

    const second = bookmarks.importDocument(
      { title: 'x', items: doc.items },
      'Imported From Chrome'
    )!
    const folder = bookmarks.tree.get(second.folderId)!
    expect(folder.title).toBe('Imported From Chrome')
    expect(folder.parentId).toBe(BOOKMARKS_BAR_ID)
    expect(bookmarks.tree.children(second.folderId).map((n) => n.title)).toEqual([
      'Zenium',
      'Work',
      'Zenium (again)',
      'Undated',
      'Mobile bookmarks'
    ])
    const third = bookmarks.importDocument(
      { title: 'x', items: doc.items },
      'Imported From Chrome'
    )!
    expect(bookmarks.tree.get(third.folderId)!.title).toBe('Imported From Chrome (2)')
    expect(bookmarks.importDocument({ title: 'x', items: [] }, 'Imported')).toBeNull()
  })
})
