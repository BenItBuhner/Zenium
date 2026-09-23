// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FindResult, UIState } from '@shared/types'

/*
 * The find bar's count as its own status region (parity matrix a11y-35; Chrome's find bar): the
 * words a reader hears ("3 of 12 matches", "No matches") are the region's accessible text, the
 * figures the eye reads are hidden from it, and the region's text changes once per count – a
 * result that reads the same as the last leaves the node untouched – with nothing going through
 * the chrome's general announcer besides. Escape closes the bar with the match's selection kept
 * (the page's focus lands on the match; lib/ui.ts's `closeFindBar('afterKey')`), Enter and
 * Shift+Enter step as before.
 */

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { announcerStore, resetAnnouncer } = await import('@renderer/lib/announce')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { openFindBar, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { FindBar } = await import('../FindBar')
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function stateWith(findResult: FindResult | null): UIState {
  return {
    platform: 'linux',
    tabs: { t1: { id: 't1', url: 'https://example.com/', title: 'Example' } },
    findResult,
    shortcuts: defaultShortcuts('linux', 'chrome'),
    settings: {}
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
  return mount!
}

/** The bar for `findResult` with the store's find state as it stands. */
function bar(findResult: FindResult | null): HTMLElement {
  const state = stateWith(findResult)
  return render(<FindBar state={state} tabId="t1" ui={uiStore.get()} docked="content" />)
}

const q = <T extends Element = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`missing ${selector}`)
  return el
}
const region = (): HTMLElement => q('[data-testid="find-count"]')
/** What a reader hears of the region: its text less what is hidden from it. */
const heard = (): string =>
  [...region().childNodes]
    .filter((n) => !(n instanceof HTMLElement && n.getAttribute('aria-hidden') === 'true'))
    .map((n) => n.textContent)
    .join('')
const seen = (): string => region().querySelector('[aria-hidden="true"]')?.textContent ?? ''

beforeEach(() => {
  resetAnnouncer()
  act(() => openFindBar('t1', 'lorem'))
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ findOpen: false, findTabId: null, findText: '', findRequest: null })
  vi.mocked(run).mockClear()
})

describe('the find bar’s count region (a11y-35)', () => {
  it('is a polite, atomic status region whose text is the count in words, the figures hidden from it', () => {
    bar({ tabId: 't1', activeMatchOrdinal: 3, matches: 12 })
    const el = region()
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.getAttribute('aria-atomic')).toBe('true')
    expect(seen()).toBe('3/12')
    expect(heard()).toBe('3 of 12 matches')
    expect(q('[role="search"][aria-label="Find in page"]').contains(el)).toBe(true)
    // The region is the bar's own: the chrome's general announcer said nothing.
    expect(announcerStore.get().text).toBe('')
  })

  it('reads "No matches" for a miss, marked for the eye too, and nothing before the page answers', () => {
    bar(null)
    expect(seen()).toBe('0/0')
    expect(heard()).toBe('')
    bar({ tabId: 't1', activeMatchOrdinal: 0, matches: 0 })
    expect(heard()).toBe('No matches')
    expect(region().dataset.noMatch).toBe('true')
    bar({ tabId: 't1', activeMatchOrdinal: 1, matches: 1 })
    expect(heard()).toBe('1 of 1 match')
    expect(region().dataset.noMatch).toBeUndefined()
  })

  it('changes its text once per count: a result that reads as the last leaves the node as it was', async () => {
    bar({ tabId: 't1', activeMatchOrdinal: 0, matches: 0 })
    const first = region().querySelector('.sr-only')!
    expect(first.textContent).toBe('No matches')
    const changes: string[] = []
    const observer = new MutationObserver((records) => {
      for (const r of records) changes.push(`${r.type}:${r.target.textContent}`)
    })
    observer.observe(region(), { childList: true, subtree: true, characterData: true })
    // Another keystroke, another miss (a fresh result object with the same reading).
    bar({ tabId: 't1', activeMatchOrdinal: 0, matches: 0 })
    // A hit: the words change once.
    bar({ tabId: 't1', activeMatchOrdinal: 1, matches: 4 })
    // The same hit again (the page echoed it): no change.
    bar({ tabId: 't1', activeMatchOrdinal: 1, matches: 4 })
    // happy-dom delivers records in a microtask.
    await act(async () => {
      await Promise.resolve()
    })
    observer.disconnect()
    expect(region().querySelector('.sr-only')).toBe(first)
    expect(changes.filter((c) => c.includes('match'))).toEqual(['characterData:1 of 4 matches'])
    expect(changes.filter((c) => c.includes('No matches'))).toEqual([])
  })

  it('is the phone’s too, inside its field', () => {
    const before = viewportStore.get()
    viewportStore.set({ ...before, formFactor: 'phone' })
    try {
      bar({ tabId: 't1', activeMatchOrdinal: 2, matches: 5 })
      expect(region().getAttribute('role')).toBe('status')
      expect(heard()).toBe('2 of 5 matches')
      expect(seen()).toBe('2/5')
    } finally {
      viewportStore.set(before)
    }
  })
})

describe('the find bar’s keys (a11y-35)', () => {
  it('Escape closes the bar keeping the match selected, the keyboard back to the page after the key', () => {
    bar({ tabId: 't1', activeMatchOrdinal: 3, matches: 12 })
    const input = q<HTMLInputElement>('[data-testid="find-input"]')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(vi.mocked(run)).toHaveBeenCalledWith('find.stop', { tabId: 't1', keepSelection: true })
    expect(uiStore.get().findOpen).toBe(false)
  })

  it('Enter steps forward and Shift+Enter back in the running session', () => {
    bar({ tabId: 't1', activeMatchOrdinal: 3, matches: 12 })
    const input = q<HTMLInputElement>('[data-testid="find-input"]')
    vi.mocked(run).mockClear()
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'find.start',
      { tabId: 't1', text: 'lorem', forward: true, newSession: false }
    ])
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
      )
    })
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'find.start',
      { tabId: 't1', text: 'lorem', forward: false, newSession: false }
    ])
  })
})
