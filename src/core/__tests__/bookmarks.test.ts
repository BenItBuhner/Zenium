import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform, Tab } from '../../shared/types'
import {
  BOOKMARKS_BAR_ID,
  BOOKMARK_ROOT_IDS,
  BOOKMARK_SCHEMA_VERSION,
  BookmarkTree,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  isBookmarkRoot
} from '../../shared/bookmarks'
import type { StoreIO } from '../platform'
import { BookmarkService } from '../bookmarks'
import { BrowserState, PERSISTED_VERSION } from '../state'

function fakeIo(initial: string | null = null): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => initial,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

function setup(
  platform: Platform = 'linux',
  initial: string | null = null
): { state: BrowserState; service: BookmarkService; io: ReturnType<typeof fakeIo> } {
  const io = fakeIo(initial)
  const state = new BrowserState(io, platform, {} as HostCapabilities, '0.0')
  state.load()
  return { state, service: new BookmarkService(state), io }
}

/** The invariants every write must leave intact. */
function expectValid(service: BookmarkService): void {
  const nodes = service.all()
  const tree = new BookmarkTree(nodes)
  expect(tree.roots().map((r) => r.id)).toEqual([...BOOKMARK_ROOT_IDS])
  for (const node of nodes) {
    if (isBookmarkRoot(node.id)) {
      expect(node.parentId).toBeNull()
      continue
    }
    const path = tree.path(node.id)
    expect(path.length).toBeGreaterThan(0)
    expect(isBookmarkRoot(path[0].id)).toBe(true)
  }
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    const children = tree.children(node.id)
    expect(children.map((c) => c.index)).toEqual(children.map((_, i) => i))
  }
  expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
}

describe('BookmarkService: create, update, move, remove', () => {
  it('starts with the three roots only', () => {
    const { service } = setup()
    expect(service.all().map((n) => n.id)).toEqual([...BOOKMARK_ROOT_IDS])
    expect(service.getTree().map((r) => r.children?.length)).toEqual([0, 0, 0])
    expectValid(service)
  })

  it('creates bookmarks and folders in the default folder and at explicit indices', () => {
    const { service } = setup()
    const a = service.create({ title: 'A', url: 'https://a/' })!
    expect(a.parentId).toBe(OTHER_BOOKMARKS_ID)
    expect(a.index).toBe(0)
    const folder = service.createFolder(OTHER_BOOKMARKS_ID, 'F', 0)!
    expect(folder.type).toBe('folder')
    expect(service.getChildren(OTHER_BOOKMARKS_ID).map((n) => n.id)).toEqual([folder.id, a.id])
    const b = service.create({
      parentId: folder.id,
      title: '',
      url: 'https://b/',
      favicon: 'data:x'
    })!
    expect(b.title).toBe('https://b/')
    expect(b.favicon).toBe('data:x')
    // Out-of-range indices clamp to the end; an unknown parent falls back to the default folder.
    const c = service.create({
      parentId: OTHER_BOOKMARKS_ID,
      index: 99,
      title: 'C',
      url: 'https://c/'
    })!
    expect(c.index).toBe(2)
    const d = service.create({ parentId: 'missing', title: 'D', url: 'https://d/' })!
    expect(d.parentId).toBe(OTHER_BOOKMARKS_ID)
    expect(service.create({ title: 'no url', type: 'url' })).toBeNull()
    expect(service.get(folder.id)?.dateGroupModified).toBeGreaterThan(0)
    expectValid(service)
  })

  it('uses Mobile bookmarks as the default on Android', () => {
    const { service } = setup('android')
    expect(service.create({ title: 'A', url: 'https://a/' })?.parentId).toBe(MOBILE_BOOKMARKS_ID)
  })

  it('files the next star into the folder used most recently', () => {
    const { service } = setup()
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'Recent')!
    service.create({ parentId: folder.id, title: 'A', url: 'https://a/' })
    expect(service.defaultFolderId()).toBe(folder.id)
    expect(service.create({ title: 'B', url: 'https://b/' })?.parentId).toBe(folder.id)
  })

  it('updates titles, URLs and favicons but never the roots', () => {
    const { service } = setup()
    const a = service.create({ title: 'A', url: 'https://a/' })!
    expect(service.update(a.id, { title: 'Renamed', url: 'https://renamed/' })).toMatchObject({
      title: 'Renamed',
      url: 'https://renamed/'
    })
    service.update(a.id, { favicon: 'data:icon' })
    expect(service.get(a.id)?.favicon).toBe('data:icon')
    service.update(a.id, { favicon: null as unknown as string })
    expect(service.get(a.id)?.favicon).toBeUndefined()
    expect(service.update(BOOKMARKS_BAR_ID, { title: 'Nope' })).toBeNull()
    expect(service.get(BOOKMARKS_BAR_ID)?.title).toBe('Bookmarks bar')
    const f = service.createFolder(OTHER_BOOKMARKS_ID, 'F')!
    service.update(f.id, { url: 'https://ignored/' })
    expect(service.get(f.id)?.url).toBeUndefined()
  })

  it('moves nodes between folders and reorders within one, keeping the moved order', () => {
    const { service } = setup()
    const ids = ['a', 'b', 'c', 'd'].map(
      (t) => service.create({ parentId: OTHER_BOOKMARKS_ID, title: t, url: `https://${t}/` })!.id
    )
    const titles = (parent: string): string[] => service.getChildren(parent).map((n) => n.title)
    // Move a to the end.
    expect(service.move([ids[0]], OTHER_BOOKMARKS_ID)).toBe(true)
    expect(titles(OTHER_BOOKMARKS_ID)).toEqual(['b', 'c', 'd', 'a'])
    // Move d to the front.
    service.move([ids[3]], OTHER_BOOKMARKS_ID, 0)
    expect(titles(OTHER_BOOKMARKS_ID)).toEqual(['d', 'b', 'c', 'a'])
    // Move b and a together so that b lands at index 1 (counted without the moving nodes).
    service.move([ids[1], ids[0]], OTHER_BOOKMARKS_ID, 1)
    expect(titles(OTHER_BOOKMARKS_ID)).toEqual(['d', 'b', 'a', 'c'])
    // Across folders.
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'F')!
    service.move([ids[2], ids[3]], folder.id)
    expect(titles(folder.id)).toEqual(['c', 'd'])
    expect(titles(OTHER_BOOKMARKS_ID)).toEqual(['b', 'a'])
    expect(service.get(folder.id)?.dateGroupModified).toBeGreaterThan(0)
    expectValid(service)
  })

  it('refuses to move roots, a folder into itself or into its own subtree', () => {
    const { service } = setup()
    const outer = service.createFolder(BOOKMARKS_BAR_ID, 'Outer')!
    const inner = service.createFolder(outer.id, 'Inner')!
    expect(service.move([BOOKMARKS_BAR_ID], OTHER_BOOKMARKS_ID)).toBe(false)
    expect(service.move([outer.id], outer.id)).toBe(false)
    expect(service.move([outer.id], inner.id)).toBe(false)
    expect(service.move([outer.id], 'nowhere')).toBe(false)
    expect(service.get(outer.id)?.parentId).toBe(BOOKMARKS_BAR_ID)
    // A folder and its descendant selected together: only the folder moves.
    expect(service.move([inner.id, outer.id], OTHER_BOOKMARKS_ID)).toBe(true)
    expect(service.get(outer.id)?.parentId).toBe(OTHER_BOOKMARKS_ID)
    expect(service.get(inner.id)?.parentId).toBe(outer.id)
    expectValid(service)
  })

  it('removes bookmarks and empty folders; removeTree takes whole subtrees; roots stay', () => {
    const { service } = setup()
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'F')!
    const a = service.create({ parentId: folder.id, title: 'A', url: 'https://a/' })!
    const b = service.create({ parentId: BOOKMARKS_BAR_ID, title: 'B', url: 'https://b/' })!
    expect(service.remove(folder.id)).toBe(false)
    expect(service.remove(a.id)).toBe(true)
    expect(service.remove(folder.id)).toBe(true)
    expect(service.remove(BOOKMARKS_BAR_ID)).toBe(false)
    expect(service.removeTree(OTHER_BOOKMARKS_ID)).toBe(false)
    const nested = service.createFolder(OTHER_BOOKMARKS_ID, 'N')!
    service.create({ parentId: nested.id, title: 'X', url: 'https://x/' })
    expect(service.removeTree(nested.id)).toBe(true)
    expect(service.all().map((n) => n.id)).toEqual([
      BOOKMARKS_BAR_ID,
      b.id,
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID
    ])
    expect(service.removeMany([b.id, 'ghost', MOBILE_BOOKMARKS_ID])).toBe(1)
    expectValid(service)
  })

  it('keeps tabs.bookmarked in step with the tree', () => {
    const { state, service } = setup()
    const tab = { id: 't1', url: 'https://a/', bookmarked: false } as unknown as Tab
    state.model.tabs[tab.id] = tab
    const a = service.create({ title: 'A', url: 'https://a/' })!
    expect(tab.bookmarked).toBe(true)
    service.removeByUrl('https://a/')
    expect(tab.bookmarked).toBe(false)
    expect(service.get(a.id)).toBeNull()
  })

  it('records last use and fills in missing favicons', () => {
    const { service } = setup()
    const a = service.create({ title: 'A', url: 'https://a/' })!
    const b = service.create({ title: 'A again', url: 'https://a/', favicon: 'data:keep' })!
    service.touch(a.id)
    expect(service.get(a.id)?.dateLastUsed).toBeGreaterThan(0)
    service.updateFavicon('https://a/', 'data:new')
    expect(service.get(a.id)?.favicon).toBe('data:new')
    expect(service.get(b.id)?.favicon).toBe('data:keep')
    expect(service.recent(5).map((n) => n.id)).toEqual([b.id, a.id])
  })
})

describe('BookmarkService: search and paths', () => {
  it('finds bookmarks across folders and labels their folder path', () => {
    const { service } = setup()
    const work = service.createFolder(BOOKMARKS_BAR_ID, 'Work')!
    const docs = service.createFolder(work.id, 'Docs')!
    const spec = service.create({ parentId: docs.id, title: 'Spec', url: 'https://spec.example/' })!
    service.create({
      parentId: OTHER_BOOKMARKS_ID,
      title: 'Specials',
      url: 'https://shop.example/'
    })
    expect(service.searchUrls('spec').map((n) => n.title)).toEqual(['Spec', 'Specials'])
    expect(service.searchUrls('spec', 1).length).toBe(1)
    expect(
      service
        .search('docs')
        .map((n) => n.title)
        .sort()
    ).toEqual(['Docs', 'Spec'])
    expect(service.pathLabel(spec.id)).toBe('Bookmarks bar / Work / Docs')
    expect(service.path(spec.id).map((n) => n.id)).toEqual([BOOKMARKS_BAR_ID, work.id, docs.id])
    expect(service.has('https://spec.example/')).toBe(true)
    expect(service.findByUrl('https://spec.example/').map((n) => n.id)).toEqual([spec.id])
    expect(service.getSubTree(work.id)?.children?.[0].children?.[0].id).toBe(spec.id)
  })
})

describe('BookmarkService: cut, copy and paste', () => {
  it('cut + paste moves; copy + paste duplicates whole subtrees with fresh ids', () => {
    const { service } = setup()
    const folder = service.createFolder(BOOKMARKS_BAR_ID, 'F')!
    const a = service.create({ parentId: folder.id, title: 'A', url: 'https://a/' })!
    const target = service.createFolder(OTHER_BOOKMARKS_ID, 'Target')!
    expect(service.canPaste()).toBe(false)
    service.cut([a.id])
    expect(service.canPaste()).toBe(true)
    expect(service.paste(target.id)).toBe(true)
    expect(service.get(a.id)?.parentId).toBe(target.id)
    expect(service.canPaste()).toBe(false)

    service.copy([folder.id, a.id])
    expect(service.paste(OTHER_BOOKMARKS_ID, 0)).toBe(true)
    const other = service.getChildren(OTHER_BOOKMARKS_ID)
    expect(other.map((n) => n.title)).toEqual(['F', 'A', 'Target'])
    expect(other[0].id).not.toBe(folder.id)
    expect(other[1].id).not.toBe(a.id)
    expect(service.getChildren(other[0].id)).toEqual([])
    // Copies stay on the clipboard and can be pasted again.
    expect(service.canPaste()).toBe(true)
    expect(service.paste(target.id)).toBe(true)
    expect(service.getChildren(target.id).map((n) => n.title)).toEqual(['A', 'F', 'A'])
    expectValid(service)
  })

  it('never pastes a folder into its own subtree and drops deleted clipboard entries', () => {
    const { service } = setup()
    const outer = service.createFolder(BOOKMARKS_BAR_ID, 'Outer')!
    const inner = service.createFolder(outer.id, 'Inner')!
    service.copy([outer.id])
    expect(service.paste(inner.id)).toBe(false)
    service.cut([inner.id])
    service.removeTree(inner.id)
    expect(service.canPaste()).toBe(false)
    expect(service.paste(OTHER_BOOKMARKS_ID)).toBe(false)
  })
})

describe('BookmarkService: bulk operations', () => {
  const tab = (url: string, title: string, custom?: string): Tab =>
    ({ url, title, customTitle: custom, favicon: null }) as unknown as Tab

  it('bookmarks all tabs into one new folder in tab order', () => {
    const { service } = setup()
    const folder = service.bookmarkTabs(
      [
        tab('https://one/', 'One'),
        tab('zen://newtab', 'New tab'),
        tab('https://two/', 'Two', 'Custom')
      ],
      'Space'
    )!
    expect(folder.parentId).toBe(OTHER_BOOKMARKS_ID)
    expect(service.getChildren(folder.id).map((n) => [n.title, n.url])).toEqual([
      ['One', 'https://one/'],
      ['Custom', 'https://two/']
    ])
    expect(service.bookmarkTabs([tab('zen://settings', 'S')], 'Empty')).toBeNull()
    expectValid(service)
  })

  it('imports Netscape HTML into the roots, then into an Imported folder, and exports it back', () => {
    const { service, state } = setup()
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bar</H3>
  <DL><p><DT><A HREF="https://bar.example/" ADD_DATE="1690000000">Bar link</A></DL><p>
  <DT><A HREF="https://other.example/">Other link</A>
</DL><p>`
    const first = service.importHtml(html)!
    expect(first).toMatchObject({ bookmarks: 2, folders: 0, folderId: BOOKMARKS_BAR_ID })
    expect(service.getChildren(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['Bar link'])
    expect(service.getChildren(OTHER_BOOKMARKS_ID).map((n) => n.title)).toEqual(['Other link'])

    const second = service.importHtml(html)!
    const imported = service.get(second.folderId)!
    expect(imported).toMatchObject({ title: 'Imported', parentId: BOOKMARKS_BAR_ID, index: 1 })
    expect(service.getChildren(imported.id).map((n) => n.title)).toEqual(['Bar link', 'Other link'])
    const third = service.importHtml(html)!
    expect(service.get(third.folderId)?.title).toBe('Imported (2)')
    expect(service.importHtml('<p>nothing here</p>')).toBeNull()

    const exported = service.exportHtml('Zenium 9.9')
    expect(exported).toContain('<!-- Exported by Zenium 9.9 on ')
    expect(exported).toContain('PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>')
    expect(exported).toContain('>Imported (2)</H3>')
    expect(exported.match(/HREF="https:\/\/bar\.example\/"/g)?.length).toBe(3)
    expect(state.platform).toBe('linux')
    expectValid(service)
  })
})

describe('BookmarkService: sync', () => {
  it('applies remote nodes per id, keeps local-only metadata, and repairs on commit', () => {
    const { service, state } = setup()
    const a = service.create({ title: 'A', url: 'https://a/' })!
    service.touch(a.id)
    const used = service.get(a.id)!.dateLastUsed!
    service.applySynced(a.id, {
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
      type: 'url',
      title: 'A synced',
      url: 'https://a/',
      dateAdded: 5
    })
    service.applySynced('remote_folder', {
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
      type: 'folder',
      title: 'Remote',
      dateAdded: 6
    })
    service.applySynced('remote_child', {
      parentId: 'remote_folder',
      index: 3,
      type: 'url',
      title: 'Child',
      url: 'https://child/',
      dateAdded: 7
    })
    // Roots and URL-less bookmarks are ignored.
    service.applySynced(BOOKMARKS_BAR_ID, {
      parentId: OTHER_BOOKMARKS_ID,
      index: 0,
      type: 'folder',
      title: 'X',
      dateAdded: 1
    })
    service.applySynced('bad', {
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
      type: 'url',
      title: 'No URL',
      dateAdded: 1
    })
    state.repair()
    expectValid(service)
    expect(service.get(a.id)).toMatchObject({
      parentId: BOOKMARKS_BAR_ID,
      title: 'A synced',
      dateLastUsed: used
    })
    // Both claimed index 0; the older node (dateAdded 5) keeps the slot on every device.
    expect(service.getChildren(BOOKMARKS_BAR_ID).map((n) => n.id)).toEqual([a.id, 'remote_folder'])
    expect(service.get('remote_child')?.index).toBe(0)
    expect(service.get('bad')).toBeNull()
    expect(service.get(BOOKMARKS_BAR_ID)?.parentId).toBeNull()
    service.removeSynced('remote_folder')
    service.removeSynced(BOOKMARKS_BAR_ID)
    state.repair()
    // The orphaned child is re-homed rather than lost.
    expect(service.get('remote_child')?.parentId).toBe(OTHER_BOOKMARKS_ID)
    expect(service.get(BOOKMARKS_BAR_ID)).not.toBeNull()
    expectValid(service)
  })
})

describe('BrowserState: bookmark persistence', () => {
  const legacyProfile = (platformNote: string): string =>
    JSON.stringify({
      version: 2,
      spaces: [],
      tabs: [],
      essentialTabIds: [],
      activeSpaceId: 'space_1',
      containers: [],
      folders: [],
      splitGroups: [],
      settings: {},
      shortcutOverrides: {},
      bookmarks: [
        { id: 'b_new', url: 'https://new/', title: 'Newest', favicon: 'data:i', createdAt: 3000 },
        {
          id: 'b_old',
          url: 'https://old/',
          title: `Oldest ${platformNote}`,
          favicon: null,
          createdAt: 1000
        }
      ],
      windows: []
    })

  it('migrates a v2 flat list into Other bookmarks in stored order with dates and ids kept', async () => {
    const { state, io } = setup('linux', legacyProfile('desktop'))
    const tree = new BookmarkTree(state.bookmarks)
    expect(tree.children(OTHER_BOOKMARKS_ID).map((n) => n.id)).toEqual(['b_new', 'b_old'])
    expect(tree.get('b_new')).toMatchObject({ dateAdded: 3000, favicon: 'data:i', type: 'url' })
    expect(tree.get('b_old')?.dateAdded).toBe(1000)
    expect(tree.children(MOBILE_BOOKMARKS_ID)).toEqual([])

    await state.flush()
    const written = JSON.parse(io.writes.at(-1)!) as {
      version: number
      bookmarks?: unknown
      bookmarkTree: { schemaVersion: number; nodes: unknown[] }
    }
    expect(written.version).toBe(PERSISTED_VERSION)
    expect(written.bookmarks).toBeUndefined()
    expect(written.bookmarkTree.schemaVersion).toBe(BOOKMARK_SCHEMA_VERSION)
    expect(written.bookmarkTree.nodes).toEqual(state.bookmarks)

    // Loading the migrated file again is a no-op (idempotent migration).
    const again = setup('linux', io.writes.at(-1)!)
    expect(again.state.bookmarks).toEqual(state.bookmarks)
  })

  it('migrates into Mobile bookmarks on Android', () => {
    const { state } = setup('android', legacyProfile('phone'))
    const tree = new BookmarkTree(state.bookmarks)
    expect(tree.children(MOBILE_BOOKMARKS_ID).map((n) => n.id)).toEqual(['b_new', 'b_old'])
    expect(tree.children(OTHER_BOOKMARKS_ID)).toEqual([])
  })

  it('repairs a damaged v3 tree on load and starts fresh without a profile', () => {
    const damaged = JSON.stringify({
      version: 3,
      spaces: [],
      tabs: [],
      essentialTabIds: [],
      activeSpaceId: 'space_1',
      containers: [],
      folders: [],
      splitGroups: [],
      settings: {},
      shortcutOverrides: {},
      bookmarkTree: {
        schemaVersion: 1,
        nodes: [
          {
            id: 'orphan',
            parentId: 'gone',
            index: 4,
            type: 'url',
            title: 'O',
            url: 'https://o/',
            dateAdded: 1
          },
          { id: '2', parentId: '1', index: 0, type: 'folder', title: 'Renamed root', dateAdded: 1 }
        ]
      },
      windows: []
    })
    const { state, service } = setup('linux', damaged)
    expectValid(service)
    const tree = new BookmarkTree(state.bookmarks)
    expect(tree.get('orphan')?.parentId).toBe(OTHER_BOOKMARKS_ID)
    expect(tree.get(OTHER_BOOKMARKS_ID)).toMatchObject({ parentId: null, title: 'Other bookmarks' })

    const fresh = setup()
    expect(fresh.state.bookmarks.map((n) => n.id)).toEqual([...BOOKMARK_ROOT_IDS])
  })
})
