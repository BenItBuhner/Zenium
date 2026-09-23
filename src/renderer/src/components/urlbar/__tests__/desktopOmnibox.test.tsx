// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Suggestion, Tab, UIState } from '@shared/types'
import type { UrlbarState } from '@renderer/lib/ui'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'

/*
 * The desktop omnibox's keyboard model and mouse targets against Chrome (omnibox-50, -22, -24,
 * -25, -26, -08, -20): rendered for real over a recording host stub. The pure decisions are in
 * `omniboxKeys.test.ts`; here is what the bar does with them – which rows it removes, what it
 * submits where, which chip it shows.
 */

let suggestions: (query: string, engineId?: string) => Suggestion[] = () => []
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) => {
  if (name === 'urlbar.suggest') {
    const a = args as { query: string; engineId?: string }
    return suggestions(a.query, a.engineId)
  }
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Urlbar } = await import('../Urlbar')
const { uiStore } = await import('@renderer/lib/ui')
const { pageTookKeyboard } = await import('@renderer/lib/panes')

const PAGE = 'https://example.com/some/path'

function tab(url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Example Domain',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...patch
  } as Tab
}

function state(t: Tab): UIState {
  return {
    platform: 'linux',
    capabilities: {},
    tabs: { [t.id]: t },
    spaces: [],
    activeSpaceId: 'space',
    settings: { ...DEFAULT_SETTINGS, searchEngineId: 'google' },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

function urlbarState(mode: UrlbarState['mode'] = 'edit'): UrlbarState {
  return { open: true, mode, tabId: 't1', initialText: undefined, attached: true }
}

const desktop = (t: Tab = tab(PAGE), mode: UrlbarState['mode'] = 'edit'): ReactElement =>
  createElement(Urlbar, {
    state: state(t),
    urlbar: urlbarState(mode),
    area: { x: 0, y: 0, width: 1200, height: 800 },
    phoneEdge: undefined
  })

const row = (
  kind: Suggestion['kind'],
  title: string,
  fill: string,
  url: string | null,
  extra: Partial<Suggestion> = {}
): Suggestion => ({
  id: `${kind}:${title}`,
  kind,
  title,
  subtitle: url ? 'example.com' : '',
  url,
  favicon: null,
  targetId: null,
  fill,
  ...extra
})

const history = (n: number): Suggestion =>
  row('history', `Page ${n}`, `example.com/${n}`, `https://example.com/${n}`, { deletable: true })
const bookmark = (n: number): Suggestion =>
  row('bookmark', `Mark ${n}`, `marks.example/${n}`, `https://marks.example/${n}`)

let root: Root | null = null
let host: HTMLElement | null = null

async function render(el: ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(el)
  })
  await act(async () => {
    await vi.waitFor(() => expect(commands()).toContain('urlbar.suggest'))
  })
  return host
}

const commands = (): string[] => invoke.mock.calls.map(([name]) => name)
const callsTo = <T,>(name: string): T[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args as T)
const submits = (): Array<{
  input: string
  newTab: boolean
  background?: boolean
  newWindow?: boolean
  learn?: { typed: string; title: string; kind?: string }
}> => callsTo('urlbar.submit')
const input = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]')!
const rows = (el: HTMLElement): HTMLElement[] =>
  Array.from(el.querySelectorAll<HTMLElement>('ul[role="listbox"] > li.zen-omnibox-row'))
const selectedRow = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>('li.zen-omnibox-row[data-selected="true"]')
const chip = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>('[data-keyword-chip]')
const glyph = (el: HTMLElement): string => el.querySelector('.zen-omnibox-engine')!.textContent!
const removeX = (r: HTMLElement): HTMLButtonElement | null =>
  r.querySelector<HTMLButtonElement>('[data-testid="urlbar-remove-suggestion"]')

async function key(
  target: HTMLElement,
  k: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false
      })
    )
    await Promise.resolve()
  })
}

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
/**
 * Typing: the field's value is set through the prototype's setter (past React's value tracker)
 * and the input event fired; then the suggestions the bar asks for `fetches` (the value itself,
 * or what keyword mode leaves in the field) have landed.
 */
async function type(el: HTMLInputElement, value: string, fetches: string = value): Promise<void> {
  await act(async () => {
    nativeValue.call(el, value)
    el.setSelectionRange(value.length, value.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  await act(async () => {
    await vi.waitFor(() =>
      expect(callsTo<{ query: string }>('urlbar.suggest').at(-1)?.query).toBe(fetches)
    )
  })
}

/** Tab or Shift+Tab from wherever the keyboard is (the field or a row's X). */
const tabFromActive = (shift = false): Promise<void> =>
  key(document.activeElement as HTMLElement, 'Tab', { shift })

async function typeAndList(el: HTMLElement, value: string, count: number): Promise<void> {
  await type(input(el), value)
  await act(async () => {
    await vi.waitFor(() => expect(rows(el)).toHaveLength(count))
  })
}

/** A mouse press on a row: the desktop picks on the press. */
async function press(
  el: HTMLElement,
  mods: { button?: number; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'mouse',
        button: mods.button ?? 0,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false
      })
    )
    await Promise.resolve()
  })
}

beforeEach(() => {
  invoke.mockClear()
  suggestions = () => []
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('Escape, staged (omnibox-50)', () => {
  it('closes the popup keeping the text, then reverts to the page, then closes the bar', async () => {
    suggestions = (q) => (q ? [history(1), history(2)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 2)

    await key(input(el), 'Escape')
    expect(rows(el)).toHaveLength(0)
    expect(input(el).value).toBe('pa')
    expect(uiStore.get().urlbar.open).toBe(true)

    await key(input(el), 'Escape')
    expect(input(el).value).toBe(PAGE)
    expect([input(el).selectionStart, input(el).selectionEnd]).toEqual([0, PAGE.length])
    expect(uiStore.get().urlbar.open).toBe(true)

    await key(input(el), 'Escape')
    expect(uiStore.get().urlbar.open).toBe(false)
  })

  it('Down after the first Escape brings the rows back and highlights the first', async () => {
    suggestions = (q) => (q ? [history(1), history(2)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 2)
    await key(input(el), 'Escape')
    expect(rows(el)).toHaveLength(0)
    await key(input(el), 'ArrowDown')
    expect(rows(el)).toHaveLength(2)
    expect(selectedRow(el)?.textContent).toContain('Page 1')
    expect(input(el).value).toBe('example.com/1')
  })
})

describe('PageDown and PageUp (omnibox-50)', () => {
  it('move the highlight a page of rows and stop at the ends', async () => {
    suggestions = (q) => (q ? [1, 2, 3, 4, 5, 6].map(history) : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 6)
    // The test DOM lays nothing out, so a page is the whole list.
    await key(input(el), 'PageDown')
    expect(selectedRow(el)?.textContent).toContain('Page 6')
    await key(input(el), 'PageDown')
    expect(selectedRow(el)?.textContent).toContain('Page 6')
    await key(input(el), 'PageUp')
    expect(selectedRow(el)).toBeNull()
    expect(input(el).value).toBe('pa')
  })

  it('Down and Up still wrap through the rows and the typed text', async () => {
    suggestions = (q) => (q ? [history(1), history(2)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 2)
    await key(input(el), 'ArrowUp')
    expect(selectedRow(el)?.textContent).toContain('Page 2')
    await key(input(el), 'ArrowDown')
    expect(selectedRow(el)).toBeNull()
    expect(input(el).value).toBe('pa')
    await key(input(el), 'ArrowDown')
    expect(selectedRow(el)?.textContent).toContain('Page 1')
  })

  it('the highlighted row is brought into view when the list scrolls (the field keeps the focus, so nothing else would)', async () => {
    const scrolled: Element[] = []
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element
    ) {
      scrolled.push(this)
    })
    try {
      suggestions = (q) => (q ? [1, 2, 3].map(history) : [])
      const el = await render(desktop())
      await typeAndList(el, 'pa', 3)
      expect(scrolled).toEqual([])
      await key(input(el), 'ArrowDown')
      await key(input(el), 'ArrowDown')
      expect(scrolled.map((r) => r.textContent)).toEqual([
        rows(el)[0].textContent,
        rows(el)[1].textContent
      ])
      expect(scrolled.every((r) => r.classList.contains('zen-omnibox-row'))).toBe(true)
      expect(spy).toHaveBeenLastCalledWith({ block: 'nearest' })
    } finally {
      spy.mockRestore()
    }
  })
})

describe('Tab through the rows and their remove X, then out of the bar (omnibox-50, -22)', () => {
  it('cycles into a removable row\u2019s X, skips a bookmark\u2019s (none), then leaves the bar', async () => {
    suggestions = (q) => (q ? [history(1), bookmark(1)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 2)
    const [first, second] = rows(el)
    expect(removeX(first)).not.toBeNull()
    expect(removeX(second)).toBeNull()

    await key(input(el), 'Tab')
    expect(selectedRow(el)).toBe(first)
    expect(document.activeElement).toBe(input(el))

    await key(input(el), 'Tab')
    expect(document.activeElement).toBe(removeX(first))
    expect(first.hasAttribute('data-action-focused')).toBe(true)

    await key(removeX(first)!, 'Tab')
    expect(selectedRow(el)).toBe(second)
    expect(document.activeElement).toBe(input(el))

    // Shift+Tab walks back into the X.
    await key(input(el), 'Tab', { shift: true })
    expect(document.activeElement).toBe(removeX(first))
    await key(removeX(first)!, 'Tab', { shift: true })
    expect(selectedRow(el)).toBe(first)
    expect(document.activeElement).toBe(input(el))

    // On through the X and the bookmark row; past the last row the bar goes away (no toolbar
    // in this DOM to land on).
    await tabFromActive()
    expect(document.activeElement).toBe(removeX(first))
    await tabFromActive()
    expect(selectedRow(el)).toBe(second)
    await tabFromActive()
    expect(uiStore.get().urlbar.open).toBe(false)
  })

  it('Tab still accepts an inline completion first', async () => {
    suggestions = (q) =>
      q ? [row('url', 'example.com', 'example.com', 'https://example.com/', { inline: true })] : []
    const el = await render(desktop())
    // Typed over the selected address: the first key replaces it, the second grows the text.
    await type(input(el), 'e')
    await typeAndList(el, 'ex', 1)
    expect(input(el).value).toBe('example.com')
    expect([input(el).selectionStart, input(el).selectionEnd]).toEqual([2, 'example.com'.length])
    await key(input(el), 'Tab')
    expect(input(el).value).toBe('example.com')
    expect(uiStore.get().urlbar.open).toBe(true)
    expect(callsTo<{ query: string }>('urlbar.suggest').at(-1)?.query).toBe('example.com')
  })
})

describe('removing a row (omnibox-22)', () => {
  it('Shift+Delete on a history row removes it and moves the highlight to the next row', async () => {
    suggestions = (q) => (q ? [history(1), history(2), history(3)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 3)
    await key(input(el), 'ArrowDown')
    await key(input(el), 'ArrowDown')
    expect(selectedRow(el)?.textContent).toContain('Page 2')
    await key(input(el), 'Delete', { shift: true })
    expect(callsTo('history.delete')).toEqual([{ url: 'https://example.com/2' }])
    expect(rows(el)).toHaveLength(2)
    expect(selectedRow(el)?.textContent).toContain('Page 3')
    expect(input(el).value).toBe('example.com/3')
  })

  it('the X removes the row it is on; a remembered search is forgotten, not a history entry', async () => {
    suggestions = (q) =>
      q
        ? [
            history(1),
            row('search', 'cats', 'cats', 'https://www.google.com/search?q=cats', {
              deletable: true,
              targetId: 'google'
            })
          ]
        : []
    const el = await render(desktop())
    await typeAndList(el, 'c', 2)
    const x = removeX(rows(el)[1])!
    await act(async () => {
      x.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(callsTo('urlbar.forgetShortcut')).toEqual([
      { url: 'https://www.google.com/search?q=cats' }
    ])
    expect(callsTo('history.delete')).toEqual([])
    expect(rows(el)).toHaveLength(1)
  })

  it('bookmark and tab rows have no X and Shift+Delete leaves them', async () => {
    suggestions = (q) =>
      q
        ? [bookmark(1), row('tab', 'Open tab', 'tab', 'https://open.example/', { targetId: 't2' })]
        : []
    const el = await render(desktop())
    await typeAndList(el, 'o', 2)
    for (const r of rows(el)) expect(removeX(r)).toBeNull()
    await key(input(el), 'ArrowDown')
    await key(input(el), 'Delete', { shift: true })
    expect(rows(el)).toHaveLength(2)
    expect(commands()).not.toContain('history.delete')
  })
})

describe('Enter with modifiers and the mouse (omnibox-24, -25)', () => {
  it('Alt+Enter a new foreground tab, Shift+Enter a new window, Alt+Shift+Enter behind', async () => {
    const el = await render(desktop())
    await type(input(el), 'cats')
    await key(input(el), 'Enter', { alt: true })
    expect(submits().at(-1)).toMatchObject({ input: 'cats', newTab: true, background: false })
    expect(submits().at(-1)?.newWindow).toBe(false)

    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    await key(input(el), 'Enter', { shift: true })
    expect(submits().at(-1)).toMatchObject({ input: 'cats', newWindow: true, newTab: false })

    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    await key(input(el), 'Enter', { shift: true, alt: true })
    expect(submits().at(-1)).toMatchObject({ input: 'cats', newTab: true, background: true })
  })

  it('Ctrl+Enter wraps www. and .com around what was typed, never a completion or a row; Ctrl+Shift+Enter in a new window', async () => {
    suggestions = (q) =>
      q ? [row('url', 'example.org', 'example.org', 'https://example.org/', { inline: true })] : []
    const el = await render(desktop())
    await type(input(el), 'exampl')
    await typeAndList(el, 'example', 1)
    expect(input(el).value).toBe('example.org')
    await key(input(el), 'Enter', { ctrl: true })
    expect(submits().at(-1)).toMatchObject({ input: 'www.example.com', newWindow: false })

    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    await key(input(el), 'Enter', { ctrl: true, shift: true })
    expect(submits().at(-1)).toMatchObject({ input: 'www.example.com', newWindow: true })
  })

  it('a middle click or Ctrl+click on a row opens it in a background tab, a plain press here', async () => {
    suggestions = (q) => (q ? [history(1)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 1)
    const option = rows(el)[0].querySelector<HTMLElement>('[role="option"]')!
    await press(option, { button: 1 })
    expect(submits().at(-1)).toMatchObject({
      input: 'https://example.com/1',
      newTab: true,
      background: true
    })

    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    await press(option, { ctrl: true })
    expect(submits().at(-1)).toMatchObject({ newTab: true, background: true })

    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    await press(option)
    expect(submits().at(-1)).toMatchObject({ newTab: false, background: false })
  })

  it('a pick carries what was typed for the shortcuts provider (omnibox-03)', async () => {
    suggestions = (q) => (q ? [history(1)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 1)
    await key(input(el), 'ArrowDown')
    expect(input(el).value).toBe('example.com/1')
    await key(input(el), 'Enter')
    expect(submits().at(-1)).toMatchObject({
      input: 'https://example.com/1',
      learn: { typed: 'pa', title: 'Page 1', kind: 'url' }
    })
  })
})

describe('keyword mode and search mode (omnibox-08, -26)', () => {
  it('an engine\u2019s keyword then Tab: the chip, the engine\u2019s glyph, the field emptied; Backspace brings the keyword back', async () => {
    const el = await render(desktop())
    expect(glyph(el)).toBe('G')
    // The letter is an image named for the engine (a11y-02), not a word a screen reader spells.
    const mark = el.querySelector('.zen-omnibox-engine')!
    expect(mark.getAttribute('role')).toBe('img')
    expect(mark.getAttribute('aria-label')).toBe('Search engine: Google')
    await type(input(el), '@ddg')
    await key(input(el), 'Tab')
    expect(chip(el)?.textContent).toBe('Search DuckDuckGo')
    expect(glyph(el)).toBe('D')
    expect(mark.getAttribute('aria-label')).toBe('Search engine: DuckDuckGo')
    expect(input(el).value).toBe('')
    expect(callsTo<{ engineId?: string }>('urlbar.suggest').at(-1)?.engineId).toBe('duckduckgo')

    await type(input(el), 'cats')
    await key(input(el), 'Enter')
    expect(submits().at(-1)).toMatchObject({ input: 'https://duckduckgo.com/?q=cats' })
    // A keyword search is not learned as the default engine's search.
    expect(submits().at(-1)?.learn).toBeUndefined()
  })

  it('Backspace on the empty query leaves keyword mode with the typed text back; so does Escape', async () => {
    const el = await render(desktop())
    await type(input(el), 'duckduckgo.com')
    await key(input(el), 'Tab')
    expect(chip(el)?.textContent).toBe('Search DuckDuckGo')
    await key(input(el), 'Backspace')
    expect(chip(el)).toBeNull()
    expect(glyph(el)).toBe('G')
    expect(input(el).value).toBe('duckduckgo.com')
    expect(callsTo<{ engineId?: string }>('urlbar.suggest').at(-1)?.engineId).toBeUndefined()

    await key(input(el), 'Tab')
    expect(chip(el)).not.toBeNull()
    await key(input(el), 'Escape')
    expect(chip(el)).toBeNull()
    expect(input(el).value).toBe('duckduckgo.com')
    expect(uiStore.get().urlbar.open).toBe(true)
  })

  it('the engine\u2019s name then Tab enters keyword mode; the name then Space stays a query (Chrome)', async () => {
    let el = await render(desktop())
    await type(input(el), 'wikipedia')
    await key(input(el), 'Tab')
    expect(chip(el)?.textContent).toBe('Search Wikipedia (en)')
    expect(glyph(el)).toBe('W')
    act(() => root?.unmount())
    host?.remove()

    el = await render(desktop())
    await type(input(el), 'google ')
    expect(chip(el)).toBeNull()
    expect(input(el).value).toBe('google ')
  })

  it('the keyword then Space enters keyword mode', async () => {
    const el = await render(desktop())
    await type(input(el), '@bing', '@bing')
    await type(input(el), '@bing ', '')
    expect(chip(el)?.textContent).toBe('Search Bing')
    expect(input(el).value).toBe('')
  })

  it('Chrome\u2019s legacy ? prefix is search mode for the default engine', async () => {
    const el = await render(desktop())
    await type(input(el), '?', '')
    expect(chip(el)?.textContent).toBe('Search Google')
    expect(input(el).value).toBe('')
    await type(input(el), 'example.com')
    await key(input(el), 'Enter')
    expect(submits().at(-1)).toMatchObject({
      input: 'https://www.google.com/search?q=example.com',
      learn: { typed: 'example.com', title: 'example.com', kind: 'search' }
    })
  })

  it('Ctrl+K opens the bar in search mode: the chip up from the start, nothing to bring back', async () => {
    const el = await render(desktop(tab(PAGE), 'search'))
    expect(chip(el)?.textContent).toBe('Search Google')
    expect(input(el).placeholder).toBe('Search with Google')
    await type(input(el), 'x')
    await key(input(el), 'Backspace')
    expect(chip(el)).not.toBeNull()
    await type(input(el), '')
    await key(input(el), 'Backspace')
    expect(chip(el)).toBeNull()
    expect(input(el).value).toBe('')
  })

  it('a click on the chip leaves keyword mode', async () => {
    const el = await render(desktop())
    await type(input(el), '@ddg')
    await key(input(el), 'Tab')
    await act(async () => {
      chip(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(chip(el)).toBeNull()
    expect(input(el).value).toBe('@ddg')
  })
})

describe('zero-suggest groups (omnibox-20)', () => {
  it('draws a heading where a group starts, none for rows without one', async () => {
    suggestions = (q) =>
      q
        ? []
        : [
            row('search', 'cats', 'cats', 'https://g/1', {
              group: 'Recent searches',
              deletable: true
            }),
            row('search', 'dogs', 'dogs', 'https://g/2', {
              group: 'Recent searches',
              deletable: true
            }),
            history(1)
          ]
    const el = await render(desktop(tab('zen://newtab'), 'new-tab'))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(3))
    })
    const headings = Array.from(el.querySelectorAll('[data-testid="urlbar-group-heading"]'))
    expect(headings.map((h) => h.textContent)).toEqual(['Recent searches'])
    const items = Array.from(el.querySelectorAll('ul[role="listbox"] > li'))
    expect(items[0].getAttribute('data-testid')).toBe('urlbar-group-heading')
    expect(items[1].classList.contains('zen-omnibox-row')).toBe(true)
  })
})

describe('the rows and the field at §6 (the lead\u2019s ruling on #289)', () => {
  it('a row is one line – the title, then " — " and the host or the engine trailing it; the engine is named on the first search row only; the answer reads "= 4 — 2+2"', async () => {
    suggestions = (q) =>
      q
        ? [
            row('url', 'example.com', 'example.com/', 'https://example.com/', { subtitle: '' }),
            row('search', '2+2', '2+2', 'https://g/?q=2%2B2', { subtitle: 'Search with Google' }),
            row('answer', '= 4', '2+2', 'https://g/?q=2%2B2', { subtitle: '2+2' }),
            row('search', '2+2=4', '2+2=4', 'https://g/?q=2%2B2%3D4', {
              subtitle: 'Search with Google'
            }),
            history(1)
          ]
        : []
    const el = await render(desktop())
    await typeAndList(el, '2+2', 5)
    // No second line anywhere: the row's text is one body, no description slot under a label.
    expect(el.querySelector('ul[role="listbox"] .zen-v2-description')).toBeNull()
    expect(el.querySelector('ul[role="listbox"] .zen-v2-row-text')).toBeNull()
    const r = rows(el)
    const option = (i: number): string => r[i].querySelector('[role="option"]')!.textContent!
    const trailing = (i: number): string | null =>
      r[i].querySelector('.zen-omnibox-row-host')?.textContent ?? null
    for (const li of r) expect(li.classList.contains('zen-v2-row')).toBe(true)
    // The verbatim URL row: its title alone.
    expect(trailing(0)).toBeNull()
    expect(option(0)).toBe('example.com')
    // The first search row – Zen's heuristic row – names the engine after the dash…
    expect(trailing(1)).toBe(' — Search with Google')
    // …the answer row is the answer, then the expression…
    expect(option(2)).toBe('= 4 — 2+2')
    // …a search suggestion under the heuristic row is bare (its completion still emphasised)…
    expect(trailing(3)).toBeNull()
    expect(option(3)).toBe('2+2=4')
    expect(r[3].querySelector('mark')?.textContent).toBe('=4')
    // …and a page keeps its host.
    expect(trailing(4)).toBe(' — example.com')
  })

  it('names the engine on the first search row wherever it stands – after a URL row, or first in zero-suggest under its heading', async () => {
    suggestions = (q) =>
      q
        ? []
        : [
            row('search', 'cats', 'cats', 'https://g/1', {
              subtitle: 'Search with Google',
              group: 'Recent searches',
              deletable: true
            }),
            row('search', 'dogs', 'dogs', 'https://g/2', {
              subtitle: 'Search with Google',
              group: 'Recent searches',
              deletable: true
            }),
            history(1)
          ]
    const el = await render(desktop(tab('zen://newtab'), 'new-tab'))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(3))
    })
    const hosts = rows(el).map((li) => li.querySelector('.zen-omnibox-row-host')?.textContent)
    expect(hosts).toEqual([' — Search with Google', undefined, ' — example.com'])
  })

  it('the field row carries no "Current tab" badge – nothing trails the input (pr-123\u2019s deferred badge verdict, closed on #289)', async () => {
    const el = await render(desktop())
    const inputRow = input(el).closest('.zen-omnibox-input-row')!
    expect(inputRow.textContent).not.toContain('Current tab')
    expect(inputRow.querySelector('.zen-omnibox-badge')).toBeNull()
    expect(input(el).nextElementSibling).toBeNull()
  })
})

/*
 * The new tab's bar and the page taking the keyboard (lib/panes.ts `pageTookKeyboard`): the
 * `zen://newtab` view takes the keyboard as it is shown, racing the bar's mount. A fast machine
 * has the field's focus land after and win; a slow one had the blur land after the focus and
 * the bar stood with no caret (#342 met it in CI). The rule: a chrome field the user types in is
 * never blurred by a page taking the keyboard – the bar keeps its field and takes the keyboard
 * back.
 */
describe("the keyboard, when the page's view takes it", () => {
  /** The `focus.page` event as `useMainEvents` hands it on, after the bar has rendered. */
  async function pageTakesKeyboard(tabId: string): Promise<string> {
    let outcome = ''
    await act(async () => {
      outcome = pageTookKeyboard(tabId)
      await Promise.resolve()
    })
    return outcome
  }

  it("the new tab's bar has its field focused whichever came first – the field's focus or the page's view taking the keyboard", async () => {
    const el = await render(desktop(tab('zen://newtab'), 'new-tab'))
    expect(document.activeElement).toBe(input(el))
    invoke.mockClear()
    // The slow machine's order: the field had the focus, then the view took the keyboard – the
    // blur the old rule applied (and the CI harness's --force-urlbar-blur still applies)…
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    // …and the event itself: the bar takes the keyboard back and the caret is in the field.
    expect(await pageTakesKeyboard('t1')).toBe('kept')
    expect(document.activeElement).toBe(input(el))
    expect(commands()).toEqual(['focus.chrome'])
    // The event alone, the field still focused: the chrome's keyboard is asked back all the
    // same (the page's view holds it), the field is left as it is.
    invoke.mockClear()
    expect(await pageTakesKeyboard('t1')).toBe('kept')
    expect(document.activeElement).toBe(input(el))
    expect(commands()).toEqual(['focus.chrome'])
  })

  it("leaves the keyboard on a row's X the user tabbed to, asking the chrome's keyboard back all the same", async () => {
    suggestions = (q) => (q ? [history(1)] : [])
    const el = await render(desktop())
    await typeAndList(el, 'pa', 1)
    await key(input(el), 'Tab')
    await key(input(el), 'Tab')
    const x = removeX(rows(el)[0])!
    expect(document.activeElement).toBe(x)
    invoke.mockClear()
    expect(await pageTakesKeyboard('t1')).toBe('kept')
    expect(document.activeElement).toBe(x)
    expect(commands()).toEqual(['focus.chrome'])
  })

  it('a bar that has closed is not told anything: the stale control is let go as before', async () => {
    const el = await render(desktop())
    await key(input(el), 'Escape')
    expect(uiStore.get().urlbar.open).toBe(false)
    // The bar's field would be gone with the bar; here the test DOM keeps it, so the release
    // shows on it as on any control.
    input(el).focus()
    invoke.mockClear()
    expect(await pageTakesKeyboard('t1')).toBe('released')
    expect(document.activeElement).toBe(document.body)
    expect(commands()).toEqual([])
  })
})
