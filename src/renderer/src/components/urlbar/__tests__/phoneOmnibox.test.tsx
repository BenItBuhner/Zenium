// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Fragment, act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClipboardContent, Folder, Suggestion, Tab, UIState } from '@shared/types'
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
/** The history's recent entries (`history.recent`), read by a recent search's removal (OMN-04). */
let recentHistory: Array<{ url: string; title: string; lastVisit: number }> = []
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) => {
  if (name === 'urlbar.suggest') return suggestions((args as { query: string }).query)
  if (name === 'clipboard.read') return clip
  if (name === 'history.recent') return recentHistory
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { HEADER_SWAP_FADE_MS, Urlbar } = await import('../Urlbar')
const { isShareableUrl, showsPageHeader } = await import('../omniboxHeader')
const { uiStore, urlbarKeepsTabDrafts } = await import('@renderer/lib/ui')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { omniboxFocusSurfaces } = await import('@renderer/lib/omniboxFocus')
const { refreshViewport, viewportStore } = await import('@renderer/lib/formFactor')
const { omniboxPopupBound, omniboxPopupMaxHeight } =
  await import('@renderer/components/tablet/omniboxPopup')
const { tileLabel } = await import('@renderer/lib/newtab')

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
  recentHistory = []
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
    // Show has done its work; Paste (GN-10) stays, the field being where the text can go.
    const controls = Array.from(rows(el)[0].querySelectorAll('button'))
    expect(controls.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())).toEqual([
      'Paste'
    ])

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

  it('Paste (GN-10) puts the clip in the field as typed, reading it once; nothing goes anywhere', async () => {
    clip = { kind: 'text', text: 'grey cats' }
    suggestions = (q) =>
      q === '' ? [{ ...clipRow(), title: 'Text you copied', targetId: 'text' }] : []
    const el = await render(phone(tab(PAGE)))
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(1))
    })
    const [item] = rows(el)
    // The §6 fill arrow, labelled for what it does here; Show stands beside it.
    const paste = button(item, 'Paste')
    expect(paste.classList.contains('zen-omnibox-refine')).toBe(true)
    expect(option(item).contains(paste)).toBe(false)
    expect(button(item, 'Show')).toBeDefined()
    await tap(paste)
    await act(async () => {
      await vi.waitFor(() => expect(input(el).value).toBe('grey cats'))
    })
    expect(callsTo('clipboard.read')).toHaveLength(1)
    // Suggestions refresh for the pasted text; the clip is neither submitted nor used up.
    expect(
      callsTo('urlbar.suggest').some((a) => (a as { query: string }).query === 'grey cats')
    ).toBe(true)
    expect(commands()).not.toContain('urlbar.submit')
    expect(commands()).not.toContain('clipboard.markUsed')
  })

  it('Paste after a reveal reuses the revealed content', async () => {
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
    await tap(button(rows(el)[0], 'Paste'))
    await act(async () => {
      await vi.waitFor(() => expect(input(el).value).toBe('https://copied.example/page'))
    })
    expect(callsTo('clipboard.read')).toHaveLength(1)
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

/**
 * The chrome's layout, forced the way the preview host forces it (`?formFactor=`,
 * `forcedFormFactor`; `barInputSignal.test.tsx` does the same): the renderer re-derives its
 * layout from the window on a state tick, so the chrome URL carries it. `null` lets the window
 * decide again (happy-dom's: a desktop).
 */
function layout(formFactor: 'phone' | 'tablet' | 'desktop' | null): void {
  history.replaceState(null, '', formFactor ? `?formFactor=${formFactor}` : location.pathname)
  refreshViewport()
  expect(viewportStore.get().formFactor).toBe(formFactor ?? 'desktop')
}

/*
 * The draft after a dismissal: the phone and the tablet discard what was typed, as Chrome for
 * Android does on both (a program default of 19 Sep 2026 for the phone; W8-F17 for the tablet),
 * so the next open on the same page is at rest – the phone's search-ready field with the header
 * and the clipboard row, the tablet's field at the page's address, or empty over a new tab; the
 * desktop keeps Zen's per-tab draft. ONE predicate governs it (`urlbarKeepsTabDrafts`, the
 * desktop layout alone), the same that governs the draft across a tab switch (W8-F15). The layout
 * is the renderer's, not the host's: the phone's sheet is the phone layout's, and the tablet
 * mounts the bar bare as the desktop does (`TabletShell`), so each pin sets the layout the
 * preview host's way. The scrim press and the back gesture's `dismissed` share the one close
 * path, so the scrim stands in for both here; Escape over a new tab closes the bar by the same
 * path (`close-bar`, the draft's keep asked for), so it is the tablet's Escape pin.
 */
describe('the draft after a dismissal', () => {
  const clipRow = (): Suggestion => ({
    ...row('clipboard', 'Link you copied', '', null),
    id: 'clipboard'
  })
  /** The bar's backdrop: a press on it, outside the sheet or the panel, dismisses the bar. */
  const scrim = (el: HTMLElement): HTMLElement => el.firstElementChild as HTMLElement
  /**
   * A dismissal – the scrim's press, or Escape on the field (over a new tab: nothing to revert
   * to, the bar closes keeping its draft where the layout keeps one) – then the bar's next open.
   */
  async function dismiss(el: HTMLElement, how: 'scrim' | 'escape' = 'scrim'): Promise<void> {
    await act(async () => {
      if (how === 'escape') {
        input(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      } else scrim(el).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(commands()).toContain('urlbar.cancel')
    expect(commands()).not.toContain('urlbar.submit')
    // The bar is closed; the next render is the next open.
    await act(async () => root!.unmount())
    host!.remove()
    invoke.mockClear()
    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
  }
  /**
   * The bar mounted bare – no `phoneEdge` – as `ContentArea` and `TabletShell` mount it: the
   * layout alone tells the desktop's and the tablet's apart.
   */
  const bare = (t: Tab, mode: UrlbarState['mode'] = 'edit'): ReactElement =>
    createElement(Urlbar, {
      state: state(t),
      urlbar: urlbarState(mode),
      area: { x: 0, y: 0, width: 1200, height: 800 },
      phoneEdge: undefined
    })

  afterEach(() => layout(null))

  it('one predicate for both ways a draft outlives its bar: the desktop layout alone keeps one', () => {
    // The same `urlbarKeepsTabDrafts` gates the per-tab draft across a tab switch (W8-F15,
    // `urlbarTabDrafts.test.ts`) and the dismissal drafts below: Chrome Android drops the edit
    // on a tab switch and on Escape alike, on the phone and the tablet.
    expect(urlbarKeepsTabDrafts('desktop')).toBe(true)
    expect(urlbarKeepsTabDrafts('tablet')).toBe(false)
    expect(urlbarKeepsTabDrafts('phone')).toBe(false)
    layout('tablet')
    expect(urlbarKeepsTabDrafts()).toBe(false)
    layout('desktop')
    expect(urlbarKeepsTabDrafts()).toBe(true)
  })

  it('phone: dismissed with text typed, the pill reopens search-ready, with the header and the clipboard row', async () => {
    layout('phone')
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
    layout('desktop')
    let el = await render(bare(tab(PAGE)))
    await type(input(el), 'how to brew coffee')
    await dismiss(el)

    layout('phone')
    el = await render(phone(tab(PAGE)))
    expect(input(el).value).toBe('')
    expect(header(el)).not.toBeNull()
    // The phone's dismissal drops it for good.
    await dismiss(el)
    layout('desktop')
    el = await render(bare(tab(PAGE)))
    expect(input(el).value).toBe(PAGE)
  })

  it('desktop: the draft comes back, selected, on the next open over the same page', async () => {
    layout('desktop')
    let el = await render(bare(tab(PAGE)))
    await type(input(el), 'how to brew coffee')
    await dismiss(el)

    el = await render(bare(tab(PAGE)))
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
    el = await render(bare(tab(PAGE)))
    expect(input(el).value).toBe(PAGE)
  })

  it('TABLET: dismissed with text typed over a page, the bar reopens at the page’s address, selected – the text is gone, as Chrome Android drops it', async () => {
    layout('tablet')
    let el = await render(bare(tab(PAGE)))
    await type(input(el), 'how to brew coffee')
    await dismiss(el)

    el = await render(bare(tab(PAGE)))
    const field = input(el)
    expect(field.value).toBe(PAGE)
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, PAGE.length])
    // The tablet's bar is the desktop's composition: no phone header, the address in the field.
    expect(header(el)).toBeNull()
  })

  it('TABLET: Escape over a new tab closes the bar, and its next open is EMPTY; the desktop’s reopens with the text', async () => {
    // Over a new tab there is nothing to revert to: one Escape closes the bar (`close-bar`), the
    // draft's keep asked for – and the layout answers. The `'new'` key is every new tab page's.
    layout('tablet')
    let el = await render(bare(tab(NEW_TAB_URL), 'new-tab'))
    expect(input(el).value).toBe('')
    await type(input(el), 'how to brew coffee')
    await dismiss(el, 'escape')

    el = await render(bare(tab(NEW_TAB_URL), 'new-tab'))
    expect(input(el).value).toBe('')
    await dismiss(el, 'escape')

    // The desktop layout, the same keys: Chrome desktop keeps the edit, and so does Zen.
    layout('desktop')
    el = await render(bare(tab(NEW_TAB_URL), 'new-tab'))
    await type(input(el), 'how to brew coffee')
    await dismiss(el, 'escape')

    el = await render(bare(tab(NEW_TAB_URL), 'new-tab'))
    expect(input(el).value).toBe('how to brew coffee')
    // Left as the other pins expect it: the shared `'new'` draft cleared through the same path.
    await type(input(el), '')
    await dismiss(el, 'escape')
    el = await render(bare(tab(NEW_TAB_URL), 'new-tab'))
    expect(input(el).value).toBe('')
  })

  it('TABLET: a draft the desktop layout kept for the page is not read back either, and the tablet’s dismissal drops it', async () => {
    // The window's layout changes under the map (a laptop window narrowed to the tablet's
    // width with a touch screen; the preview host's `?formFactor=`): the tablet reads none.
    layout('desktop')
    let el = await render(bare(tab(PAGE)))
    await type(input(el), 'how to brew coffee')
    await dismiss(el)

    layout('tablet')
    el = await render(bare(tab(PAGE)))
    expect(input(el).value).toBe(PAGE)
    // Like the phone's, the tablet's dismissal drops it for good.
    await dismiss(el)
    layout('desktop')
    el = await render(bare(tab(PAGE)))
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

/*
 * The tab group row (OMN-15; Chrome for Android's `TabGroupSuggestionProcessor`): the one group
 * glyph in the favicon slot (§9.37), the group's name over its sites, Chrome's sentence to
 * assistive technology, and the pick as the Tab groups pane's Open (`folder.open`). One kind
 * on every chassis: the phone's sheet row, the tablet's popup row with "Open tab group" where
 * the tab row says "Switch to tab", the desktop's with its "Folder" noun.
 */
describe('the tab group row (OMN-15)', () => {
  const research: Folder = {
    id: 'folder_research',
    spaceId: 'space',
    name: 'Research',
    icon: '📁',
    collapsed: true,
    color: 'blue'
  }
  const groupRow = (extra: Partial<Suggestion> = {}): Suggestion => ({
    id: 'folder:folder_research',
    kind: 'folder',
    title: 'Research',
    subtitle: 'arxiv.org, scholar.google.com',
    url: null,
    favicon: null,
    targetId: 'folder_research',
    fill: 'res',
    ...extra
  })
  const tabRow = (): Suggestion => ({
    ...row('tab', 'Research notes', 'res', 'https://notes.example/research'),
    targetId: 't2'
  })
  /** The state with the group and, when `open`, a live member tab of it. */
  const withGroup = (t: Tab, folder: Folder = research, open = true): UIState =>
    ({
      ...state(t),
      tabs: open
        ? {
            [t.id]: t,
            member: tab('https://arxiv.org/abs/1', { id: 'member', folderId: folder.id })
          }
        : { [t.id]: t },
      folders: { [folder.id]: folder }
    }) as UIState
  const phoneWith = (s: UIState): ReactElement =>
    createElement(
      Fragment,
      null,
      createElement(Urlbar, {
        state: s,
        urlbar: urlbarState('edit'),
        area: null,
        phoneEdge: 'top'
      }),
      createElement(FrameDialogHost, { frame: true })
    )
  const bareWith = (s: UIState): ReactElement =>
    createElement(Urlbar, {
      state: s,
      urlbar: urlbarState('edit'),
      area: { x: 0, y: 0, width: 1200, height: 800 },
      phoneEdge: undefined
    })
  const glyph = (r: HTMLElement): HTMLElement | null =>
    r.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')
  const hint = (r: HTMLElement): string | null =>
    r.querySelector('.zen-omnibox-row-hint')?.textContent ?? null
  /** The list's rows less its headings (a sectioned card has one over the group). */
  const listRows = (el: HTMLElement): HTMLElement[] =>
    rows(el).filter((li) => li.hasAttribute('data-kind'))
  async function listed(el: HTMLElement, count: number): Promise<HTMLElement[]> {
    await act(async () => {
      await vi.waitFor(() => expect(listRows(el)).toHaveLength(count))
    })
    return listRows(el)
  }
  /** A mouse press on a desktop row: the desktop picks on the press. */
  async function press(el: HTMLElement): Promise<void> {
    await act(async () => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
      await Promise.resolve()
    })
  }

  afterEach(() => layout(null))

  it('phone: the sheet row wears the group glyph, its name over its sites, in Chrome’s section', async () => {
    layout('phone')
    suggestions = (q) =>
      q === 'res'
        ? [
            { ...tabRow(), group: 'Tabs and tab groups' },
            groupRow({ group: 'Tabs and tab groups' })
          ]
        : []
    const el = await render(phoneWith(withGroup(tab(PAGE))))
    await type(input(el), 'res')
    const [tabLi, groupLi] = await listed(el, 2)
    expect(tabLi.getAttribute('data-kind')).toBe('tab')
    expect(groupLi.getAttribute('data-kind')).toBe('folder')
    expect(groupLi.getAttribute('data-section')).toBe('Tabs and tab groups')
    // One heading over the two, Chrome's for a section holding both kinds.
    const headings = Array.from(el.querySelectorAll('[data-group]')).map((h) => h.textContent)
    expect(headings).toEqual(['Tabs and tab groups'])
    // The one group glyph (§9.37): the 10 dot in the group's colour, no kind icon beside it.
    const mark = glyph(groupLi)!
    expect(mark).not.toBeNull()
    expect(mark.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(mark.hasAttribute('data-saved')).toBe(false)
    expect(mark.style.getPropertyValue('--zen-group-rgb-light')).not.toBe('')
    expect(option(groupLi).querySelector('svg.lucide-folder')).toBeNull()
    expect(option(groupLi).querySelector('[data-testid="urlbar-row-title"]')?.textContent).toBe(
      'Research'
    )
    expect(option(groupLi).querySelector('[data-testid="urlbar-row-subtitle"]')?.textContent).toBe(
      'arxiv.org, scholar.google.com'
    )
    // The tab row's arrow, and no Refine control: the row is a place, not a query.
    expect(option(groupLi).querySelector('svg.lucide-arrow-right')).not.toBeNull()
    expect(groupLi.querySelector('.zen-omnibox-refine')).toBeNull()
    // Chrome's content description, in the touch hosts' noun.
    expect(option(groupLi).getAttribute('aria-label')).toBe(
      'Open Research tab group, colour Blue, with sites arxiv.org, scholar.google.com.'
    )
    expect(option(tabLi).hasAttribute('aria-label')).toBe(false)
  })

  it('phone: the tap opens the group (`folder.open`) and closes the bar, nothing submitted', async () => {
    layout('phone')
    suggestions = (q) => (q === 'res' ? [groupRow()] : [])
    const el = await render(phoneWith(withGroup(tab(PAGE))))
    await type(input(el), 'res')
    const [groupLi] = await listed(el, 1)
    invoke.mockClear()
    await tap(option(groupLi))
    expect(callsTo('folder.open')).toEqual([{ folderId: 'folder_research' }])
    expect(commands()).not.toContain('urlbar.submit')
    expect(commands()).not.toContain('tab.activate')
    expect(uiStore.get().urlbar.open).toBe(false)
  })

  it('phone: a saved group wears the ring; a group the chrome no longer has keeps the kind’s glyph', async () => {
    layout('phone')
    const saved: Folder = {
      ...research,
      savedTabs: [{ url: 'https://arxiv.org/abs/1', title: 'Paper' }]
    }
    suggestions = (q) => (q === 'res' ? [groupRow()] : [])
    let el = await render(phoneWith(withGroup(tab(PAGE), saved, false)))
    await type(input(el), 'res')
    let [groupLi] = await listed(el, 1)
    expect(glyph(groupLi)?.hasAttribute('data-saved')).toBe(true)
    act(() => root?.unmount())
    invoke.mockClear()

    // The row outlived its group (deleted between the keystroke and the answer).
    el = await render(phoneWith({ ...state(tab(PAGE)), folders: {} } as UIState))
    await type(input(el), 'res')
    ;[groupLi] = await listed(el, 1)
    expect(glyph(groupLi)).toBeNull()
    expect(option(groupLi).querySelector('svg.lucide-folder')).not.toBeNull()
    expect(option(groupLi).getAttribute('aria-label')).toBe(
      'Open Research tab group, colour Grey, with sites arxiv.org, scholar.google.com.'
    )
  })

  it('tablet: the popup row says "Open tab group" where the tab row says "Switch to tab"', async () => {
    layout('tablet')
    suggestions = (q) => (q === 'res' ? [tabRow(), groupRow()] : [])
    const el = await render(bareWith(withGroup(tab(PAGE))))
    await type(input(el), 'res')
    const [tabLi, groupLi] = await listed(el, 2)
    expect(tabLi.classList.contains('zen-omnibox-row')).toBe(true)
    expect(hint(tabLi)).toBe('Switch to tab')
    expect(groupLi.getAttribute('data-kind')).toBe('folder')
    expect(hint(groupLi)).toBe('Open tab group')
    expect(glyph(groupLi)?.closest('.zen-omnibox-row-icon')).not.toBeNull()
    expect(groupLi.querySelector('.zen-omnibox-row-title')?.textContent).toBe('Research')
    expect(groupLi.querySelector('.zen-omnibox-row-host')?.textContent).toBe(
      ' — arxiv.org, scholar.google.com'
    )
    expect(option(groupLi).getAttribute('aria-label')).toBe(
      'Open Research tab group, colour Blue, with sites arxiv.org, scholar.google.com.'
    )
    // No remove X: a group is not removable, as Chrome's match is not deletable.
    expect(groupLi.querySelector('[data-testid="urlbar-remove-suggestion"]')).toBeNull()
  })

  it('desktop: the same row in the desktop’s noun, picked on the press', async () => {
    layout('desktop')
    suggestions = (q) => (q === 'res' ? [groupRow()] : [])
    const el = await render(bareWith(withGroup(tab(PAGE))))
    await type(input(el), 'res')
    const [groupLi] = await listed(el, 1)
    expect(hint(groupLi)).toBe('Open folder')
    expect(option(groupLi).getAttribute('aria-label')).toBe(
      'Open Research folder, colour Blue, with sites arxiv.org, scholar.google.com.'
    )
    // The typed prefix is emphasised in the name, as in every row (omnibox-21).
    expect(groupLi.querySelector('.zen-omnibox-row-title mark')?.textContent).toBe('Res')
    invoke.mockClear()
    await press(groupLi)
    expect(callsTo('folder.open')).toEqual([{ folderId: 'folder_research' }])
    expect(commands()).not.toContain('urlbar.submit')
    expect(uiStore.get().urlbar.open).toBe(false)
  })
})

/*
 * The tablet popup above the keyboard (W6-L1): hung from the toolbar pill, the popup is bounded
 * by the VISIBLE viewport – the shell's box less the host's bottom inset (`--zen-inset-bottom`,
 * the keyboard while it is up) less §9.20's 8 px margin – so a long list ends above the keyboard
 * and scrolls inside, as Chrome's tablet dropdown is measured at most the window less the
 * keyboard. The bound is a CSS `max()`/`calc()` on the root variable (no render per keyboard
 * frame); the desktop's floating bar reads the box alone, as it did, and never passes an anchor.
 */
describe('the tablet popup above the keyboard (W6-L1)', () => {
  const twelve = (): Suggestion[] =>
    Array.from({ length: 12 }, (_, i) =>
      row('history', `Result ${i + 1}`, `res${i + 1}`, `https://example.com/r${i + 1}`)
    )
  /** The bar as `TabletShell` mounts it: the window as its box, the pill as its anchor. */
  const hung = (anchor: { x: number; y: number; width: number; height: number }): ReactElement =>
    createElement(Urlbar, {
      state: state(tab(PAGE)),
      urlbar: urlbarState('edit'),
      area: { x: 0, y: 0, width: 1280, height: 800 },
      anchor
    })
  const panel = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('.zen-omnibox')!

  afterEach(() => layout(null))

  it('the bound: the room under the pill less the margin, less the inset CSS resolves', () => {
    // pixel_tablet, 1280×800: the pill at y 36, 36 tall, the popup 4 under it → its top at 76.
    expect(omniboxPopupMaxHeight(800, 76)).toBe('max(120px, calc(716px - var(--zen-inset-bottom)))')
    // The keyboard up (E14 measured its inset at 426 px): 800 − 76 − 8 − 426.
    expect(omniboxPopupBound(800, 76, 426)).toBe(290)
    // The keyboard down, no bar inset: the box's own room, as before this change.
    expect(omniboxPopupBound(800, 76, 0)).toBe(716)
    // A short window with the keyboard up: the floor, the field's row and one suggestion.
    expect(omniboxPopupBound(600, 76, 426)).toBe(120)
  })

  it('tablet: twelve rows, the popup’s max height is the visible viewport’s bound', async () => {
    layout('tablet')
    suggestions = (q) => (q === 'res' ? twelve() : [])
    const el = await render(hung({ x: 300, y: 36, width: 680, height: 36 }))
    await type(input(el), 'res')
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(12))
    })
    const box = panel(el)
    expect(box.getAttribute('data-attached')).toBe('true')
    // Its top anchor under the pill and the pill's width are as they were (TB-21).
    expect(box.style.left).toBe('300px')
    expect(box.style.top).toBe('76px')
    expect(box.style.width).toBe('680px')
    expect(box.style.maxHeight).toBe('max(120px, calc(716px - var(--zen-inset-bottom)))')
    // The list is the panel's scrolling part: the field's row is fixed, the list gives way.
    const list = box.querySelector<HTMLElement>('ul[role="listbox"]')!
    expect(list.classList.contains('overflow-y-auto')).toBe(true)
    expect(list.classList.contains('min-h-0')).toBe(true)
    expect(list.previousElementSibling?.classList.contains('shrink-0')).toBe(true)
    expect(rows(el)[11].textContent).toContain('Result 12')
  })

  it('desktop: the floating bar’s bound reads the box alone, no inset in it', async () => {
    layout('desktop')
    suggestions = (q) => (q === 'res' ? twelve() : [])
    const el = await render(
      createElement(Urlbar, {
        state: state(tab(PAGE)),
        urlbar: urlbarState('edit'),
        area: { x: 0, y: 0, width: 1200, height: 800 }
      })
    )
    await type(input(el), 'res')
    await act(async () => {
      await vi.waitFor(() => expect(rows(el)).toHaveLength(12))
    })
    const box = panel(el)
    expect(box.style.maxHeight).toMatch(/^\d+px$/)
    expect(box.style.maxHeight).not.toContain('var(')
  })
})

/*
 * Zero-suggest on the touch layouts (OMN-04; Chrome for Android's on-focus list over a web
 * page): the core's `Most visited` rows come up as one row of tiles at the list's head, apart
 * from the options; a remembered search wears the clock and its removal takes the search's
 * visits out of the history too; the tablet's bar asks for the zero-suggest list on focus while
 * its field still holds the address, untyped, and for the address's rows no more. The desktop
 * bar is as it was: the address's rows on focus, the magnifier on its remembered searches.
 */
describe('zero-suggest on the touch layouts (OMN-04)', () => {
  const GITHUB = 'https://github.com/'
  const CATS = 'https://www.google.com/search?q=cats'
  const tile = (title: string, url: string): Suggestion => ({
    ...row('url', title, url.replace(/^https:\/\//, ''), url),
    id: `tile:${url}`,
    group: 'Most visited'
  })
  /** An inline icon: `faviconSrc` hands it to the `<img>` as it is (no site is asked). */
  const WIKI_ICON = 'data:image/png;base64,iVBORw0KGgo='
  const tiles = (): Suggestion[] => [
    tile('Example Domain', 'https://example.com/'),
    {
      ...tile('Wikipedia, the free encyclopedia', 'https://en.wikipedia.org/'),
      favicon: WIKI_ICON
    },
    tile('GitHub: Let’s build from here', GITHUB)
  ]
  /** A tile's icon `<img>`, its box and its fade-in mark (the page's `TileIcon`). */
  const iconOf = (button: HTMLButtonElement): HTMLImageElement =>
    button.querySelector<HTMLImageElement>('img.zen-ntp-icon')!
  const recentSearch = (terms: string, url: string): Suggestion => ({
    ...row('search', terms, terms, url),
    id: `recent:${url}`,
    subtitle: 'Search with Google',
    deletable: true,
    group: 'Recent searches'
  })
  const zero = (grouped: boolean): Suggestion[] => [
    ...tiles(),
    recentSearch('cats', CATS),
    recentSearch('two words', 'https://duckduckgo.com/?q=two%20words'),
    {
      ...row('history', 'Some page', 'a.example/page', 'https://a.example/page'),
      id: 'hist:https://a.example/page',
      deletable: true,
      ...(grouped ? { group: 'Recently visited' } : {})
    }
  ]
  /** The touch layouts' answers: the zero-suggest list for nothing, a query's rows for 'c'. */
  const touchAnswers =
    (grouped: boolean) =>
    (q: string): Suggestion[] =>
      q === '' ? zero(grouped) : q === 'c' ? [row('search', 'c', 'c', null)] : []
  const carousel = (el: HTMLElement): HTMLElement | null =>
    el.querySelector<HTMLElement>('[data-testid="urlbar-most-visited"]')
  const tileButtons = (el: HTMLElement): HTMLButtonElement[] =>
    Array.from(carousel(el)?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  const options = (el: HTMLElement): HTMLElement[] =>
    Array.from(el.querySelectorAll<HTMLElement>('[role="option"]'))
  /** An option's title: the desktop row's title span; the sheet row's first span. */
  const titleOf = (o: HTMLElement): string =>
    (o.querySelector('.zen-omnibox-row-title') ?? o.querySelector('span'))!.textContent!.trim()
  const optionTitled = (el: HTMLElement, title: string): HTMLElement =>
    options(el).find((o) => titleOf(o) === title)!
  const headingTexts = (el: HTMLElement): string[] =>
    Array.from(el.querySelectorAll('[data-testid="urlbar-group-heading"]')).map(
      (h) => h.textContent!
    )
  const submits = (): Array<Record<string, unknown>> =>
    callsTo('urlbar.submit') as Array<Record<string, unknown>>
  /** The tablet's bar as `TabletShell` mounts it: the window as its box, the pill as its anchor. */
  const tablet = (t: Tab = tab(PAGE)): ReactElement =>
    createElement(Urlbar, {
      state: state(t),
      urlbar: urlbarState('edit'),
      area: { x: 0, y: 0, width: 1280, height: 800 },
      anchor: { x: 300, y: 36, width: 680, height: 36 }
    })
  const desktop = (): ReactElement =>
    createElement(Urlbar, {
      state: state(tab(PAGE)),
      urlbar: urlbarState('edit'),
      area: { x: 0, y: 0, width: 1200, height: 800 }
    })
  async function listed(el: HTMLElement): Promise<void> {
    await act(async () => {
      await vi.waitFor(() => expect(carousel(el)).not.toBeNull())
    })
  }

  afterEach(() => layout(null))

  it('phone: the most visited sites are one row of tiles at the list’s head, apart from the options; no heading of their own', async () => {
    layout('phone')
    suggestions = touchAnswers(true)
    const el = await render(phone(tab(PAGE)))
    await listed(el)
    expect(callsTo('urlbar.suggest')[0]).toMatchObject({ query: '', grouped: true })
    const list = el.querySelector<HTMLElement>('ul[role="listbox"]')!
    // First in the list, before the searches; a presentational item holding a named group of
    // buttons, so the options a screen reader counts are the rows alone.
    expect(list.firstElementChild).toBe(carousel(el))
    expect(carousel(el)!.getAttribute('role')).toBe('presentation')
    const group = carousel(el)!.querySelector<HTMLElement>('[role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('Most visited')
    expect(group.classList.contains('zen-omnibox-tiles')).toBe(true)
    expect(group.classList.contains('zen-omnibox-tiles-sheet')).toBe(true)
    // The host's own new tab page tile (the Lead's fold on #725): the phone page's 56 square
    // with the 24 icon or letter (§9.29), the shared look, its caption the page's label 8 under.
    const buttons = tileButtons(el)
    expect(buttons).toHaveLength(3)
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(
      tiles().map((t) => tileLabel(t.title, t.url!))
    )
    expect(buttons[2].getAttribute('aria-label')).toBe('GitHub')
    expect(buttons[2].querySelector('.zen-ntp-tile')).not.toBeNull()
    expect(buttons[2].querySelector('.zen-ntp-caption')!.textContent).toBe('GitHub')
    expect(buttons[2].className).toContain('gap-2')
    expect(buttons[2].querySelector('.zen-ntp-tile')!.className).toContain('h-14 w-14')
    expect(buttons[2].querySelector('.zen-ntp-letter')!.className).toContain('h-6 w-6')
    // The icon is the page's `TileIcon`: 24 square, and marked loaded once it is – the phone's
    // fade-in rule (`zen-ntp-icon` is transparent until `zen-ntp-icon-loaded`), which the
    // omnibox's own copy never met.
    const icon = iconOf(buttons[1])
    expect([
      icon.getAttribute('src'),
      icon.getAttribute('width'),
      icon.getAttribute('height')
    ]).toEqual([WIKI_ICON, '24', '24'])
    expect(icon.className).toContain('h-6 w-6')
    await act(async () => {
      await vi.waitFor(() => expect(iconOf(buttons[1]).className).toContain('zen-ntp-icon-loaded'))
    })
    expect(options(el)).toHaveLength(3)
    expect(headingTexts(el)).toEqual(['Recent searches', 'Recently visited'])
    expect(el.querySelector('[data-group="Most visited"]')).toBeNull()
  })

  it('phone: a tap on a tile opens its site as a row’s pick would, and a remembered search re-runs the search', async () => {
    layout('phone')
    suggestions = touchAnswers(true)
    const el = await render(phone(tab(PAGE)))
    await listed(el)
    await tap(tileButtons(el)[2])
    expect(submits()).toHaveLength(1)
    expect(submits()[0]).toMatchObject({ input: GITHUB, tabId: 't1', newTab: false })
    // Nothing was typed: nothing is learned for the shortcuts provider.
    expect(submits()[0]).not.toHaveProperty('learn')
    uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
    await tap(optionTitled(el, 'cats'))
    expect(submits()).toHaveLength(2)
    expect(submits()[1]).toMatchObject({ input: CATS, tabId: 't1' })
  })

  it('phone: a remembered search wears the clock; a query’s row the magnifier', async () => {
    layout('phone')
    suggestions = touchAnswers(true)
    const el = await render(phone(tab(PAGE)))
    await listed(el)
    expect(optionTitled(el, 'cats').querySelector('svg.lucide-clock')).not.toBeNull()
    expect(optionTitled(el, 'cats').querySelector('svg.lucide-search')).toBeNull()
    expect(optionTitled(el, 'Some page').querySelector('svg.lucide-clock')).not.toBeNull()
    await type(input(el), 'c')
    await act(async () => {
      await vi.waitFor(() => expect(optionTitled(el, 'c')).toBeDefined())
    })
    expect(optionTitled(el, 'c').querySelector('svg.lucide-search')).not.toBeNull()
    expect(optionTitled(el, 'c').querySelector('svg.lucide-clock')).toBeNull()
  })

  it('phone: the tiles go the moment a key is typed; nothing of them while typing', async () => {
    layout('phone')
    suggestions = touchAnswers(true)
    const el = await render(phone(tab(PAGE)))
    await listed(el)
    await type(input(el), 'c')
    await act(async () => {
      await vi.waitFor(() => expect(options(el).map((o) => o.textContent)).toContain('c'))
    })
    expect(carousel(el)).toBeNull()
    expect(callsTo('urlbar.suggest').at(-1)).toMatchObject({ query: 'c' })
  })

  it('phone, bottom dock: the tiles stay first in the DOM, nearest the field on the reversed list', async () => {
    layout('phone')
    suggestions = touchAnswers(true)
    const el = await render(
      createElement(Urlbar, {
        state: state(tab(PAGE)),
        urlbar: urlbarState('edit'),
        area: null,
        phoneEdge: 'bottom'
      })
    )
    await listed(el)
    const list = el.querySelector<HTMLElement>('ul[role="listbox"]')!
    expect(list.getAttribute('data-edge')).toBe('bottom')
    expect(list.firstElementChild).toBe(carousel(el))
  })

  it('phone: tiles alone still put the list up, not the empty hint', async () => {
    layout('phone')
    suggestions = (q) => (q === '' ? tiles() : [])
    const el = await render(phone(tab(PAGE)))
    await listed(el)
    expect(el.querySelector('ul[role="listbox"]')).not.toBeNull()
    expect(options(el)).toHaveLength(0)
    // The hint is the input's placeholder alone, not the empty sheet's centred sentence.
    expect(el.querySelector('.zen-omnibox-sheet div.text-center')).toBeNull()
  })

  it('tablet: on focus over a page the field holds the address, selected, and the rows are the zero-suggest list – the tiles first – until a key is typed', async () => {
    layout('tablet')
    suggestions = touchAnswers(false)
    const el = await render(tablet())
    await listed(el)
    // The on-focus request is the zero-prefix one (Chrome's `kInteractionFocus`), flat.
    expect(callsTo('urlbar.suggest')[0]).toEqual({ query: '', tabId: 't1' })
    expect(input(el).value).toBe(PAGE)
    expect(input(el).selectionStart).toBe(0)
    expect(input(el).selectionEnd).toBe(PAGE.length)
    const list = el.querySelector<HTMLElement>('#zen-omnibox-results')!
    expect(list.firstElementChild).toBe(carousel(el))
    expect(carousel(el)!.querySelector('.zen-omnibox-tiles-sheet')).toBeNull()
    expect(tileButtons(el)).toHaveLength(3)
    // The host's own tile at the tablet's size: the served page's 64 square with the 32 icon.
    expect(tileButtons(el)[2].querySelector('.zen-ntp-tile')!.className).toContain('h-16 w-16')
    expect(tileButtons(el)[2].querySelector('.zen-ntp-letter')!.className).toContain('h-8 w-8')
    const icon = iconOf(tileButtons(el)[1])
    expect([icon.getAttribute('width'), icon.getAttribute('height')]).toEqual(['32', '32'])
    expect(icon.className).toContain('h-8 w-8')
    expect(input(el).getAttribute('aria-expanded')).toBe('true')
    // The popup's rows: the remembered searches under their heading, then the recent page.
    expect(headingTexts(el)).toEqual(['Recent searches'])
    expect(options(el)).toHaveLength(3)
    expect(optionTitled(el, 'cats').querySelector('svg.lucide-clock')).not.toBeNull()
    // A key typed: the query's rows, the tiles gone, the typed branch as it was.
    await type(input(el), 'c')
    await act(async () => {
      await vi.waitFor(() => expect(carousel(el)).toBeNull())
    })
    expect(callsTo('urlbar.suggest').at(-1)).toEqual({ query: 'c', tabId: 't1' })
    expect(options(el).map(titleOf)).toEqual(['c'])
  })

  it('tablet: a press on a tile opens its site, learning nothing for the address in the field', async () => {
    layout('tablet')
    suggestions = touchAnswers(false)
    const el = await render(tablet())
    await listed(el)
    await act(async () => {
      tileButtons(el)[0].dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })
      )
      await Promise.resolve()
    })
    expect(submits()).toHaveLength(1)
    expect(submits()[0]).toMatchObject({ input: 'https://example.com/', tabId: 't1' })
    expect(submits()[0]).not.toHaveProperty('learn')
  })

  it('tablet: removing a remembered search forgets it and deletes the search’s visits on every engine, so it does not come back', async () => {
    layout('tablet')
    suggestions = touchAnswers(false)
    recentHistory = [
      { url: CATS, title: 'cats - Google Search', lastVisit: 4 },
      { url: 'https://duckduckgo.com/?q=cats', title: 'cats at DuckDuckGo', lastVisit: 3 },
      { url: 'https://www.google.com/search?q=dogs', title: 'dogs - Google Search', lastVisit: 2 },
      { url: 'https://a.example/page', title: 'Some page', lastVisit: 1 }
    ]
    const el = await render(tablet())
    await listed(el)
    const cats = optionTitled(el, 'cats').closest('li')!
    const remove = cats.querySelector<HTMLButtonElement>(
      '[data-testid="urlbar-remove-suggestion"]'
    )!
    await act(async () => {
      remove.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(callsTo('urlbar.forgetShortcut')).toEqual([{ url: CATS }])
    expect(callsTo('history.recent')).toEqual([{ limit: 1000 }])
    await act(async () => {
      await vi.waitFor(() => expect(callsTo('history.deleteUrls')).toHaveLength(1))
    })
    expect(callsTo('history.deleteUrls')).toEqual([
      { urls: [CATS, 'https://duckduckgo.com/?q=cats'] }
    ])
    // The row is gone from the list at once, the tiles and the other rows as they were.
    expect(options(el).map(titleOf)).toEqual(['two words', 'Some page'])
    expect(tileButtons(el)).toHaveLength(3)
  })

  it('desktop: as it was – the address’s rows on focus, the magnifier on a remembered search, no tiles', async () => {
    layout(null)
    suggestions = (q) =>
      q === PAGE
        ? [row('history', 'Example Domain', 'example.com/some/path', PAGE)]
        : q === ''
          ? zero(false).filter((r) => r.group !== 'Most visited')
          : []
    const el = await render(desktop())
    expect(callsTo('urlbar.suggest')[0]).toEqual({ query: PAGE, tabId: 't1' })
    await act(async () => {
      await vi.waitFor(() => expect(options(el)).toHaveLength(1))
    })
    expect(carousel(el)).toBeNull()
    await type(input(el), '')
    await act(async () => {
      await vi.waitFor(() => expect(options(el)).toHaveLength(3))
    })
    expect(carousel(el)).toBeNull()
    expect(optionTitled(el, 'cats').querySelector('svg.lucide-search')).not.toBeNull()
    expect(optionTitled(el, 'cats').querySelector('svg.lucide-clock')).toBeNull()
    // A desktop removal forgets the shortcut alone: the history is not searched for the visits.
    const cats = optionTitled(el, 'cats').closest('li')!
    await act(async () => {
      cats.querySelector<HTMLButtonElement>('[data-testid="urlbar-remove-suggestion"]')!.click()
      await Promise.resolve()
    })
    expect(callsTo('urlbar.forgetShortcut')).toEqual([{ url: CATS }])
    expect(callsTo('history.recent')).toEqual([])
    expect(callsTo('history.deleteUrls')).toEqual([])
  })
})
