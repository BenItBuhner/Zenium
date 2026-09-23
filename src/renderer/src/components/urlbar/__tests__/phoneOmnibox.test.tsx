// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Fragment, act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClipboardContent, Suggestion, Tab, UIState } from '@shared/types'
import type { UrlbarState } from '@renderer/lib/ui'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { NEW_TAB_URL } from '@shared/url'

/*
 * The phone omnibox against Chrome for Android: the search-ready header over a page with Share,
 * Copy link and Edit (OMN-05), the Refine arrow on query rows (OMN-09), the clipboard row whose
 * content is read once on the reveal (OMN-14), and the URL keyboard (OMN-25). Rendered for real;
 * the host is a recording stub. The desktop bar is checked to be as it was.
 */

/** What the host answers per command; `urlbar.suggest` answers from `suggestions`. */
let suggestions: (query: string) => Suggestion[] = () => []
let clip: ClipboardContent = { kind: 'url', text: 'https://copied.example/page' }
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) => {
  if (name === 'urlbar.suggest') return suggestions((args as { query: string }).query)
  if (name === 'clipboard.read') return clip
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { HEADER_SWAP_FADE_MS, Urlbar } = await import('../Urlbar')
const { isShareableUrl, showsPageHeader } = await import('../omniboxHeader')
const { uiStore } = await import('@renderer/lib/ui')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { omniboxFocusSurfaces } = await import('@renderer/lib/omniboxFocus')

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
    platform: 'android',
    capabilities: {},
    tabs: { [t.id]: t },
    spaces: [],
    activeSpaceId: 'space',
    settings: { ...DEFAULT_SETTINGS },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

function urlbarState(mode: UrlbarState['mode'], tabId: string | null = 't1'): UrlbarState {
  return { open: true, mode, tabId, initialText: undefined, attached: true }
}

const PAGE = 'https://example.com/some/path'

const row = (
  kind: Suggestion['kind'],
  title: string,
  fill: string,
  url: string | null
): Suggestion => ({
  id: `${kind}:${title}`,
  kind,
  title,
  subtitle: url ? 'example.com' : '',
  url,
  favicon: null,
  targetId: kind === 'clipboard' ? 'url' : null,
  fill
})

let root: Root | null = null
let host: HTMLElement | null = null

async function render(el: ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(el)
  })
  // The first suggestion request runs on a timer after mount; wait for it to land.
  await act(async () => {
    await vi.waitFor(() => expect(commands()).toContain('urlbar.suggest'))
  })
  return host
}

/**
 * The phone omnibox, with the frame's dialog host after it (the shell's order): where the hold's
 * prompt sheet mounts (OMN-17). The omnibox stays the first child, the tests' scrim.
 */
function phone(t: Tab, mode: UrlbarState['mode'] = 'edit'): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(Urlbar, {
      state: state(t),
      urlbar: urlbarState(mode),
      area: null,
      phoneEdge: 'top'
    }),
    createElement(FrameDialogHost, { frame: true })
  )
}

const commands = (): string[] => invoke.mock.calls.map(([name]) => name)
const callsTo = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const input = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]')!
const header = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>('[data-testid="urlbar-page-header"]')
const button = (scope: ParentNode, text: string): HTMLButtonElement =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text
  )!
/**
 * The list's rows. On the phone a row holds the option (what a tap picks) and, as its sibling,
 * its Show or Refine control; on the desktop the row is the option.
 */
const rows = (el: HTMLElement): HTMLElement[] =>
  Array.from(el.querySelectorAll<HTMLElement>('ul[role="listbox"] > li'))
const option = (row: HTMLElement): HTMLElement =>
  row.getAttribute('role') === 'option' ? row : row.querySelector<HTMLElement>('[role="option"]')!

/** A tap: the pointer goes down (a touch, so the row waits for the click), then the click. */
async function tap(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

/**
 * Typing: the value goes in through the prototype's setter (past React's value tracker, which
 * would otherwise see nothing changed and swallow the event), then the input event.
 */
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeValue.call(el, value)
    el.setSelectionRange(value.length, value.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  invoke.mockClear()
  suggestions = () => []
  clip = { kind: 'url', text: 'https://copied.example/page' }
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('showsPageHeader', () => {
  it('is up on the phone over a page while nothing is typed; never on desktop or a new tab', () => {
    const page = tab(PAGE)
    expect(showsPageHeader(true, 'edit', page, '')).toBe(true)
    expect(showsPageHeader(true, 'edit', page, 'c')).toBe(false)
    expect(showsPageHeader(true, 'edit', tab(NEW_TAB_URL), '')).toBe(false)
    expect(showsPageHeader(true, 'edit', tab('zen://blank'), '')).toBe(false)
    expect(showsPageHeader(true, 'new-tab', page, '')).toBe(false)
    expect(showsPageHeader(true, 'search', page, '')).toBe(false)
    expect(showsPageHeader(true, 'edit', null, '')).toBe(false)
    expect(showsPageHeader(false, 'edit', page, '')).toBe(false)
  })
})

describe('the search-ready header (OMN-05)', () => {
  it('opens empty over a page with the title, the address and Share, Copy link, Edit', async () => {
    const el = await render(phone(tab(PAGE)))
    expect(input(el).value).toBe('')
    const head = header(el)!
    expect(head).not.toBeNull()
    expect(head.textContent).toContain('Example Domain')
    expect(head.textContent).toContain('example.com/some/path')
    const chips = Array.from(head.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(chips).toEqual(['Share', 'Copy link', 'Edit'])
    // The omnibox is a window surface (v2 §9.29).
    expect(head.closest('[data-surface="window"]')).not.toBeNull()
  })

  it('shows no header over the new tab page and takes it down once something is typed', async () => {
    const el = await render(phone(tab(NEW_TAB_URL), 'new-tab'))
    expect(header(el)).toBeNull()
    act(() => root?.unmount())
    invoke.mockClear()

    const page = await render(phone(tab(PAGE)))
    expect(header(page)).not.toBeNull()
    await type(input(page), 'c')
    expect(header(page)).toBeNull()
  })

  it('Edit puts the full address in the field, caret at the end, nothing submitted', async () => {
    const el = await render(phone(tab(PAGE)))
    invoke.mockClear()
    await tap(button(header(el)!, 'Edit'))
    const field = input(el)
    expect(field.value).toBe(PAGE)
    expect(field.selectionStart).toBe(PAGE.length)
    expect(field.selectionEnd).toBe(PAGE.length)
    expect(header(el)).toBeNull()
    expect(commands()).not.toContain('urlbar.submit')
    // The suggestions refresh for the address, as if it had been typed.
    expect(callsTo('urlbar.suggest')).toContainEqual({ query: PAGE, tabId: 't1', grouped: true })
    expect(uiStore.get().urlbar.open).toBe(true)
  })

  it('Copy link copies the address and keeps the bar; Share hands the page to the system sheet', async () => {
    const el = await render(phone(tab(PAGE)))
    invoke.mockClear()
    await tap(button(header(el)!, 'Copy link'))
    expect(callsTo('tab.copyUrl')).toEqual([{ tabId: 't1' }])
    expect(header(el)).not.toBeNull()
    expect(uiStore.get().urlbar.open).toBe(true)

    await tap(button(header(el)!, 'Share'))
    expect(callsTo('app.share')).toEqual([
      { title: 'Example Domain', url: PAGE, tabId: 't1', favicon: undefined }
    ])
    expect(uiStore.get().urlbar.open).toBe(false)
  })
})

describe('the header changing in place (v2 §11.4)', () => {
  it('cross-fades the page row over 120 ms in its slot when the title or address changes under the open bar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const loading = tab(PAGE, { title: '', loading: true })
      const el = await render(phone(loading))
      const face = (): HTMLElement[] =>
        Array.from(header(el)!.querySelectorAll<HTMLElement>('.zen-omnibox-page-face'))
      // Nothing typed yet; the address stands in for the title while the page loads. No ghost.
      expect(face()).toHaveLength(1)
      expect(face()[0].textContent).toContain('example.com/some/path')

      // The title arrives: the old face stays as a ghost over the new one, out of the tab order.
      await act(async () => {
        root!.render(phone(tab(PAGE, { title: 'Example Domain', loading: false })))
      })
      const faces = face()
      expect(faces).toHaveLength(2)
      expect(faces[0].textContent).toContain('Example Domain')
      expect(faces[1].classList.contains('zen-omnibox-page-ghost')).toBe(true)
      expect(faces[1].getAttribute('aria-hidden')).toBe('true')
      expect(faces[1].textContent).not.toContain('Example Domain')
      // The row itself is the same element: the change is in place, not a new row.
      expect(header(el)!.querySelectorAll('.zen-omnibox-page')).toHaveLength(1)

      // The ghost is gone after the fade's 120 ms.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HEADER_SWAP_FADE_MS + 20)
      })
      expect(face()).toHaveLength(1)
      expect(face()[0].textContent).toContain('Example Domain')

      // A re-render that changes nothing the face draws starts no fade.
      await act(async () => {
        root!.render(phone(tab(PAGE, { title: 'Example Domain', loading: false, audible: true })))
      })
      expect(face()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the header on an internal page (D5)', () => {
  it('offers Copy link and Edit on zenium://settings, and no Share', async () => {
    const settings = tab('zen://settings', { title: 'Settings' })
    const el = await render(phone(settings))
    const head = header(el)!
    expect(head).not.toBeNull()
    expect(head.textContent).toContain('Settings')
    expect(head.textContent).toContain('zenium://settings')
    const chips = Array.from(head.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(chips).toEqual(['Copy link', 'Edit'])
    invoke.mockClear()
    await tap(button(head, 'Copy link'))
    expect(callsTo('tab.copyUrl')).toEqual([{ tabId: 't1' }])
    await tap(button(head, 'Edit'))
    expect(input(el).value).toBe('zenium://settings')
    expect(commands()).not.toContain('app.share')
  })

  it('isShareableUrl: http(s) pages only', () => {
    expect(isShareableUrl('https://example.com/')).toBe(true)
    expect(isShareableUrl('HTTP://example.com/a?b=c')).toBe(true)
    expect(isShareableUrl('zen://settings')).toBe(false)
    expect(isShareableUrl('zenium://settings')).toBe(false)
    expect(isShareableUrl('file:///sdcard/page.html')).toBe(false)
    expect(isShareableUrl('about:blank')).toBe(false)
    expect(isShareableUrl('')).toBe(false)
  })
})

describe('the Refine arrow (OMN-09)', () => {
  it('sits on query rows only and puts the text in the field without submitting', async () => {
    suggestions = (q) =>
      q === 'cats'
        ? [
            row('search', 'cats', 'cats', 'https://www.google.com/search?q=cats'),
            row(
              'search',
              'cats pictures',
              'cats pictures',
              'https://www.google.com/search?q=cats+pictures'
            ),
            row(
              'history',
              'Cats - Wikipedia',
              'en.wikipedia.org/wiki/Cat',
              'https://en.wikipedia.org/wiki/Cat'
            )
          ]
        : []
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(3))
    })
    const [verbatim, query, url] = rows(el)
    // The verbatim row would change nothing; the URL row is not a query.
    expect(verbatim.querySelector('[aria-label="Refine"]')).toBeNull()
    expect(url.querySelector('[aria-label="Refine"]')).toBeNull()
    const refine = query.querySelector<HTMLButtonElement>('[aria-label="Refine"]')!
    expect(refine).not.toBeNull()
    // Beside the option, not inside it: an option's children are presentational to assistive
    // technology, so a button within one would be unreachable (TalkBack, UiAutomation).
    expect(option(query).contains(refine)).toBe(false)
    expect(option(query).textContent).toBe('cats pictures')

    invoke.mockClear()
    await tap(refine)
    expect(input(el).value).toBe('cats pictures')
    expect(commands()).not.toContain('urlbar.submit')
    expect(callsTo('urlbar.suggest')).toEqual([
      { query: 'cats pictures', tabId: 't1', grouped: true }
    ])
    expect(uiStore.get().urlbar.open).toBe(true)
  })
})

describe('the clipboard row (OMN-14)', () => {
  const clipRow = (): Suggestion => ({
    ...row('clipboard', 'Link you copied', '', null),
    id: 'clipboard'
  })

  it('shows the kind alone behind Show; the reveal reads the content once and the pick opens it', async () => {
    suggestions = (q) => (q === '' ? [clipRow()] : [])
    const el = await render(phone(tab(PAGE)))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(1))
    })
    const [item] = rows(el)
    expect(item.getAttribute('data-kind')).toBe('clipboard')
    expect(item.textContent).toContain('Link you copied')
    expect(item.textContent).not.toContain('copied.example')
    expect(commands()).not.toContain('clipboard.read')

    const show = button(item, 'Show')
    expect(option(item).contains(show)).toBe(false)
    await tap(show)
    await act(async () => {
      await vi.waitFor(() =>
        expect(rows(el)[0].textContent).toContain('https://copied.example/page')
      )
    })
    expect(callsTo('clipboard.read')).toHaveLength(1)
    expect(rows(el)[0].querySelector('button')).toBeNull()

    await tap(option(rows(el)[0]))
    await act(async () => {
      await vi.waitFor(() => expect(commands()).toContain('urlbar.submit'))
    })
    // Revealed once, opened from what was revealed: no second read.
    expect(callsTo('clipboard.read')).toHaveLength(1)
    expect(callsTo('urlbar.submit')[0]).toMatchObject({ input: 'https://copied.example/page' })
    // The pick used the clip up (the reveal alone had not): the host will not offer it again.
    expect(callsTo('clipboard.markUsed')).toHaveLength(1)
    expect(commands().indexOf('clipboard.markUsed')).toBeGreaterThan(
      commands().lastIndexOf('clipboard.read')
    )
  })

  it('picked unrevealed, reads once and searches text with the default engine', async () => {
    clip = { kind: 'text', text: 'grey cats' }
    suggestions = (q) =>
      q === '' ? [{ ...clipRow(), title: 'Text you copied', targetId: 'text' }] : []
    const el = await render(phone(tab(PAGE)))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(1))
    })
    await tap(option(rows(el)[0]))
    await act(async () => {
      await vi.waitFor(() => expect(commands()).toContain('urlbar.submit'))
    })
    expect(callsTo('clipboard.read')).toHaveLength(1)
    expect(callsTo('urlbar.submit')[0]).toMatchObject({
      input: 'https://www.google.com/search?q=grey%20cats'
    })
    expect(callsTo('clipboard.markUsed')).toHaveLength(1)
  })

  it('takes the row away when the clip is gone by the time it is revealed', async () => {
    clip = { kind: 'none', text: '' }
    suggestions = (q) => (q === '' ? [clipRow()] : [])
    const el = await render(phone(tab(PAGE)))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(1))
    })
    await tap(button(rows(el)[0], 'Show'))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(0))
    })
    expect(commands()).not.toContain('urlbar.submit')
    // Nothing was opened: nothing is marked used.
    expect(commands()).not.toContain('clipboard.markUsed')
  })

  it('a reveal alone does not mark the clip used', async () => {
    suggestions = (q) => (q === '' ? [clipRow()] : [])
    const el = await render(phone(tab(PAGE)))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(1))
    })
    await tap(button(rows(el)[0], 'Show'))
    await act(async () => {
      await vi.waitFor(() =>
        expect(rows(el)[0].textContent).toContain('https://copied.example/page')
      )
    })
    expect(callsTo('clipboard.read')).toHaveLength(1)
    expect(commands()).not.toContain('clipboard.markUsed')
    expect(commands()).not.toContain('urlbar.submit')
  })
})

describe('the URL keyboard (OMN-25)', () => {
  it('asks for the URL keyboard with Go, no capitalisation, correction or spell check', async () => {
    const el = await render(phone(tab(PAGE)))
    const field = input(el)
    expect(field.getAttribute('inputmode')).toBe('url')
    expect(field.getAttribute('enterkeyhint')).toBe('go')
    expect(field.getAttribute('autocapitalize')).toBe('off')
    expect(field.getAttribute('autocorrect')).toBe('off')
    expect(field.getAttribute('autocomplete')).toBe('off')
    expect(field.getAttribute('spellcheck')).toBe('false')
  })

  it('submits on Enter while the keyboard still has the last word composing', async () => {
    // Gboard keeps the current word in a composition (the underline) and lets a hardware Enter
    // through with it open; Chrome's omnibox submits on it, and so does the pill's editor.
    const el = await render(phone(tab(PAGE)))
    const field = input(el)
    await type(field, 'single origin')
    invoke.mockClear()
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })
      )
      await Promise.resolve()
    })
    await act(async () => {
      await vi.waitFor(() => expect(commands()).toContain('urlbar.submit'))
    })
    expect(callsTo('urlbar.submit')[0]).toMatchObject({ input: 'single origin' })
  })
})

/*
 * The draft after a dismissal (a program default of 19 Sep 2026): the phone discards what was
 * typed, as Chrome for Android does, so the next focus on the same page is search-ready with the
 * header and the clipboard row; the desktop keeps Zen's per-tab draft. The scrim press and the
 * back gesture's `dismissed` share the one close path, so the scrim stands in for both here.
 */
describe('the draft after a dismissal', () => {
  const clipRow = (): Suggestion => ({
    ...row('clipboard', 'Link you copied', '', null),
    id: 'clipboard'
  })
  /** The bar's backdrop: a press on it, outside the sheet or the panel, dismisses the bar. */
  const scrim = (el: HTMLElement): HTMLElement => el.firstElementChild as HTMLElement
  async function dismiss(el: HTMLElement): Promise<void> {
    await act(async () => {
      scrim(el).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(commands()).toContain('urlbar.cancel')
    expect(commands()).not.toContain('urlbar.submit')
    // The bar is closed; the next render is the next open.
    await act(async () => root!.unmount())
    host!.remove()
    invoke.mockClear()
    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
  }
  const desktop = (t: Tab): ReactElement =>
    createElement(Urlbar, {
      state: state(t),
      urlbar: urlbarState('edit'),
      area: { x: 0, y: 0, width: 1200, height: 800 },
      phoneEdge: undefined
    })

  it('phone: dismissed with text typed, the pill reopens search-ready, with the header and the clipboard row', async () => {
    suggestions = (q) => (q === '' ? [clipRow()] : [])
    let el = await render(phone(tab(PAGE)))
    await type(input(el), 'how to brew coffee')
    expect(header(el)).toBeNull()
    await dismiss(el)

    el = await render(phone(tab(PAGE)))
    expect(input(el).value).toBe('')
    expect(header(el)).not.toBeNull()
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(1))
    })
    expect(rows(el)[0].getAttribute('data-kind')).toBe('clipboard')
    expect(rows(el)[0].textContent).toContain('Link you copied')
    expect(button(rows(el)[0], 'Show')).toBeDefined()
  })

  it('phone: a draft a desktop layout kept for the page is not restored either', async () => {
    let el = await render(desktop(tab(PAGE)))
    await type(input(el), 'how to brew coffee')
    await dismiss(el)

    el = await render(phone(tab(PAGE)))
    expect(input(el).value).toBe('')
    expect(header(el)).not.toBeNull()
    // The phone's dismissal drops it for good.
    await dismiss(el)
    el = await render(desktop(tab(PAGE)))
    expect(input(el).value).toBe(PAGE)
  })

  it('desktop: the draft comes back, selected, on the next open over the same page', async () => {
    let el = await render(desktop(tab(PAGE)))
    await type(input(el), 'how to brew coffee')
    await dismiss(el)

    el = await render(desktop(tab(PAGE)))
    const field = input(el)
    expect(field.value).toBe('how to brew coffee')
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'how to brew coffee'.length])
    expect(header(el)).toBeNull()
    // Escape restores the page's address and drops the draft, as before.
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(field.value).toBe(PAGE)
    await dismiss(el)
    el = await render(desktop(tab(PAGE)))
    expect(input(el).value).toBe(PAGE)
  })
})

describe('the desktop bar is as it was', () => {
  it('opens on the page address, selected, with no header and no Refine arrows', async () => {
    suggestions = () => [
      row(
        'search',
        'cats pictures',
        'cats pictures',
        'https://www.google.com/search?q=cats+pictures'
      )
    ]
    const el = await render(
      createElement(Urlbar, {
        state: state(tab(PAGE)),
        urlbar: urlbarState('edit'),
        area: { x: 0, y: 0, width: 1200, height: 800 },
        phoneEdge: undefined
      })
    )
    expect(input(el).value).toBe(PAGE)
    expect(header(el)).toBeNull()
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(1))
    })
    expect(el.querySelector('[aria-label="Refine"]')).toBeNull()
    expect(el.querySelector('.zen-omnibox')?.getAttribute('data-surface')).toBe('page')
    // A desktop IME's Enter commits its candidate; the bar leaves it alone.
    invoke.mockClear()
    await act(async () => {
      input(el).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })
      )
      await Promise.resolve()
    })
    expect(commands()).not.toContain('urlbar.submit')
  })
})

describe('the card’s section headings (OMN-18)', () => {
  const grouped = (): Suggestion[] => [
    row('search', 'cats', 'cats', null),
    {
      ...row('history', 'Cats – Wikipedia', 'cats', 'https://en.wikipedia.org/wiki/Cat'),
      group: 'Pages'
    },
    { ...row('history', 'Cat videos', 'cats', 'https://videos.example/cats'), group: 'Pages' },
    { ...row('search', 'cats for adoption', 'cats for adoption', null), group: 'Searches' },
    { ...row('tab', 'Cat cafe', 'cats', 'https://cafe.example/'), group: 'Open tabs' }
  ]
  const headings = (el: HTMLElement): HTMLElement[] =>
    Array.from(el.querySelectorAll<HTMLElement>('[data-testid="urlbar-group-heading"]'))
  /** The list's children in DOM order: a heading's text, or a row's title. */
  const order = (el: HTMLElement): string[] =>
    rows(el).map((li) =>
      li.getAttribute('data-testid') === 'urlbar-group-heading'
        ? `# ${li.textContent}`
        : option(li).querySelector('span')!.textContent!.trim()
    )

  it('asks the core for the sectioned order on the phone, the flat one on desktop', async () => {
    await render(phone(tab(PAGE)))
    expect(callsTo('urlbar.suggest')[0]).toMatchObject({ grouped: true })
    act(() => root?.unmount())
    invoke.mockClear()
    await render(
      createElement(Urlbar, {
        state: state(tab(PAGE)),
        urlbar: urlbarState('edit'),
        area: { x: 0, y: 0, width: 1200, height: 800 }
      })
    )
    expect(callsTo('urlbar.suggest')[0]).not.toHaveProperty('grouped')
  })

  it('draws each group’s heading over its rows at a top dock: the default match alone, then Pages, Searches, Open tabs', async () => {
    suggestions = grouped
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    const heads = headings(el)
    expect(heads.map((h) => h.textContent)).toEqual(['Pages', 'Searches', 'Open tabs'])
    // The shared primitive on the card's own modifier; a heading to TalkBack (announced as one,
    // reachable by heading navigation), not a presentational item heard as plain text.
    for (const h of heads) {
      expect(h.className).toContain('zen-v2-heading')
      expect(h.className).toContain('zen-omnibox-sheet-heading')
      expect(h.getAttribute('role')).toBe('heading')
      expect(h.getAttribute('aria-level')).toBe('2')
    }
    expect(order(el)).toEqual([
      'cats',
      '# Pages',
      'Cats – Wikipedia',
      'Cat videos',
      '# Searches',
      'cats for adoption',
      '# Open tabs',
      'Cat cafe'
    ])
    // The options are the rows alone: the headings are not in the count a screen reader hears.
    expect(el.querySelectorAll('[role="option"]')).toHaveLength(5)
  })

  it('follows each group’s last row in the DOM at a bottom dock, so it stands over the group on the reversed list', async () => {
    suggestions = grouped
    const el = await render(
      createElement(Urlbar, {
        state: state(tab(PAGE)),
        urlbar: urlbarState('edit'),
        area: null,
        phoneEdge: 'bottom'
      })
    )
    await type(input(el), 'cats')
    expect(order(el)).toEqual([
      'cats',
      'Cats – Wikipedia',
      'Cat videos',
      '# Pages',
      'cats for adoption',
      '# Searches',
      'Cat cafe',
      '# Open tabs'
    ])
    expect(el.querySelector('ul[role="listbox"]')!.getAttribute('data-edge')).toBe('bottom')
  })

  it('keeps a heading’s element across a keystroke that keeps its group, so only an arriving one fades in', async () => {
    suggestions = grouped
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cat')
    const pages = headings(el).find((h) => h.textContent === 'Pages')!
    suggestions = () => grouped().filter((r) => r.group !== 'Open tabs')
    await type(input(el), 'cats')
    expect(headings(el).map((h) => h.textContent)).toEqual(['Pages', 'Searches'])
    expect(headings(el)[0]).toBe(pages)
  })
})

describe('removing a suggestion by touch (OMN-17)', () => {
  const WIKI = 'https://en.wikipedia.org/wiki/Cat'
  const removable = (): Suggestion[] => [
    row('search', 'cats', 'cats', null),
    { ...row('history', 'Cats – Wikipedia', 'cats', WIKI), group: 'Pages', deletable: true },
    {
      ...row('history', 'Cat videos', 'cats', 'https://videos.example/cats'),
      group: 'Pages',
      deletable: true
    },
    { ...row('search', 'cats for adoption', 'cats for adoption', null), group: 'Searches' }
  ]
  const rowOf = (el: HTMLElement, title: string): HTMLElement | null =>
    rows(el).find(
      (li) =>
        li.getAttribute('data-testid') !== 'urlbar-group-heading' &&
        option(li).querySelector('span')!.textContent!.trim() === title
    ) ?? null
  const headingOf = (el: HTMLElement, group: string): HTMLElement | null =>
    el.querySelector<HTMLElement>(`[data-testid="urlbar-group-heading"][data-group="${group}"]`)
  /** The prompt sheet, on the frame's dialog host (v2 §9.23). */
  const prompt = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')
  const promptButtons = (): HTMLButtonElement[] =>
    Array.from(prompt()?.querySelectorAll<HTMLButtonElement>('.zen-sheet-footer button') ?? [])
  const promptButton = (label: string): HTMLButtonElement | undefined =>
    promptButtons().find((b) => b.textContent?.trim() === label)
  const omnibox = (el: HTMLElement): HTMLElement =>
    el.querySelector<HTMLElement>('.zen-omnibox-sheet')!

  /** A finger held on the row past the hold's 380 ms, then lifted: the click that follows is the hold's. */
  async function hold(el: HTMLElement): Promise<void> {
    const at = {
      bubbles: true,
      pointerType: 'touch',
      pointerId: 7,
      button: 0,
      clientX: 40,
      clientY: 40
    }
    await act(async () => {
      el.dispatchEvent(new PointerEvent('pointerdown', at))
      await new Promise((r) => setTimeout(r, 420))
      el.dispatchEvent(new PointerEvent('pointerup', at))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
  }
  /**
   * Wait for a spring on real frames – the prompt's leave, the row's exit – to bring things to
   * `until`: in short `act` spans, each of which lets React flush what the frames queued.
   */
  async function settle(until: () => boolean, what = 'the exit'): Promise<void> {
    const start = Date.now()
    while (!until()) {
      if (Date.now() - start > 4000) throw new Error(`${what} did not settle`)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })
    }
  }
  // The prompt's chassis needs room to stand: happy-dom lays nothing out, and a sheet whose
  // layer and content measure 0 lands closed the moment it has risen. The layer is 800 px tall
  // and the sheet's content 300 px, as the overview's prompt tests give theirs.
  let sizes: Array<[string, PropertyDescriptor | undefined]> = []
  beforeEach(() => {
    sizes = ['clientHeight', 'offsetHeight'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    ])
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('zen-sheet-scroll') ? 300 : 800
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 300
    })
  })
  afterEach(() => {
    for (const [name, descriptor] of sizes) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
  })

  /** The prompt is up: rendered, on the host, before its rise. */
  async function asked(): Promise<HTMLElement> {
    await settle(() => prompt() !== null, 'the prompt')
    return prompt()!
  }
  /** The prompt's answer: the button pressed, the sheet's leave run out, its action run once it has gone. */
  async function answer(label: string): Promise<void> {
    const button = promptButton(label)
    expect(button, label).toBeDefined()
    await act(async () => {
      button!.click()
      await Promise.resolve()
    })
    await settle(() => prompt() === null, 'the prompt’s leave')
  }

  it('a hold on a history row asks first on a §9.23 prompt sheet: the question as its title, the suggestion’s text as its description, Cancel | Remove in the danger ink; nothing picked', async () => {
    suggestions = removable
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    await hold(option(rowOf(el, 'Cats – Wikipedia')!))
    const sheet = await asked()
    // The title block, not a 48 header (§9.23): the question, the glyph on its start, one paragraph.
    const block = sheet.querySelector<HTMLElement>('.zen-sheet-title-block')!
    expect(block).not.toBeNull()
    expect(sheet.querySelector('.zen-sheet-title')).toBeNull()
    expect(block.querySelector('h2')!.textContent).toBe('Remove suggestion from history?')
    expect(block.querySelector('h2 svg')).not.toBeNull()
    expect(block.querySelector('p')!.textContent).toBe('Cats – Wikipedia — example.com')
    expect(sheet.getAttribute('aria-labelledby')).toBe(block.querySelector('h2')!.id)
    // Cancel | Remove as §9.11 peers in the footer, Remove in the danger ink (§10.4); no rows.
    expect(
      promptButtons().map((b) => [b.textContent?.trim(), b.hasAttribute('data-danger')])
    ).toEqual([
      ['Cancel', false],
      ['Remove', true]
    ])
    expect(sheet.querySelector('.zen-sheet-item')).toBeNull()
    // The sheet itself takes the focus as it opens – a title-and-notice sheet holds its
    // container, named by the question and described by the entry; Cancel first is §9.22's
    // named failure – so a stray Enter removes nothing.
    expect(document.activeElement).toBe(sheet)
    expect(sheet.getAttribute('aria-describedby')).toBe(block.querySelector('p')!.id)
    // The omnibox under the prompt is inert while it stands (§9.22).
    expect(omnibox(el).hasAttribute('inert')).toBe(true)
    expect(commands()).not.toContain('urlbar.submit')
    expect(commands()).not.toContain('history.delete')
  })

  it('Remove deletes the entry through history.delete and the row leaves as a ghost before it is spliced out', async () => {
    suggestions = removable
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    const doomed = rowOf(el, 'Cats – Wikipedia')!
    await hold(option(doomed))
    await asked()
    await answer('Remove')
    await act(async () => {
      await vi.waitFor(() => expect(commands()).toContain('history.delete'))
    })
    expect(callsTo('history.delete')[0]).toEqual({ url: WIKI })
    // A ghost at its measured box, out of the flow (`[data-leaving]`, main.css), inert and
    // unheard, while its exit runs (v2 §11.4).
    expect(doomed.hasAttribute('data-leaving')).toBe(true)
    expect(doomed.getAttribute('aria-hidden')).toBe('true')
    expect(doomed.style.top).not.toBe('')
    expect(doomed.style.width).not.toBe('')
    // The other Pages row carries the heading meanwhile: it stays, and is not a ghost.
    expect(headingOf(el, 'Pages')!.hasAttribute('data-leaving')).toBe(false)
    await settle(() => rowOf(el, 'Cats – Wikipedia') === null)
    expect(rowOf(el, 'Cat videos')).not.toBeNull()
    expect(headingOf(el, 'Pages')).not.toBeNull()
    expect(prompt()).toBeNull()
  })

  it('the heading goes with the group’s last row, and the next heading becomes the outermost', async () => {
    suggestions = () => removable().filter((r) => r.title !== 'Cat videos')
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    expect(headingOf(el, 'Pages')!.hasAttribute('data-outer')).toBe(false)
    const doomed = rowOf(el, 'Cats – Wikipedia')!
    await hold(option(doomed))
    await asked()
    await answer('Remove')
    await act(async () => {
      await vi.waitFor(() => expect(commands()).toContain('history.delete'))
    })
    const pages = headingOf(el, 'Pages')!
    expect(pages.hasAttribute('data-leaving')).toBe(true)
    expect(pages.getAttribute('aria-hidden')).toBe('true')
    await settle(() => headingOf(el, 'Pages') === null)
    expect(rowOf(el, 'Cats – Wikipedia')).toBeNull()
    expect(rowOf(el, 'cats for adoption')).not.toBeNull()
    expect(headingOf(el, 'Searches')).not.toBeNull()
  })

  it('Cancel keeps the row and deletes nothing; the omnibox comes back from inert and the field takes the focus again', async () => {
    suggestions = removable
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    input(el).focus()
    await hold(option(rowOf(el, 'Cats – Wikipedia')!))
    await asked()
    expect(document.activeElement).not.toBe(input(el))
    await answer('Cancel')
    expect(prompt()).toBeNull()
    expect(commands()).not.toContain('history.delete')
    expect(rowOf(el, 'Cats – Wikipedia')!.hasAttribute('data-leaving')).toBe(false)
    expect(omnibox(el).hasAttribute('inert')).toBe(false)
    // Focus returns to the control that opened the prompt (§9.24): the field.
    expect(document.activeElement).toBe(input(el))
  })

  it('a second hold while the question stands asks nothing new', async () => {
    suggestions = removable
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    await hold(option(rowOf(el, 'Cats – Wikipedia')!))
    await asked()
    await hold(option(rowOf(el, 'Cat videos')!))
    expect(document.querySelectorAll('.zen-sheet[role="dialog"]')).toHaveLength(1)
    expect(prompt()!.querySelector('.zen-sheet-title-block p')!.textContent).toBe(
      'Cats – Wikipedia — example.com'
    )
  })

  it('a right click is the hold, for a mouse; a row the core does not mark removable has none', async () => {
    suggestions = removable
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    await act(async () => {
      option(rowOf(el, 'cats for adoption')!).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(prompt()).toBeNull()
    await act(async () => {
      option(rowOf(el, 'Cat videos')!).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
    })
    const sheet = await asked()
    expect(sheet.querySelector('.zen-sheet-title-block h2')!.textContent).toBe(
      'Remove suggestion from history?'
    )
    expect(sheet.querySelector('.zen-sheet-title-block p')!.textContent).toBe(
      'Cat videos — example.com'
    )
  })

  it('a plain tap on a history row still picks it', async () => {
    suggestions = removable
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    await tap(option(rowOf(el, 'Cats – Wikipedia')!))
    expect(prompt()).toBeNull()
    expect(callsTo('urlbar.submit')[0]).toMatchObject({ input: WIKI })
  })

  it('marks the outermost heading for the list’s edge margin at either dock', async () => {
    suggestions = () => [
      { ...row('history', 'Cats – Wikipedia', 'cats', WIKI), group: 'Pages', deletable: true },
      { ...row('search', 'cats for adoption', 'cats for adoption', null), group: 'Searches' }
    ]
    const el = await render(phone(tab(PAGE)))
    await type(input(el), 'cats')
    expect(headingOf(el, 'Pages')!.hasAttribute('data-outer')).toBe(true)
    expect(headingOf(el, 'Searches')!.hasAttribute('data-outer')).toBe(false)
    act(() => root?.unmount())
    const bottom = await render(
      createElement(Urlbar, {
        state: state(tab(PAGE)),
        urlbar: urlbarState('edit'),
        area: null,
        phoneEdge: 'bottom'
      })
    )
    await type(input(bottom), 'cats')
    expect(headingOf(bottom, 'Pages')!.hasAttribute('data-outer')).toBe(false)
    expect(headingOf(bottom, 'Searches')!.hasAttribute('data-outer')).toBe(true)
  })
})

/*
 * The omnibox's layer is one of the two elements the pill's focus motion writes its value on
 * (MOT-07, lib/omniboxFocus.ts; PERF-2's H3: written on the root the value had the whole
 * chrome's style recalculated every spring frame). The sheet binds the layer – the sheet's and
 * the field's parent – so every omnibox-side reader in main.css (the sheet's opacity, the field's
 * backdrop and children) is under the bound element; the bar is the other half,
 * `phone/__tests__/omniboxFocusBinding.test.tsx`.
 */
describe('the layer carries the focus motion’s value (MOT-07, PERF-2 H3)', () => {
  it('binds the layer element itself, with the sheet and the field under it, and releases it on unmount', async () => {
    const el = await render(phone(tab(PAGE)))
    const layer = el.querySelector<HTMLElement>('.zen-omnibox-layer')!
    expect(layer).not.toBeNull()
    expect(omniboxFocusSurfaces()).toContain(layer)
    expect(layer.querySelector('.zen-omnibox-sheet')).not.toBeNull()
    expect(layer.querySelector('.zen-omnibox-field')).not.toBeNull()
    expect(layer.contains(input(el))).toBe(true)
    // The bar's backdrop the dismissal tests press is this same element, not a wrapper over it.
    expect(el.firstElementChild).toBe(layer)
    act(() => root!.unmount())
    root = null
    expect(omniboxFocusSurfaces()).not.toContain(layer)
  })
})

describe('the field’s engine mark (NTP-09)', () => {
  const withEngine = (id: string): ReactElement =>
    createElement(Urlbar, {
      state: {
        ...state(tab(NEW_TAB_URL)),
        settings: { ...DEFAULT_SETTINGS, searchEngineId: id }
      } as UIState,
      urlbar: urlbarState('new-tab'),
      area: null,
      phoneEdge: 'top'
    })
  const slot = (el: HTMLElement): HTMLElement =>
    el.querySelector<HTMLElement>('.zen-omnibox-field [data-testid="engine-field-glyph"]')!

  it('leads with the vendor’s default’s favicon too, the letter tile until it loads (v2 §6)', async () => {
    const el = await render(withEngine('google'))
    const s = slot(el)
    expect(s.getAttribute('aria-label')).toBe('Search engine: Google')
    const img = s.querySelector<HTMLImageElement>('[data-testid="engine-field-favicon"]')!
    expect(img.getAttribute('src')).toBe('https://www.google.com/favicon.ico')
    expect(s.textContent).toBe('G')
    act(() => {
      img.dispatchEvent(new Event('load'))
    })
    expect(s.textContent).toBe('')
    expect(img.className).toContain('h-5 w-5')
  })

  it('shows the chosen engine’s favicon at 20 in the 28 slot once it loads, the letter until then', async () => {
    const el = await render(withEngine('bing'))
    const s = slot(el)
    expect(s.getAttribute('aria-label')).toBe('Search engine: Bing')
    const img = s.querySelector<HTMLImageElement>('[data-testid="engine-field-favicon"]')!
    expect(img.getAttribute('src')).toBe('https://www.bing.com/favicon.ico')
    expect(s.textContent).toBe('B')
    act(() => {
      img.dispatchEvent(new Event('load'))
    })
    expect(s.textContent).toBe('')
    expect(s.className).not.toContain('rounded-full')
    expect(img.className).toContain('h-5 w-5')
    // The favicon keeps its own colours; the wrapper is still the 28 slot the double lays out.
    expect(s.className).toContain('h-7 w-7')
  })

  it('shows a favicon that loaded once this session at once, with no letter first', async () => {
    // Bing's loaded in the test above; a fresh field shows it from its first frame.
    const el = await render(withEngine('bing'))
    const s = slot(el)
    expect(s.textContent).toBe('')
    const img = s.querySelector<HTMLImageElement>('[data-testid="engine-field-favicon"]')!
    expect(img.className).not.toContain('invisible')
    expect(img.dataset.arrived).toBeUndefined()
  })
})
