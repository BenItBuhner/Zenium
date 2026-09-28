import { describe, expect, it } from 'vitest'
import type {
  BookmarkNode,
  ClosedEntrySummary,
  DefaultBrowserStatus,
  DownloadItem
} from '@shared/types'
import type { SafetyHubInputs } from '@shared/safetyHubCard'
import {
  BOOKMARKS_CARD_LIMIT,
  MAGIC_STACK_MODULES,
  availableModules,
  buildCard,
  magicStackModule,
  pageAt,
  planMagicStack,
  type MagicStackSources
} from '../magicStackPlan'

function closed(over: Partial<ClosedEntrySummary> = {}): ClosedEntrySummary {
  return {
    id: 'c1',
    kind: 'tab',
    title: 'Closed page',
    url: 'https://closed.example/story',
    favicon: null,
    closedAt: 1_000,
    tabCount: 1,
    ...over
  }
}

function download(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'd1',
    url: 'https://files.example/report.pdf',
    referrer: '',
    filename: 'report.pdf',
    finalName: 'report.pdf',
    savePath: '/downloads/report.pdf',
    totalBytes: 2048,
    receivedBytes: 2048,
    state: 'completed',
    startedAt: 900,
    completedAt: 950,
    endedAt: 950,
    mimeType: 'application/pdf',
    canResume: false,
    danger: { level: 'safe', reason: 'none', message: '' },
    dangerAccepted: false,
    openWhenDone: false,
    bytesPerSecond: 0,
    etaMs: null,
    private: false,
    containerId: 'default',
    ...over
  } as DownloadItem
}

function bookmark(id: string, dateAdded: number, over: Partial<BookmarkNode> = {}): BookmarkNode {
  return {
    id,
    parentId: 'other',
    index: 0,
    type: 'url',
    title: `Bookmark ${id}`,
    url: `https://${id}.example/`,
    dateAdded,
    ...over
  }
}

const ROOTS: BookmarkNode[] = [
  { id: 'root', parentId: null, index: 0, type: 'folder', title: '', dateAdded: 0 },
  {
    id: 'other',
    parentId: 'root',
    index: 0,
    type: 'folder',
    title: 'Other bookmarks',
    dateAdded: 0
  }
]

const NOT_DEFAULT: DefaultBrowserStatus = { isDefault: false, prompt: null }

/** A profile with nothing for the Safety check to say. */
const SAFE: SafetyHubInputs = {
  revokedOrigins: [],
  safeBrowsingEnabled: true,
  compromisedPasswords: 0
}

function sources(over: Partial<MagicStackSources> = {}): MagicStackSources {
  return {
    recentlyClosed: [],
    downloads: [],
    bookmarks: [],
    defaultBrowser: { isDefault: true, prompt: null },
    canRequestDefault: true,
    safetyHub: { type: null, inputs: SAFE },
    ...over
  }
}

describe('planMagicStack', () => {
  it('draws nothing from an empty profile: the stack collapses', () => {
    expect(planMagicStack(sources(), [])).toEqual([])
  })

  it('keeps the stack order: continue, downloads, bookmarks, the Safety check, then the promo', () => {
    const cards = planMagicStack(
      sources({
        recentlyClosed: [closed()],
        downloads: [download()],
        bookmarks: [...ROOTS, bookmark('a', 5)],
        defaultBrowser: NOT_DEFAULT,
        safetyHub: { type: 'safe-browsing', inputs: { ...SAFE, safeBrowsingEnabled: false } }
      }),
      []
    )
    expect(cards.map((c) => c.id)).toEqual([
      'continue',
      'downloads',
      'bookmarks',
      'safety-hub',
      'default-browser'
    ])
  })

  it('leaves out hidden modules and the ones with nothing to show', () => {
    const all = sources({
      recentlyClosed: [closed()],
      downloads: [download()],
      bookmarks: [...ROOTS, bookmark('a', 5)],
      defaultBrowser: NOT_DEFAULT
    })
    expect(planMagicStack(all, ['downloads']).map((c) => c.id)).toEqual([
      'continue',
      'bookmarks',
      'default-browser'
    ])
    expect(planMagicStack({ ...all, downloads: [] }, ['continue']).map((c) => c.id)).toEqual([
      'bookmarks',
      'default-browser'
    ])
    expect(planMagicStack(all, ['continue', 'downloads', 'bookmarks', 'default-browser'])).toEqual(
      []
    )
  })
})

describe('buildCard', () => {
  it('continue takes the newest closed entry, a window included', () => {
    const win = closed({
      id: 'w',
      kind: 'window',
      title: '',
      url: null,
      tabCount: 3,
      closedAt: 2_000
    })
    expect(buildCard('continue', sources({ recentlyClosed: [win, closed()] }))).toEqual({
      id: 'continue',
      entry: win
    })
    expect(buildCard('continue', sources())).toBeNull()
  })

  it('downloads takes the newest completed file that is still there and not in quarantine', () => {
    const inProgress = download({ id: 'p', state: 'progressing', completedAt: undefined })
    const gone = download({ id: 'g', fileMissing: true })
    const flagged = download({
      id: 'f',
      danger: {
        level: 'dangerous',
        reason: 'executable',
        message: 'This file type can harm your device.'
      }
    })
    const kept = download({ ...flagged, id: 'k', dangerAccepted: true })
    const plain = download({ id: 'ok' })
    expect(
      buildCard('downloads', sources({ downloads: [inProgress, gone, flagged, kept, plain] }))
    ).toEqual({
      id: 'downloads',
      item: kept
    })
    expect(buildCard('downloads', sources({ downloads: [inProgress, gone, flagged] }))).toBeNull()
    expect(
      buildCard('downloads', sources({ downloads: [download({ state: 'cancelled' })] }))
    ).toBeNull()
  })

  it('bookmarks lists the newest few, never folders, and nothing on roots alone', () => {
    const nodes = [
      ...ROOTS,
      bookmark('old', 1),
      bookmark('mid', 2),
      bookmark('new', 3),
      bookmark('newest', 4),
      { ...bookmark('folder', 9), type: 'folder' as const, url: undefined }
    ]
    const card = buildCard('bookmarks', sources({ bookmarks: nodes }))
    expect(card?.id).toBe('bookmarks')
    expect(card && card.id === 'bookmarks' ? card.items.map((b) => b.id) : []).toEqual([
      'newest',
      'new',
      'mid'
    ])
    expect(BOOKMARKS_CARD_LIMIT).toBe(3)
    expect(buildCard('bookmarks', sources({ bookmarks: ROOTS }))).toBeNull()
    expect(buildCard('bookmarks', sources())).toBeNull()
  })

  it('the default-browser reminder shows while Zenium is known not to be the default and nothing else asks', () => {
    expect(buildCard('default-browser', sources({ defaultBrowser: NOT_DEFAULT }))).toEqual({
      id: 'default-browser'
    })
    // Already the default, or the host cannot tell yet.
    expect(buildCard('default-browser', sources())).toBeNull()
    expect(
      buildCard('default-browser', sources({ defaultBrowser: { isDefault: null, prompt: null } }))
    ).toBeNull()
    // The first-run banner or sheet is up: one ask at a time.
    expect(
      buildCard(
        'default-browser',
        sources({ defaultBrowser: { isDefault: false, prompt: 'banner' } })
      )
    ).toBeNull()
    // A host that cannot ask (the desktop) has no module.
    expect(
      buildCard(
        'default-browser',
        sources({ defaultBrowser: NOT_DEFAULT, canRequestDefault: false })
      )
    ).toBeNull()
  })

  it('the Safety check card shows the type the machine picked for as long as its trigger holds', () => {
    const revoked = { ...SAFE, revokedOrigins: ['https://a.example', 'https://b.example'] }
    expect(
      buildCard(
        'safety-hub',
        sources({ safetyHub: { type: 'revoked-permissions', inputs: revoked } })
      )
    ).toEqual({ id: 'safety-hub', type: 'revoked-permissions', inputs: revoked })
    const off = { ...SAFE, safeBrowsingEnabled: false }
    expect(
      buildCard('safety-hub', sources({ safetyHub: { type: 'safe-browsing', inputs: off } }))
    ).toEqual({
      id: 'safety-hub',
      type: 'safe-browsing',
      inputs: off
    })
    const leaked = { ...SAFE, compromisedPasswords: 2 }
    expect(
      buildCard('safety-hub', sources({ safetyHub: { type: 'passwords', inputs: leaked } }))
    ).toEqual({
      id: 'safety-hub',
      type: 'passwords',
      inputs: leaked
    })
    // No pick: nothing, whatever the inputs say (the machine decides when the card is due).
    expect(
      buildCard('safety-hub', sources({ safetyHub: { type: null, inputs: leaked } }))
    ).toBeNull()
    // The trigger cleared under the picked type: the card leaves (Chrome's observers).
    expect(
      buildCard('safety-hub', sources({ safetyHub: { type: 'safe-browsing', inputs: SAFE } }))
    ).toBeNull()
    expect(
      buildCard('safety-hub', sources({ safetyHub: { type: 'passwords', inputs: SAFE } }))
    ).toBeNull()
    expect(
      buildCard('safety-hub', sources({ safetyHub: { type: 'revoked-permissions', inputs: SAFE } }))
    ).toBeNull()
  })
})

describe('the modules', () => {
  it('names every module once, in sentence case, for the Customise sheet', () => {
    expect(MAGIC_STACK_MODULES.map((m) => m.id)).toEqual([
      'continue',
      'downloads',
      'bookmarks',
      'safety-hub',
      'default-browser'
    ])
    for (const m of MAGIC_STACK_MODULES) {
      expect(m.title).toMatch(/^[A-Z][^A-Z]*$/)
      expect(m.description.length).toBeGreaterThan(0)
      expect(magicStackModule(m.id)).toBe(m)
    }
  })

  it('lists the default-browser module only where the host can ask', () => {
    expect(availableModules({ canRequestDefault: true }).map((m) => m.id)).toEqual([
      'continue',
      'downloads',
      'bookmarks',
      'safety-hub',
      'default-browser'
    ])
    expect(availableModules({ canRequestDefault: false }).map((m) => m.id)).toEqual([
      'continue',
      'downloads',
      'bookmarks',
      'safety-hub'
    ])
  })
})

describe('pageAt', () => {
  it('rounds the scroll offset to the nearest card and clamps to the cards there are', () => {
    expect(pageAt(0, 300, 3)).toBe(0)
    expect(pageAt(140, 300, 3)).toBe(0)
    expect(pageAt(160, 300, 3)).toBe(1)
    expect(pageAt(900, 300, 3)).toBe(2)
    expect(pageAt(-20, 300, 3)).toBe(0)
    expect(pageAt(100, 0, 3)).toBe(0)
    expect(pageAt(100, 300, 0)).toBe(0)
  })
})
