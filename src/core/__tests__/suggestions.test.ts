import { describe, expect, it } from 'vitest'
import type { HostCapabilities } from '../../shared/types'
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '../../shared/bookmarks'
import type { StoreIO } from '../platform'
import type { Browser } from '../browser'
import { BookmarkService } from '../bookmarks'
import { HistoryService } from '../history'
import { BrowserState } from '../state'
import { SuggestionService } from '../suggestions'
import { ZenWindow } from '../window'

const io: StoreIO = {
  readSync: () => null,
  write: async () => {},
  writeSync: () => {}
}

function setup(kind: 'synced' | 'private' = 'synced'): {
  suggestions: SuggestionService
  bookmarks: BookmarkService
  history: HistoryService
  win: ZenWindow
} {
  const state = new BrowserState(io, 'linux', {} as HostCapabilities, '0.0')
  state.load()
  // Live engine suggestions need the network; the URL bar's local sources are under test.
  state.settings.searchSuggestions = false
  const bookmarks = new BookmarkService(state)
  const history = new HistoryService(io)
  const browser = { state, bookmarks, history } as unknown as Browser
  const win = new ZenWindow(browser, {
    id: 'window_1',
    kind,
    bounds: null,
    maximized: false,
    activeSpaceId: state.model.activeSpaceId,
    selection: {},
    compact: false,
    localSpace: null
  })
  const suggestions = new SuggestionService(browser)
  return { suggestions, bookmarks, history, win }
}

describe('SuggestionService: bookmarks across folders', () => {
  it('lists bookmarks from nested folders with the folder path as subtitle', async () => {
    const { suggestions, bookmarks, win } = setup()
    const work = bookmarks.createFolder(BOOKMARKS_BAR_ID, 'Work')!
    const docs = bookmarks.createFolder(work.id, 'Docs')!
    const design = bookmarks.create({
      parentId: docs.id,
      title: 'Design docs',
      url: 'https://docs.example.com/'
    })!
    bookmarks.create({
      parentId: OTHER_BOOKMARKS_ID,
      title: 'Docs mirror',
      url: 'https://mirror.example.com/docs'
    })

    const results = await suggestions.suggest('docs', null, win)
    const hits = results.filter((r) => r.kind === 'bookmark')
    // A title that starts with the query outranks one that merely contains it.
    expect(hits.map((r) => r.url)).toEqual([
      'https://mirror.example.com/docs',
      'https://docs.example.com/'
    ])
    expect(hits[0].subtitle).toBe('Other bookmarks · mirror.example.com/docs')
    expect(hits[1].subtitle).toBe('Bookmarks bar / Work / Docs · docs.example.com')
    // Picking a bookmark suggestion opens the node (so dateLastUsed can be stamped).
    expect(hits[1].targetId).toBe(design.id)
  })

  it('matches by folder name and never suggests folders themselves', async () => {
    const { suggestions, bookmarks, win } = setup()
    const recipes = bookmarks.createFolder(OTHER_BOOKMARKS_ID, 'Recipes')!
    bookmarks.create({ parentId: recipes.id, title: 'Bread', url: 'https://bread.example/' })

    const results = await suggestions.suggest('recipes', null, win)
    const hits = results.filter((r) => r.kind === 'bookmark')
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Bread')
    expect(results.some((r) => r.targetId === recipes.id)).toBe(false)
  })

  it('caps bookmark hits at three and dedupes URLs already shown as history', async () => {
    const { suggestions, bookmarks, history, win } = setup()
    for (let i = 0; i < 5; i += 1) {
      bookmarks.create({ title: `News ${i}`, url: `https://news.example/${i}` })
    }
    history.visit('https://news.example/0', 'News 0', null)

    const results = await suggestions.suggest('news', null, win)
    const bm = results.filter((r) => r.kind === 'bookmark')
    expect(bm).toHaveLength(3)
    const urls = results.map((r) => r.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('keeps the existing order: url or search first, then tabs, bookmarks, history', async () => {
    const { suggestions, bookmarks, history, win } = setup()
    bookmarks.create({ title: 'Example', url: 'https://example.com/a' })
    history.visit('https://example.com/b', 'Example B', null)

    const results = await suggestions.suggest('example', null, win)
    const kinds = results.map((r) => r.kind)
    expect(kinds.indexOf('bookmark')).toBeGreaterThan(-1)
    expect(kinds.indexOf('history')).toBeGreaterThan(kinds.indexOf('bookmark'))
    expect(kinds.indexOf('bookmark')).toBeGreaterThan(kinds.indexOf('search'))
  })

  it('shows no bookmarks or history in a private window', async () => {
    const { suggestions, bookmarks, history, win } = setup('private')
    bookmarks.create({ title: 'Secret', url: 'https://secret.example/' })
    history.visit('https://secret.example/2', 'Secret 2', null)

    const results = await suggestions.suggest('secret', null, win)
    expect(results.some((r) => r.kind === 'bookmark' || r.kind === 'history')).toBe(false)
  })
})
