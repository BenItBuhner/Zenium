import { describe, expect, it } from 'vitest'
import type { BookmarkNode } from '../types'
import {
  BOOKMARKS_BAR_ID,
  BookmarkTree,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  createBookmarkRoots,
  normalizeBookmarkNodes
} from '../bookmarks'
import {
  type ImportTarget,
  type NetscapeFolder,
  type NetscapeItem,
  decodeEntities,
  isNetscapeBookmarkFile,
  parseNetscapeDate,
  parseNetscapeHtml,
  planNetscapeImport,
  serializeNetscapeHtml
} from '../netscape'

const NOW = 1_700_000_000_000

/** `[title, url]` for bookmarks, `[title, children]` for folders – easy to compare whole trees. */
type Shape = [string, string] | [string, Shape[]]
function shape(items: NetscapeItem[]): Shape[] {
  return items.map((i) => (i.type === 'url' ? [i.title, i.url] : [i.title, shape(i.children)]))
}

const CHROME = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1690000000" LAST_MODIFIED="1690000100" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1690000001" ICON="data:image/png;base64,iVBORw0KGgo=">Example &amp; Co</A>
        <DT><H3 ADD_DATE="1690000002" LAST_MODIFIED="1690000003">Work</H3>
        <DL><p>
            <DT><A HREF="https://docs.example.com/a?b=1&amp;c=2" ADD_DATE="1690000004">Docs</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://other.example.com/" ADD_DATE="1690000005">Other page</A>
    <DT><H3 ADD_DATE="1690000006" LAST_MODIFIED="1690000007">Mobile bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://m.example.com/" ADD_DATE="1690000008">Mobile page</A>
    </DL><p>
</DL><p>
`

const FIREFOX = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; img-src data: *; object-src 'none'"></meta>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>

<DL><p>
    <DT><A HREF="place:sort=8&amp;maxResults=10">Recent Tags</A>
    <HR>
    <DT><H3 ADD_DATE="1690000000" LAST_MODIFIED="1690000100" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
<DD>Add bookmarks to this folder to see them displayed on the Bookmarks Toolbar
    <DL><p>
        <DT><A HREF="https://www.mozilla.org/firefox/central/" ADD_DATE="1690000001" LAST_MODIFIED="1690000002" ICON_URI="https://www.mozilla.org/favicon.ico" ICON="data:image/png;base64,iVBORw0KGgo=">Getting Started</A>
        <DT><H3 ADD_DATE="1690000003" LAST_MODIFIED="1690000004">Nested</H3>
        <DL><p>
            <DT><A HREF="https://deep.example/" ADD_DATE="1690000005">Deep</A>
<DD>A description line that must not become a title
        </DL><p>
    </DL><p>
    <DT><H3 ADD_DATE="1690000006" LAST_MODIFIED="1690000007" UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://unfiled.example/" ADD_DATE="1690000008" TAGS="a,b">Unfiled</A>
    </DL><p>
    <DT><H3 ADD_DATE="1690000009" LAST_MODIFIED="1690000010">Mozilla Firefox</H3>
    <DL><p>
        <DT><A HREF="https://support.mozilla.org/products/firefox" ADD_DATE="1690000011">Help and Tutorials</A>
    </DL><p>
</DL>
`

const SAFARI = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<HTML>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<Title>Bookmarks</Title>
<H1>Bookmarks</H1>
<DT><H3 FOLDED>Favorites</H3>
<DL><p>
<DT><A HREF="https://www.apple.com/">Apple</A>
<DT><A HREF="https://www.icloud.com/">iCloud</A>
</DL><p>
<DT><H3 FOLDED>Bookmarks Menu</H3>
<DL><p>
<DT><H3 FOLDED>News</H3>
<DL><p>
<DT><A HREF="https://news.example/">Some news</A>
</DL><p>
</DL><p>
<DT><A HREF="https://loose.example/">Loose at the end</A>
</HTML>
`

const EDGE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Favorites</TITLE>
<H1>Favorites</H1>
<DL><p>
    <DT><H3 ADD_DATE="1690000000" LAST_MODIFIED="1690000001" PERSONAL_TOOLBAR_FOLDER="true">Favorites bar</H3>
    <DL><p>
        <DT><A HREF="https://www.microsoft.com/" ADD_DATE="1690000002">Microsoft</A>
    </DL><p>
    <DT><H3 ADD_DATE="1690000003" LAST_MODIFIED="1690000004">Other favorites</H3>
    <DL><p>
        <DT><A HREF="https://bing.com/" ADD_DATE="1690000005">Bing</A>
    </DL><p>
</DL><p>
`

describe('parseNetscapeHtml', () => {
  it('reads a Chrome export: toolbar flag, nesting, dates, icons and entities', () => {
    const doc = parseNetscapeHtml(CHROME)
    expect(doc.title).toBe('Bookmarks')
    expect(shape(doc.items)).toEqual([
      [
        'Bookmarks bar',
        [
          ['Example & Co', 'https://example.com/'],
          ['Work', [['Docs', 'https://docs.example.com/a?b=1&c=2']]]
        ]
      ],
      ['Other page', 'https://other.example.com/'],
      ['Mobile bookmarks', [['Mobile page', 'https://m.example.com/']]]
    ])
    const bar = doc.items[0] as NetscapeFolder
    expect(bar.toolbar).toBe(true)
    expect(bar.addDate).toBe(1_690_000_000_000)
    expect(bar.lastModified).toBe(1_690_000_100_000)
    const example = bar.children[0]
    expect(example.type === 'url' && example.icon).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(example.addDate).toBe(1_690_000_001_000)
    expect((doc.items[2] as NetscapeFolder).toolbar).toBe(false)
  })

  it('reads a Firefox export: DD descriptions, HR, place: queries, unfiled flag, ICON_URI', () => {
    const doc = parseNetscapeHtml(FIREFOX)
    expect(shape(doc.items)).toEqual([
      [
        'Bookmarks Toolbar',
        [
          ['Getting Started', 'https://www.mozilla.org/firefox/central/'],
          ['Nested', [['Deep', 'https://deep.example/']]]
        ]
      ],
      ['Other Bookmarks', [['Unfiled', 'https://unfiled.example/']]],
      ['Mozilla Firefox', [['Help and Tutorials', 'https://support.mozilla.org/products/firefox']]]
    ])
    const toolbar = doc.items[0] as NetscapeFolder
    expect(toolbar.toolbar).toBe(true)
    const started = toolbar.children[0]
    // The data URI wins over the remote ICON_URI when both are present.
    expect(started.type === 'url' && started.icon).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect((doc.items[1] as NetscapeFolder).unfiled).toBe(true)
  })

  it('reads a Safari export: no outer DL, FOLDED headings, loose trailing bookmark', () => {
    const doc = parseNetscapeHtml(SAFARI)
    expect(shape(doc.items)).toEqual([
      [
        'Favorites',
        [
          ['Apple', 'https://www.apple.com/'],
          ['iCloud', 'https://www.icloud.com/']
        ]
      ],
      ['Bookmarks Menu', [['News', [['Some news', 'https://news.example/']]]]],
      ['Loose at the end', 'https://loose.example/']
    ])
  })

  it('reads an Edge export like Chrome', () => {
    const doc = parseNetscapeHtml(EDGE)
    expect(doc.title).toBe('Favorites')
    expect(shape(doc.items)).toEqual([
      ['Favorites bar', [['Microsoft', 'https://www.microsoft.com/']]],
      ['Other favorites', [['Bing', 'https://bing.com/']]]
    ])
    expect((doc.items[0] as NetscapeFolder).toolbar).toBe(true)
  })

  it('survives malformed nesting: unclosed tags, headings without lists, stray closers', () => {
    const html = `<DL>
      <DT><H3>Empty heading
      <DT><A HREF="https://a.example/">A
      <DT><H3>Folder<DL>
        <DT><A HREF="https://b.example/">B</A>
        <DT><A HREF="https://c.example/">C</A>
      </DL></DL></DL></DL>
      <DT><A HREF="https://d.example/">D</A>
      <DT><H3>Trailing empty</H3>`
    const doc = parseNetscapeHtml(html)
    expect(shape(doc.items)).toEqual([
      ['Empty heading', []],
      ['A', 'https://a.example/'],
      [
        'Folder',
        [
          ['B', 'https://b.example/'],
          ['C', 'https://c.example/']
        ]
      ],
      ['D', 'https://d.example/'],
      ['Trailing empty', []]
    ])
  })

  it('treats anonymous nested lists as belonging to the enclosing folder', () => {
    const html = `<DL><p>
      <DT><H3>F</H3>
      <DL><p>
        <DL><p><DT><A HREF="https://x.example/">X</A></DL><p>
        <DT><A HREF="https://y.example/">Y</A>
      </DL><p>
      <DT><A HREF="https://z.example/">Z</A>
    </DL><p>`
    expect(shape(parseNetscapeHtml(html).items)).toEqual([
      [
        'F',
        [
          ['X', 'https://x.example/'],
          ['Y', 'https://y.example/']
        ]
      ],
      ['Z', 'https://z.example/']
    ])
  })

  it('skips javascript:, place: and other non-web links and uses the URL as a fallback title', () => {
    const html = `<DL><p>
      <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
      <DT><A HREF="place:folder=TOOLBAR">Query</A>
      <DT><A HREF="">Empty</A>
      <DT><A HREF="https://untitled.example/"></A>
      <DT><A HREF="  https://spaced.example/  ">Spaced</A>
    </DL><p>`
    expect(shape(parseNetscapeHtml(html).items)).toEqual([
      ['https://untitled.example/', 'https://untitled.example/'],
      ['Spaced', 'https://spaced.example/']
    ])
  })

  it('accepts single-quoted and unquoted attributes and case-insensitive tags', () => {
    const html = `<dl><p><dt><h3 add_date='1690000000' personal_toolbar_folder=true>Bar</h3><dl><p>
      <dt><a href='https://q.example/' add_date=1690000001>Q</a></dl><p></dl><p>`
    const doc = parseNetscapeHtml(html)
    const bar = doc.items[0] as NetscapeFolder
    expect(bar.toolbar).toBe(true)
    expect(bar.addDate).toBe(1_690_000_000_000)
    expect(shape(bar.children)).toEqual([['Q', 'https://q.example/']])
  })

  it('returns an empty document for unrelated HTML', () => {
    expect(parseNetscapeHtml('<html><body><p>Hello</p></body></html>').items).toEqual([])
    expect(parseNetscapeHtml('').items).toEqual([])
  })
})

describe('helpers', () => {
  it('detects bookmark files by doctype or by their skeleton', () => {
    expect(isNetscapeBookmarkFile(CHROME)).toBe(true)
    expect(isNetscapeBookmarkFile('<DL><p><DT><A HREF="x">x</A></DL>')).toBe(true)
    expect(isNetscapeBookmarkFile('<html><body>no</body></html>')).toBe(false)
  })

  it('normalises seconds, milliseconds and microseconds to milliseconds', () => {
    expect(parseNetscapeDate('1690000000')).toBe(1_690_000_000_000)
    expect(parseNetscapeDate('1690000000000')).toBe(1_690_000_000_000)
    expect(parseNetscapeDate('1690000000000000')).toBe(1_690_000_000_000)
    expect(parseNetscapeDate('0')).toBeUndefined()
    expect(parseNetscapeDate('garbage')).toBeUndefined()
    expect(parseNetscapeDate(undefined)).toBeUndefined()
  })

  it('decodes named, decimal and hex entities', () => {
    expect(
      decodeEntities('A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#x27; &nbsp;&#233;&unknown;')
    ).toBe('A & B <c> "d" \'e\' \u00a0é&unknown;')
  })
})

function target(barIsEmpty: boolean, tree: BookmarkTree): ImportTarget {
  let seq = 0
  return {
    barIsEmpty,
    nextIndex: (parentId) => tree.children(parentId).length,
    newId: () => `imp_${++seq}`,
    now: NOW,
    importedFolderTitle: 'Imported'
  }
}

describe('planNetscapeImport', () => {
  it('merges into the roots when the bookmarks bar is empty: toolbar folder becomes the bar', () => {
    const tree = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      {
        id: 'existing',
        parentId: OTHER_BOOKMARKS_ID,
        index: 0,
        type: 'url',
        title: 'E',
        url: 'https://e/',
        dateAdded: 1
      }
    ])
    const plan = planNetscapeImport(parseNetscapeHtml(CHROME), target(true, tree))
    const all = normalizeBookmarkNodes([...tree.all(), ...plan.nodes], NOW)
    const t = new BookmarkTree(all)
    expect(t.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['Example & Co', 'Work'])
    expect(t.children('imp_2').map((n) => n.title)).toEqual(['Docs'])
    // Existing content keeps its place; the rest of the file is appended to Other bookmarks.
    expect(t.children(OTHER_BOOKMARKS_ID).map((n) => n.title)).toEqual([
      'E',
      'Other page',
      'Mobile bookmarks'
    ])
    expect(plan.bookmarks).toBe(4)
    expect(plan.folders).toBe(2)
    expect(plan.folderId).toBe(BOOKMARKS_BAR_ID)
    expect(t.get('imp_1')).toMatchObject({
      dateAdded: 1_690_000_001_000,
      favicon: 'data:image/png;base64,iVBORw0KGgo='
    })
    expect(t.get('imp_2')).toMatchObject({
      dateAdded: 1_690_000_002_000,
      dateGroupModified: 1_690_000_003_000
    })
  })

  it('spreads Firefox unfiled bookmarks into Other bookmarks when merging', () => {
    const tree = new BookmarkTree(createBookmarkRoots(NOW))
    const plan = planNetscapeImport(parseNetscapeHtml(FIREFOX), target(true, tree))
    const t = new BookmarkTree(normalizeBookmarkNodes([...tree.all(), ...plan.nodes], NOW))
    expect(t.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['Getting Started', 'Nested'])
    expect(t.children(OTHER_BOOKMARKS_ID).map((n) => n.title)).toEqual([
      'Unfiled',
      'Mozilla Firefox'
    ])
  })

  it('points at Other bookmarks when the merged file had no toolbar folder', () => {
    const tree = new BookmarkTree(createBookmarkRoots(NOW))
    const plan = planNetscapeImport(parseNetscapeHtml(SAFARI), target(true, tree))
    expect(plan.folderId).toBe(OTHER_BOOKMARKS_ID)
    const t = new BookmarkTree(normalizeBookmarkNodes([...tree.all(), ...plan.nodes], NOW))
    expect(t.children(OTHER_BOOKMARKS_ID).map((n) => n.title)).toEqual([
      'Favorites',
      'Bookmarks Menu',
      'Loose at the end'
    ])
  })

  it('puts everything into one Imported folder on the bar when the bar already has content', () => {
    const tree = new BookmarkTree([
      ...createBookmarkRoots(NOW),
      {
        id: 'mine',
        parentId: BOOKMARKS_BAR_ID,
        index: 0,
        type: 'url',
        title: 'Mine',
        url: 'https://mine/',
        dateAdded: 1
      }
    ])
    const plan = planNetscapeImport(parseNetscapeHtml(CHROME), target(false, tree))
    const t = new BookmarkTree(normalizeBookmarkNodes([...tree.all(), ...plan.nodes], NOW))
    const imported = t.get(plan.folderId)!
    expect(imported).toMatchObject({
      parentId: BOOKMARKS_BAR_ID,
      index: 1,
      title: 'Imported',
      type: 'folder'
    })
    // The foreign toolbar's contents sit at the top of the Imported folder.
    expect(t.children(imported.id).map((n) => n.title)).toEqual([
      'Example & Co',
      'Work',
      'Other page',
      'Mobile bookmarks'
    ])
    // The container is ours, not the file's: only Work and Mobile bookmarks count.
    expect(plan.folders).toBe(2)
  })

  it('drops oversized data-URI icons but keeps remote icon URLs', () => {
    const big = `data:image/png;base64,${'A'.repeat(9000)}`
    const html = `<DL><p>
      <DT><A HREF="https://big.example/" ICON="${big}">Big</A>
      <DT><A HREF="https://remote.example/" ICON_URI="https://remote.example/favicon.ico">Remote</A>
    </DL><p>`
    const tree = new BookmarkTree(createBookmarkRoots(NOW))
    const plan = planNetscapeImport(parseNetscapeHtml(html), target(true, tree))
    expect(plan.nodes.find((n) => n.title === 'Big')?.favicon).toBeUndefined()
    expect(plan.nodes.find((n) => n.title === 'Remote')?.favicon).toBe(
      'https://remote.example/favicon.ico'
    )
  })
})

describe('serializeNetscapeHtml', () => {
  const nodes: BookmarkNode[] = normalizeBookmarkNodes(
    [
      ...createBookmarkRoots(NOW),
      {
        id: 'w',
        parentId: BOOKMARKS_BAR_ID,
        index: 0,
        type: 'folder',
        title: 'Work <&>',
        dateAdded: 1_690_000_000_000,
        dateGroupModified: 1_690_000_050_000
      },
      {
        id: 'd',
        parentId: 'w',
        index: 0,
        type: 'url',
        title: 'Docs "quoted"',
        url: 'https://docs.example/?a=1&b=2',
        dateAdded: 1_690_000_001_000,
        favicon: 'data:image/png;base64,AAAA'
      },
      {
        id: 'o',
        parentId: OTHER_BOOKMARKS_ID,
        index: 0,
        type: 'url',
        title: 'Other',
        url: 'https://other.example/',
        dateAdded: 1_690_000_002_000,
        favicon: 'https://other.example/favicon.ico'
      },
      {
        id: 'm',
        parentId: MOBILE_BOOKMARKS_ID,
        index: 0,
        type: 'url',
        title: 'Mobile',
        url: 'https://m.example/',
        dateAdded: 1_690_000_003_000
      }
    ],
    NOW
  )
  const html = serializeNetscapeHtml(new BookmarkTree(nodes), { product: 'Zenium 1.2.3', now: NOW })

  it('writes the Netscape skeleton with a Zenium header comment', () => {
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n')).toBe(true)
    expect(html).toContain('<!-- Exported by Zenium 1.2.3 on 2023-11-14T22:13:20.000Z -->')
    expect(html).toContain('<TITLE>Bookmarks</TITLE>')
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>')
    expect(html).toContain(
      'ADD_DATE="1690000000" LAST_MODIFIED="1690000050">Work &lt;&amp;&gt;</H3>'
    )
    expect(html).toContain(
      '<DT><A HREF="https://docs.example/?a=1&amp;b=2" ADD_DATE="1690000001" ICON="data:image/png;base64,AAAA">Docs "quoted"</A>'
    )
    expect(html).toContain('ICON_URI="https://other.example/favicon.ico">Other</A>')
    expect(html).toContain('>Mobile bookmarks</H3>')
    expect(isNetscapeBookmarkFile(html)).toBe(true)
  })

  it('omits an empty Mobile bookmarks folder', () => {
    const tree = new BookmarkTree(nodes.filter((n) => n.id !== 'm'))
    expect(serializeNetscapeHtml(tree, { product: 'Zenium', now: NOW })).not.toContain(
      'Mobile bookmarks'
    )
  })

  it('round-trips through the parser and the merge import', () => {
    const doc = parseNetscapeHtml(html)
    expect(shape(doc.items)).toEqual([
      ['Bookmarks bar', [['Work <&>', [['Docs "quoted"', 'https://docs.example/?a=1&b=2']]]]],
      ['Other', 'https://other.example/'],
      ['Mobile bookmarks', [['Mobile', 'https://m.example/']]]
    ])
    const fresh = new BookmarkTree(createBookmarkRoots(NOW))
    const plan = planNetscapeImport(doc, target(true, fresh))
    const t = new BookmarkTree(normalizeBookmarkNodes([...fresh.all(), ...plan.nodes], NOW))
    expect(t.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['Work <&>'])
    expect(t.children(OTHER_BOOKMARKS_ID).map((n) => n.title)).toEqual([
      'Other',
      'Mobile bookmarks'
    ])
    const docs = t.all().find((n) => n.title === 'Docs "quoted"')!
    expect(docs).toMatchObject({
      url: 'https://docs.example/?a=1&b=2',
      dateAdded: 1_690_000_001_000,
      favicon: 'data:image/png;base64,AAAA'
    })
  })
})
