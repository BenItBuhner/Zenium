import { describe, expect, it, vi } from 'vitest'
import { READ_ALOUD_HIGHLIGHT_CSS } from '../../../shared/readAloud'
import type { Tab } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import { cssOriginFor, hasHighlightRule } from '../extensionApi/cssOrigin'
import { TabsApi } from '../extensionApi/tabs'
import type { ApiContext, ApiHost } from '../extensionApi/types'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const HIGHLIGHT_CSS = '::highlight(zen-mark) { background-color: rgba(255, 0, 0, 0.6) }'
const PLAIN_CSS = '#p1 { background-color: rgba(0, 0, 255, 0.6) }'

/** A tab with a page: what `tabs.insertCSS` / `tabs.removeCSS` hand the web contents. */
function world(): {
  tabs: TabsApi
  ctx: ApiContext
  inserted: Array<{ css: string; options: { cssOrigin: string } }>
  removed: string[]
} {
  const inserted: Array<{ css: string; options: { cssOrigin: string } }> = []
  const removed: string[] = []
  const win = { id: 'w1' } as unknown as ZenWindow
  const tab = { id: 't1', url: 'https://example.com/', pinned: false, essential: false } as Tab
  const wc = {
    id: 42,
    insertCSS: async (css: string, options: { cssOrigin: string }) => {
      inserted.push({ css, options })
      return `key-${inserted.length}`
    },
    removeInsertedCSS: async (key: string) => {
      removed.push(key)
    }
  }
  const model = {
    zenTab: (id: number) => (id === 7 ? tab : undefined),
    webContentsOf: (t: Tab) => (t === tab ? wc : undefined),
    lastFocusedWindow: () => win
  }
  const host = {
    browser: { tabs: { activeTabFor: () => tab } },
    model,
    canSeeTab: () => true
  } as unknown as ApiHost
  const ctx = {
    extensionId: EXT,
    extension: { id: EXT, path: '/ext/' + EXT, manifest: { name: 'Probe' }, sessions: [{}] },
    sender: { kind: 'worker' },
    window: win
  } as unknown as ApiContext
  return { tabs: new TabsApi(host), ctx, inserted, removed }
}

describe('cssOriginFor', () => {
  it('promotes a user sheet that styles a registered highlight to author, the origin it paints from', () => {
    expect(cssOriginFor(HIGHLIGHT_CSS, 'user')).toBe('author')
    expect(cssOriginFor(`${PLAIN_CSS}\n${HIGHLIGHT_CSS}`, 'user')).toBe('author')
    expect(cssOriginFor('p::HIGHLIGHT(Mark) { color: red }', 'user')).toBe('author')
    expect(cssOriginFor('::highlight(a), ::highlight(b) { color: red }', 'user')).toBe('author')
  })

  it('keeps a user sheet without highlight rules where it was asked to go', () => {
    expect(cssOriginFor(PLAIN_CSS, 'user')).toBe('user')
    expect(cssOriginFor('', 'user')).toBe('user')
    // Chrome's `::selection` and a class named after the pseudo-element are not `::highlight()`.
    expect(cssOriginFor('::selection { color: red } .highlight { color: red }', 'user')).toBe(
      'user'
    )
    expect(cssOriginFor(':highlight(x) { color: red }', 'user')).toBe('user')
  })

  it('ignores highlight rules that are commented out, however the comment ends', () => {
    expect(cssOriginFor(`/* ${HIGHLIGHT_CSS} */ ${PLAIN_CSS}`, 'user')).toBe('user')
    expect(cssOriginFor(`${PLAIN_CSS} /* ${HIGHLIGHT_CSS}`, 'user')).toBe('user')
    expect(cssOriginFor(`/* note */ ${HIGHLIGHT_CSS} /* other */`, 'user')).toBe('author')
    expect(hasHighlightRule('/* a */ ::highlight(x) {} /* b')).toBe(true)
  })

  it('never demotes an author request', () => {
    expect(cssOriginFor(PLAIN_CSS, 'author')).toBe('author')
    expect(cssOriginFor(HIGHLIGHT_CSS, 'author')).toBe('author')
  })

  it('reads read aloud’s own sheet as one that must go in as author – the origin the reader asks for', () => {
    expect(hasHighlightRule(READ_ALOUD_HIGHLIGHT_CSS)).toBe(true)
    expect(cssOriginFor(READ_ALOUD_HIGHLIGHT_CSS, 'user')).toBe('author')
  })
})

describe("tabs.insertCSS's cascade origin", () => {
  it('passes a user request through for an ordinary sheet and promotes one with ::highlight() rules', async () => {
    const w = world()
    await w.tabs.handlers.insertCSS(w.ctx, 7, { code: PLAIN_CSS, cssOrigin: 'user' })
    await w.tabs.handlers.insertCSS(w.ctx, 7, { code: HIGHLIGHT_CSS, cssOrigin: 'user' })
    expect(w.inserted.map((i) => i.options.cssOrigin)).toEqual(['user', 'author'])
    expect(w.inserted[1]!.css).toBe(HIGHLIGHT_CSS)
  })

  it('inserts as author by default, as Chrome does, and removeCSS still finds the sheet by its text', async () => {
    const w = world()
    await w.tabs.handlers.insertCSS(w.ctx, undefined, { code: HIGHLIGHT_CSS })
    expect(w.inserted.map((i) => i.options.cssOrigin)).toEqual(['author'])
    await w.tabs.handlers.removeCSS(w.ctx, undefined, { code: HIGHLIGHT_CSS })
    expect(w.removed).toEqual(['key-1'])
  })
})
