import { describe, expect, it } from 'vitest'
import {
  CONTEXT_TYPES,
  contextTypeOf,
  documentOriginOf,
  matchesContextFilter,
  normalizeContextFilter,
  type ExtensionContext
} from '../api/runtimeContexts'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    contextId: 'ctx-1',
    contextType: 'TAB',
    documentId: 'DOC1',
    documentOrigin: `chrome-extension://${ID}`,
    documentUrl: `chrome-extension://${ID}/options.html`,
    frameId: 0,
    incognito: false,
    tabId: 12,
    windowId: 3,
    ...overrides
  }
}

describe('normalizeContextFilter', () => {
  it('accepts an empty, absent or null filter', () => {
    expect(normalizeContextFilter(undefined)).toEqual({})
    expect(normalizeContextFilter(null)).toEqual({})
    expect(normalizeContextFilter({})).toEqual({})
  })

  it('copies every list and the incognito flag, ignoring unknown properties', () => {
    expect(
      normalizeContextFilter({
        contextIds: ['a'],
        contextTypes: ['TAB', 'BACKGROUND'],
        documentIds: ['d'],
        documentOrigins: ['chrome-extension://x'],
        documentUrls: ['chrome-extension://x/a.html'],
        frameIds: [0, 5],
        tabIds: [1],
        windowIds: [2],
        incognito: false,
        somethingElse: 1
      })
    ).toEqual({
      contextIds: ['a'],
      contextTypes: ['TAB', 'BACKGROUND'],
      documentIds: ['d'],
      documentOrigins: ['chrome-extension://x'],
      documentUrls: ['chrome-extension://x/a.html'],
      frameIds: [0, 5],
      tabIds: [1],
      windowIds: [2],
      incognito: false
    })
  })

  it('rejects the shapes the binding rejects', () => {
    expect(() => normalizeContextFilter('x')).toThrow(/No matching signature/)
    expect(() => normalizeContextFilter([])).toThrow(/No matching signature/)
    expect(() => normalizeContextFilter({ tabIds: 1 })).toThrow(/'tabIds'.*expected array/)
    expect(() => normalizeContextFilter({ tabIds: [1.5] })).toThrow(/expected integer/)
    expect(() => normalizeContextFilter({ contextIds: [1] })).toThrow(/expected string/)
    expect(() => normalizeContextFilter({ contextTypes: ['WORKER'] })).toThrow(
      /Value must be one of TAB, POPUP, BACKGROUND/
    )
    expect(() => normalizeContextFilter({ incognito: 'no' })).toThrow(/expected boolean/)
  })

  it('does not accept prototype members as context types', () => {
    expect(() => normalizeContextFilter({ contextTypes: ['toString'] })).toThrow(
      /Value must be one of/
    )
  })
})

describe('matchesContextFilter', () => {
  it('matches everything with an empty filter', () => {
    expect(matchesContextFilter(context(), {})).toBe(true)
    expect(matchesContextFilter(context({ contextType: 'BACKGROUND' }), {})).toBe(true)
  })

  it('narrows by every list', () => {
    const ctx = context()
    expect(matchesContextFilter(ctx, { contextIds: ['ctx-1'] })).toBe(true)
    expect(matchesContextFilter(ctx, { contextIds: ['other'] })).toBe(false)
    expect(matchesContextFilter(ctx, { contextTypes: ['TAB', 'POPUP'] })).toBe(true)
    expect(matchesContextFilter(ctx, { contextTypes: ['BACKGROUND'] })).toBe(false)
    expect(matchesContextFilter(ctx, { documentIds: ['DOC1'] })).toBe(true)
    expect(matchesContextFilter(ctx, { documentIds: ['DOC2'] })).toBe(false)
    expect(matchesContextFilter(ctx, { documentOrigins: [`chrome-extension://${ID}`] })).toBe(true)
    expect(matchesContextFilter(ctx, { documentUrls: [ctx.documentUrl ?? ''] })).toBe(true)
    expect(matchesContextFilter(ctx, { documentUrls: ['chrome-extension://x/y'] })).toBe(false)
    expect(matchesContextFilter(ctx, { frameIds: [0] })).toBe(true)
    expect(matchesContextFilter(ctx, { frameIds: [7] })).toBe(false)
    expect(matchesContextFilter(ctx, { tabIds: [12] })).toBe(true)
    expect(matchesContextFilter(ctx, { tabIds: [13] })).toBe(false)
    expect(matchesContextFilter(ctx, { windowIds: [3] })).toBe(true)
    expect(matchesContextFilter(ctx, { windowIds: [4] })).toBe(false)
    expect(matchesContextFilter(ctx, { incognito: false })).toBe(true)
    expect(matchesContextFilter(ctx, { incognito: true })).toBe(false)
  })

  it('combines lists with and, and an empty list matches nothing', () => {
    const ctx = context()
    expect(matchesContextFilter(ctx, { tabIds: [12], contextTypes: ['TAB'] })).toBe(true)
    expect(matchesContextFilter(ctx, { tabIds: [12], contextTypes: ['POPUP'] })).toBe(false)
    expect(matchesContextFilter(ctx, { tabIds: [] })).toBe(false)
  })

  it('never matches a worker on document lists', () => {
    const worker = context({
      contextType: 'BACKGROUND',
      documentId: undefined,
      documentOrigin: undefined,
      documentUrl: undefined,
      frameId: -1,
      tabId: -1,
      windowId: -1
    })
    expect(matchesContextFilter(worker, { contextTypes: ['BACKGROUND'] })).toBe(true)
    expect(matchesContextFilter(worker, { documentIds: ['x'] })).toBe(false)
    expect(matchesContextFilter(worker, { documentOrigins: ['chrome-extension://x'] })).toBe(false)
    expect(matchesContextFilter(worker, { documentUrls: ['chrome-extension://x/a'] })).toBe(false)
    expect(matchesContextFilter(worker, { tabIds: [-1] })).toBe(true)
  })
})

describe('contextTypeOf', () => {
  const manifest = { devtools_page: 'devtools.html', side_panel: { default_path: '/panel.html' } }

  it('maps the registry kinds onto Chrome context types', () => {
    expect(contextTypeOf('background', `chrome-extension://${ID}/bg.html`, {})).toBe('BACKGROUND')
    expect(contextTypeOf('popup', `chrome-extension://${ID}/popup.html`, {})).toBe('POPUP')
    expect(contextTypeOf('tab', `chrome-extension://${ID}/options.html`, {})).toBe('TAB')
    expect(contextTypeOf('options', `chrome-extension://${ID}/options.html`, {})).toBe('TAB')
    expect(contextTypeOf('other', `chrome-extension://${ID}/x.html`, {})).toBe('TAB')
  })

  it('recognises the devtools page and the side panel from the manifest', () => {
    expect(contextTypeOf('other', `chrome-extension://${ID}/devtools.html`, manifest)).toBe(
      'DEVELOPER_TOOLS'
    )
    expect(contextTypeOf('tab', `chrome-extension://${ID}/panel.html?tab=1`, manifest)).toBe(
      'SIDE_PANEL'
    )
    expect(contextTypeOf('tab', `chrome-extension://${ID}/other.html`, manifest)).toBe('TAB')
    expect(contextTypeOf('background', `chrome-extension://${ID}/devtools.html`, manifest)).toBe(
      'BACKGROUND'
    )
  })

  it('exports the enum the spec table publishes', () => {
    expect(Object.keys(CONTEXT_TYPES)).toEqual([
      'TAB',
      'POPUP',
      'BACKGROUND',
      'OFFSCREEN_DOCUMENT',
      'SIDE_PANEL',
      'DEVELOPER_TOOLS'
    ])
  })
})

describe('documentOriginOf', () => {
  it('is the extension origin without a trailing slash', () => {
    expect(documentOriginOf(`chrome-extension://${ID}/a/b.html?x#y`)).toBe(
      `chrome-extension://${ID}`
    )
  })

  it('is undefined for opaque or unparsable URLs', () => {
    expect(documentOriginOf('about:blank')).toBeUndefined()
    expect(documentOriginOf('')).toBeUndefined()
    expect(documentOriginOf('not a url')).toBeUndefined()
  })
})
