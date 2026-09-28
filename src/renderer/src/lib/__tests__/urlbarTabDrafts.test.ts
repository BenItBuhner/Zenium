import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { UIState } from '@shared/types'
import { NEW_TAB_URL } from '@shared/url'
import { cmd, run } from '../api'
import {
  browserStore,
  closeUrlbar,
  openNewTabPageUrlbar,
  openUrlbar,
  provideUrlbarField,
  uiStore,
  type UrlbarFieldState,
  type UrlbarTabDraft
} from '../ui'

/*
 * W8-F15, the draft's half – Chrome's per-tab omnibox state (`OmniboxViewViews::SaveStateToTab`
 * on the leave, `OnTabChanged` → `OmniboxEditModel::RestoreState` on the return). The New Tab
 * palette bound to a tab follows the window's active tab (W5-F4): the moment another tab is in
 * front it closes or re-binds. Keeping the tab but dropping its text on that event was half the
 * fix: what the leaving tab's field held is now saved by tab id (`UiState.urlbarDrafts`), and the
 * bar re-opens with it – text, selection, keyword chip, its stance – when the tab is active again.
 * The field is what the mounted desktop bar lends through `provideUrlbarField`; here a fake one.
 */

const PAGE = 'https://gamma.test/'

/**
 * A desktop window on one space with the tabs given, `active` in front: the boot's New Tab `a`
 * with its palette bound to it, and the page `b` something else makes active under the palette
 * (the handed-over URL of W8-F15's first half, opened in the foreground; an extension's
 * `chrome.tabs.create({ active: true })`; Ctrl+Tab).
 */
const window = (
  active: string | null,
  opts: { tabs?: Record<string, string>; palette?: boolean } = {}
): UIState => {
  const urls = opts.tabs ?? { a: NEW_TAB_URL, b: PAGE }
  const tabs = Object.fromEntries(
    Object.entries(urls).map(([id, url]) => [
      id,
      { id, url, title: id, spaceId: 's1', containerId: 'default' }
    ])
  )
  return {
    platform: 'electron',
    capabilities: { newTabPage: true, pageTabs: true },
    tabs,
    spaces: [{ id: 's1', name: 'Space', activeTabId: active, tabIds: Object.keys(tabs) }],
    activeSpaceId: 's1',
    settings: { onboardingDone: true, newTab: { enabled: opts.palette ?? true } },
    window: { kind: 'synced', chrome: 'full' }
  } as unknown as UIState
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The desktop bar's field as its mounted instance lends it: what the test has typed into it. */
let field: UrlbarFieldState | null = null
const typed = (text: string, patch: Partial<UrlbarFieldState> = {}): void => {
  field = {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
    selectionDirection: 'none',
    keyword: null,
    ...patch
  }
}
let releaseField: () => void = () => undefined

/** The boot's palette: the bar in new-tab mode bound to `a`, the window showing `a`. */
async function bootPalette(attached = false): Promise<void> {
  browserStore.set({ state: window('a') })
  openNewTabPageUrlbar('a', undefined, attached)
  await settled()
  expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: 'a' })
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
}

const drafts = (): Record<string, UrlbarTabDraft> => uiStore.get().urlbarDrafts

beforeEach(() => {
  field = null
  releaseField = provideUrlbarField(() => field)
})

afterEach(() => {
  releaseField()
  uiStore.set({
    urlbar: { open: false, mode: 'new-tab', tabId: null, initialText: undefined, attached: false },
    urlbarDrafts: {},
    snapshot: null,
    snapshotTabId: null
  })
  browserStore.set({ state: null })
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

describe("the New Tab palette's draft goes with its tab (W8-F15)", () => {
  it('saves the leaving tab’s field, closes, and re-opens with it on the tab’s return', async () => {
    await bootPalette(true)
    // `@ddg` then "hello world", "world" selected from its end: the chip, the terms, the range.
    typed('hello world', {
      selectionStart: 6,
      selectionEnd: 11,
      selectionDirection: 'backward',
      keyword: { engineId: 'duckduckgo', typed: '@ddg' }
    })
    // The handed-over URL opened in the foreground: `b` in front, the palette still bound to
    // `a`. The bar goes (W5-F4) – and the field goes with `a`, not with the bar.
    browserStore.set({ state: window('b') })
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    const draft: UrlbarTabDraft = {
      text: 'hello world',
      selectionStart: 6,
      selectionEnd: 11,
      selectionDirection: 'backward',
      keyword: { engineId: 'duckduckgo', typed: '@ddg' },
      attached: true
    }
    expect(drafts()).toEqual({ a: draft })
    // Any later state with `b` still in front brings nothing back.
    browserStore.set({ state: window('b') })
    expect(uiStore.get().urlbar.open).toBe(false)
    // `a` active again (its row, Ctrl+Tab back): the palette re-opens over it through the
    // page's own open path – the capture first – the draft in the field, the store's copy spent.
    browserStore.set({ state: window('a') })
    await settled()
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'a' })
    expect(uiStore.get().urlbar).toMatchObject({
      open: true,
      mode: 'new-tab',
      tabId: 'a',
      initialText: 'hello world',
      typed: true,
      attached: true
    })
    expect(uiStore.get().urlbar.draft).toEqual(draft)
    expect(drafts()).toEqual({})
  })

  it('a tab left with nothing typed – the field empty or blank – restores nothing', async () => {
    await bootPalette()
    typed('   ')
    browserStore.set({ state: window('b') })
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(drafts()).toEqual({})
    vi.mocked(cmd).mockClear()
    browserStore.set({ state: window('a') })
    await settled()
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(cmd).not.toHaveBeenCalledWith('overlay.snapshot', expect.anything())
  })

  it('a draft dismissed before the leave (Escape) restores nothing: only a leave writes one', async () => {
    await bootPalette()
    typed('hello')
    // Escape: the bar's own close, under its own draft rule (`Urlbar.tsx`, `drafts`).
    closeUrlbar({ reason: 'dismiss' })
    browserStore.set({ state: window('b') })
    browserStore.set({ state: window('a') })
    await settled()
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(drafts()).toEqual({})
  })

  it('a draft committed before the leave (the tab navigated on the submit) restores nothing', async () => {
    await bootPalette()
    typed('gamma')
    // The submit: the bar closes and `a` loads the result – a page now, not an empty tab.
    closeUrlbar()
    const tabs = { a: 'https://gamma.test/?q=gamma', b: PAGE }
    browserStore.set({ state: window('a', { tabs }) })
    browserStore.set({ state: window('b', { tabs }) })
    browserStore.set({ state: window('a', { tabs }) })
    await settled()
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(drafts()).toEqual({})
  })

  it('the palette still up over a tab a page has taken saves nothing for it', async () => {
    await bootPalette()
    typed('gamma')
    // The navigation lands before the bar's close does: `a` is a page, still in front, the
    // palette still bound to it (it follows the active tab, which has not changed).
    const tabs = { a: 'https://gamma.test/?q=gamma', b: PAGE }
    browserStore.set({ state: window('a', { tabs }) })
    expect(uiStore.get().urlbar.open).toBe(true)
    browserStore.set({ state: window('b', { tabs }) })
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(drafts()).toEqual({})
  })

  it('the tab closed while away takes its draft with it', async () => {
    await bootPalette()
    typed('hello')
    browserStore.set({ state: window('b') })
    expect(drafts()).toEqual({ a: expect.objectContaining({ text: 'hello' }) })
    // `a` closed from its row while `b` is in front.
    browserStore.set({ state: window('b', { tabs: { b: PAGE } }) })
    expect(drafts()).toEqual({})
  })

  it('a tab navigated while away loses its draft: it was for a page that is gone', async () => {
    await bootPalette()
    typed('hello')
    browserStore.set({ state: window('b') })
    // An extension's `tabs.update({ url })` on the background `a`.
    const tabs = { a: 'https://alpha.test/', b: PAGE }
    browserStore.set({ state: window('b', { tabs }) })
    expect(drafts()).toEqual({})
    browserStore.set({ state: window('a', { tabs }) })
    await settled()
    expect(uiStore.get().urlbar.open).toBe(false)
  })

  it('two tabs with two drafts keep their own: the palette re-binding between two New Tabs', async () => {
    await bootPalette()
    const tabs = { a: NEW_TAB_URL, n: NEW_TAB_URL }
    typed('alpha')
    // Ctrl+T over the palette: `n` in front, the palette re-binds to it (W5-F4) – fresh, with
    // no draft of its own to bring.
    browserStore.set({ state: window('n', { tabs }) })
    await settled()
    expect(uiStore.get().urlbar).toMatchObject({ open: true, tabId: 'n', typed: false })
    expect(uiStore.get().urlbar.initialText).toBeUndefined()
    expect(uiStore.get().urlbar.draft).toBeUndefined()
    expect(drafts()).toEqual({ a: expect.objectContaining({ text: 'alpha' }) })
    typed('november')
    // Back to `a`: `n`'s field saved, `a`'s comes back – each its own.
    browserStore.set({ state: window('a', { tabs }) })
    await settled()
    expect(uiStore.get().urlbar).toMatchObject({
      open: true,
      tabId: 'a',
      initialText: 'alpha',
      typed: true
    })
    expect(drafts()).toEqual({ n: expect.objectContaining({ text: 'november' }) })
    typed('alpha centauri')
    browserStore.set({ state: window('n', { tabs }) })
    await settled()
    expect(uiStore.get().urlbar).toMatchObject({ open: true, tabId: 'n', initialText: 'november' })
    expect(drafts()).toEqual({ a: expect.objectContaining({ text: 'alpha centauri' }) })
  })

  it('keys the page’s field took while the restore was on its way are typed into the draft', async () => {
    await bootPalette()
    typed('hello world', { selectionStart: 6, selectionEnd: 11 })
    browserStore.set({ state: window('b') })
    browserStore.set({ state: window('a') })
    // The page's `newtab.opened` with a key, in before the capture is: it replaces the
    // selection, the caret after it – as a key typed into the field as it will stand.
    openNewTabPageUrlbar('a', 'x', false)
    await settled()
    expect(uiStore.get().urlbar).toMatchObject({ open: true, tabId: 'a', initialText: 'hello x' })
    expect(uiStore.get().urlbar.draft).toMatchObject({
      text: 'hello x',
      selectionStart: 7,
      selectionEnd: 7,
      selectionDirection: 'none'
    })
    expect(drafts()).toEqual({})
  })

  it('the return is the tab’s arrival: a draft whose tab comes in front under another bar waits', async () => {
    await bootPalette()
    typed('hello')
    browserStore.set({ state: window('b') })
    // Ctrl+L over `b`: the edit bar, bound to `b`, which does not follow the active tab (W5-F4
    // scoped the follow to the palette).
    await openUrlbar('edit', 'b', { attached: false })
    // `a` in front under it: the edit bar stays; `a`'s draft waits.
    browserStore.set({ state: window('a') })
    await settled()
    expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'edit', tabId: 'b' })
    expect(drafts()).toEqual({ a: expect.objectContaining({ text: 'hello' }) })
    // The edit bar put away with `a` still in front: no palette pops up on that Escape.
    closeUrlbar({ reason: 'dismiss' })
    browserStore.set({ state: window('a') })
    await settled()
    expect(uiStore.get().urlbar.open).toBe(false)
    // `a` left and made active again: now it arrives, and the draft comes back.
    browserStore.set({ state: window('b') })
    browserStore.set({ state: window('a') })
    await settled()
    expect(uiStore.get().urlbar).toMatchObject({
      open: true,
      mode: 'new-tab',
      tabId: 'a',
      initialText: 'hello'
    })
  })

  it('the window’s own bar, bound to no tab, saves nothing: it is not a tab’s', async () => {
    browserStore.set({ state: window('a') })
    // Ctrl+T with the new tab page off (`urlbar.toggle` in new-tab mode): `tabId` null.
    await openUrlbar('new-tab', 'a', { attached: false })
    typed('hello')
    browserStore.set({ state: window('b') })
    expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: null })
    expect(drafts()).toEqual({})
    closeUrlbar()
  })

  it('with no bar lent (the phone’s sheet) a leave saves nothing', async () => {
    releaseField()
    await bootPalette()
    typed('hello')
    browserStore.set({ state: window('b') })
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(drafts()).toEqual({})
  })
})
