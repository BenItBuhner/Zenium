import { describe, expect, it } from 'vitest'
import type { BookmarkNode, ClosedEntrySummary, DownloadItem } from '@shared/types'
import type { EducationalTipInputs } from '@shared/educationalTips'
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

/** A profile with nothing for the Safety check to say. */
const SAFE: SafetyHubInputs = {
  revokedOrigins: [],
  safeBrowsingEnabled: true,
  compromisedPasswords: 0
}

/** A phone every tip card has a word for: the default page, not the default browser, no group over many tabs. */
const TIPPABLE: EducationalTipInputs = {
  customizedBackground: false,
  canRequestDefault: true,
  isDefault: false,
  defaultBrowserPromptUp: false,
  groups: 0,
  tabs: 12
}

function sources(over: Partial<MagicStackSources> = {}): MagicStackSources {
  return {
    recentlyClosed: [],
    downloads: [],
    bookmarks: [],
    safetyHub: { type: null, inputs: SAFE },
    tips: { card: null, inputs: TIPPABLE },
    ...over
  }
}

describe('planMagicStack', () => {
  it('draws nothing from an empty profile: the stack collapses', () => {
    expect(planMagicStack(sources(), [])).toEqual([])
  })

  it('keeps the stack order: continue, downloads, bookmarks, the Safety check, then the tip', () => {
    const cards = planMagicStack(
      sources({
        recentlyClosed: [closed()],
        downloads: [download()],
        bookmarks: [...ROOTS, bookmark('a', 5)],
        safetyHub: { type: 'safe-browsing', inputs: { ...SAFE, safeBrowsingEnabled: false } },
        tips: { card: 'default-browser', inputs: TIPPABLE }
      }),
      []
    )
    expect(cards.map((c) => c.id)).toEqual([
      'continue',
      'downloads',
      'bookmarks',
      'safety-hub',
      'tips'
    ])
  })

  it('leaves out hidden modules and the ones with nothing to show', () => {
    const all = sources({
      recentlyClosed: [closed()],
      downloads: [download()],
      bookmarks: [...ROOTS, bookmark('a', 5)],
      tips: { card: 'ntp-theme', inputs: TIPPABLE }
    })
    expect(planMagicStack(all, ['downloads']).map((c) => c.id)).toEqual([
      'continue',
      'bookmarks',
      'tips'
    ])
    expect(planMagicStack({ ...all, downloads: [] }, ['continue']).map((c) => c.id)).toEqual([
      'bookmarks',
      'tips'
    ])
    expect(planMagicStack(all, ['continue', 'downloads', 'bookmarks', 'tips'])).toEqual([])
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

  it('the tip card shows the card the machine picked for as long as its live signals hold', () => {
    const tips = (
      card: MagicStackSources['tips']['card'],
      over: Partial<EducationalTipInputs> = {}
    ): MagicStackSources => sources({ tips: { card, inputs: { ...TIPPABLE, ...over } } })
    for (const card of ['ntp-theme', 'default-browser', 'tab-groups', 'quick-delete'] as const)
      expect(buildCard('tips', tips(card))).toEqual({ id: 'tips', card })
    // No pick: nothing, whatever the signals say (the machine decides when a tip is due).
    expect(buildCard('tips', tips(null))).toBeNull()
    // A signal cleared under the picked card: the card leaves (Chrome's signal handler).
    expect(buildCard('tips', tips('ntp-theme', { customizedBackground: true }))).toBeNull()
    // Already the default, or the host cannot tell yet, or the first-run banner or sheet is up
    // (one ask at a time), or the host cannot ask at all (the desktop).
    expect(buildCard('tips', tips('default-browser', { isDefault: true }))).toBeNull()
    expect(buildCard('tips', tips('default-browser', { isDefault: null }))).toBeNull()
    expect(buildCard('tips', tips('default-browser', { defaultBrowserPromptUp: true }))).toBeNull()
    expect(buildCard('tips', tips('default-browser', { canRequestDefault: false }))).toBeNull()
    // A group made, or the tabs down to ten.
    expect(buildCard('tips', tips('tab-groups', { groups: 1 }))).toBeNull()
    expect(buildCard('tips', tips('tab-groups', { tabs: 10 }))).toBeNull()
    // The Quick Delete card has no live signal: it holds while picked.
    expect(
      buildCard(
        'tips',
        tips('quick-delete', { customizedBackground: true, isDefault: true, groups: 3, tabs: 1 })
      )
    ).toEqual({ id: 'tips', card: 'quick-delete' })
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
      'tips'
    ])
    for (const m of MAGIC_STACK_MODULES) {
      // Sentence case (§9.1): one capital, the product's name aside.
      expect(m.title).toMatch(/^[A-Z]/)
      expect(m.title.slice(1).replace(/Zenium/g, 'zenium')).not.toMatch(/[A-Z]/)
      expect(m.description.length).toBeGreaterThan(0)
      expect(magicStackModule(m.id)).toBe(m)
    }
  })

  it('lists every module on every host – the tip card has cards that need nothing of the host – as a copy', () => {
    const listed = availableModules()
    expect(listed.map((m) => m.id)).toEqual([
      'continue',
      'downloads',
      'bookmarks',
      'safety-hub',
      'tips'
    ])
    expect(listed).toEqual(MAGIC_STACK_MODULES)
    expect(listed).not.toBe(MAGIC_STACK_MODULES)
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
