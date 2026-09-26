// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Fragment, act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Suggestion, Tab, UIState } from '@shared/types'
import type { UrlbarState } from '@renderer/lib/ui'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { NEW_TAB_URL } from '@shared/url'

/*
 * The phone omnibox's engine glyph as a control (OMN-38): the 44 × 44 button named for the
 * engine at the field's start, the §9.13 picker its tap opens on the frame's dialog host, the
 * pick that takes an engine for THIS query alone (the glyph, the placeholder, the rows and the
 * submit follow; the default is untouched), the footer's Set as default that runs the Settings
 * row's command and nothing else (the EEA choice record stays services'), and the field before
 * the tap as it was. Rendered for real; the host is a recording stub.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'urlbar.suggest') return [] as Suggestion[]
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Urlbar } = await import('../Urlbar')
const { uiStore } = await import('@renderer/lib/ui')
const { FrameDialogHost } = await import('@renderer/lib/portals')

function tab(url: string): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'New tab',
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
    blockedCount: 0
  } as Tab
}

function state(t: Tab, searchEngineId = 'google'): UIState {
  return {
    platform: 'android',
    capabilities: {},
    tabs: { [t.id]: t },
    spaces: [],
    activeSpaceId: 'space',
    settings: { ...DEFAULT_SETTINGS, searchEngineId },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

const urlbarState = (mode: UrlbarState['mode']): UrlbarState => ({
  open: true,
  mode,
  tabId: 't1',
  initialText: undefined,
  attached: true
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
  await act(async () => {
    await vi.waitFor(() => expect(commands()).toContain('urlbar.suggest'))
  })
  return host
}

/** The phone omnibox over the new tab page, the frame's dialog host after it (the shell's order). */
function phone(searchEngineId = 'google'): ReactElement {
  return createElement(
    Fragment,
    null,
    createElement(Urlbar, {
      state: state(tab(NEW_TAB_URL), searchEngineId),
      urlbar: urlbarState('new-tab'),
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
const field = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('.zen-omnibox-field')!
const control = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('.zen-omnibox-field [data-testid="urlbar-engine"]')!
const omnibox = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>('.zen-omnibox-sheet')!
/** The picker, on the frame's dialog host. */
const picker = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')
const radios = (): HTMLButtonElement[] =>
  Array.from(picker()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])
const radio = (label: string): HTMLButtonElement | undefined =>
  radios().find((r) => r.querySelector('.zen-settings-label')?.textContent === label)
const setDefault = (): HTMLButtonElement | null =>
  picker()?.querySelector<HTMLButtonElement>(
    '.zen-sheet-footer [data-testid="urlbar-engine-set-default"]'
  ) ?? null

/** A tap: the pointer goes down (a touch), then the click. */
async function tap(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' })
    )
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeValue.call(el, value)
    el.setSelectionRange(value.length, value.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function pressEnter(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    await Promise.resolve()
  })
}

/** Wait for the chassis's spring – the picker's rise or leave – to bring things to `until`. */
async function settle(until: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!until()) {
    if (Date.now() - start > 4000) throw new Error(`${what} did not settle`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
  }
}

/** The tap on the control, and the picker up. */
async function open(el: HTMLElement): Promise<HTMLElement> {
  await tap(control(el))
  await settle(() => picker() !== null, 'the picker')
  return picker()!
}

/** A row or the footer pressed: the sheet's leave run out, its action run once it has gone. */
async function press(button: HTMLButtonElement | undefined | null): Promise<void> {
  expect(button).toBeTruthy()
  await act(async () => {
    button!.click()
    await Promise.resolve()
  })
  await settle(() => picker() === null, 'the picker’s leave')
}

// The chassis needs room to stand: happy-dom lays nothing out, and a sheet whose layer and
// content measure 0 lands closed the moment it has risen (the OMN-17 tests' sizes).
let sizes: Array<[string, PropertyDescriptor | undefined]> = []
beforeEach(() => {
  invoke.mockClear()
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
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
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe('the engine glyph as a control (OMN-38)', () => {
  it('is a 44 × 44 button named for the engine at the field’s start, a dialog’s anchor; the mark inside and the field are as they were before the tap', async () => {
    const el = await render(phone())
    const c = control(el)
    expect(c.tagName).toBe('BUTTON')
    expect(c.getAttribute('aria-label')).toBe('Search engine: Google')
    expect(c.className).toContain('h-11 w-11')
    expect(c.className).toContain('rounded-full')
    expect(c.className).toContain('zen-toolbar-button')
    expect(c.getAttribute('aria-haspopup')).toBe('dialog')
    expect(c.getAttribute('aria-expanded')).toBe('false')
    // The first thing in the field, before the input: the pill's leading end cap.
    expect(field(el).firstElementChild).toBe(c)
    expect(c.nextElementSibling).toBe(input(el))
    // -8 on its trailing side stands in for the gutter the field had (§9.3's overlap): the mark's
    // centre stays at 22 and the text at 46, the morph's double still the field's twin.
    expect(c.className).toContain('-mr-2')
    expect(field(el).className).not.toContain('pl-2')
    // The mark inside is the 28 slot with the 20 favicon the NTP-09 tests hold it to.
    const mark = c.querySelector<HTMLElement>('[data-testid="engine-field-glyph"]')!
    expect(mark.className).toContain('h-7 w-7')
    expect(mark.textContent).toBe('G')
    expect(
      mark.querySelector<HTMLImageElement>('[data-testid="engine-field-favicon"]')!.className
    ).toContain('h-5 w-5')
    // Nothing is up and nothing was asked of the host before the tap.
    expect(picker()).toBeNull()
    expect(commands()).not.toContain('settings.update')
    expect(input(el).placeholder).toBe('Search or enter address')
  })

  it('a tap opens the §9.13 picker on the frame’s dialog host: the 48 header, a radio row per engine with the current one checked and focused, no Set as default while the query’s engine is the default', async () => {
    const el = await render(phone())
    input(el).focus()
    const sheet = await open(el)
    expect(control(el).getAttribute('aria-expanded')).toBe('true')
    expect(sheet.querySelector('.zen-sheet-title')!.textContent).toBe('Search engine')
    expect(sheet.querySelector('.zen-sheet-title-block')).toBeNull()
    expect(sheet.classList.contains('zen-settings-sheet')).toBe(true)
    // The shipped engines, in the model's order, each with its mark before the name.
    expect(radios().map((r) => r.querySelector('.zen-settings-label')!.textContent)).toEqual(
      DEFAULT_SEARCH_ENGINES.map((e) => e.name)
    )
    expect(radios().every((r) => r.querySelector('.zen-settings-leading') !== null)).toBe(true)
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([
      radio('Google')
    ])
    expect(sheet.querySelector('[role="radiogroup"]')).not.toBeNull()
    // The checked row holds the focus (§9.22's `checked`); the omnibox under it is inert.
    expect(document.activeElement).toBe(radio('Google'))
    expect(omnibox(el).hasAttribute('inert')).toBe(true)
    expect(setDefault()).toBeNull()
    expect(commands()).not.toContain('settings.update')
  })

  it('a pick is this query’s engine: the sheet goes, the glyph and the placeholder follow, the rows are the engine’s, the submit is its search, the terms stay; the default is untouched and the field takes the focus back', async () => {
    const el = await render(phone())
    await type(input(el), 'cats')
    input(el).focus()
    await open(el)
    invoke.mockClear()
    await press(radio('DuckDuckGo'))
    expect(control(el).getAttribute('aria-label')).toBe('Search engine: DuckDuckGo')
    expect(control(el).getAttribute('aria-expanded')).toBe('false')
    expect(
      control(el).querySelector<HTMLElement>('[data-testid="engine-field-glyph"]')!.textContent
    ).toBe('D')
    expect(input(el).placeholder).toBe('Search with DuckDuckGo')
    expect(input(el).value).toBe('cats')
    // The rows are asked of the picked engine, for the terms as they stand.
    expect(callsTo('urlbar.suggest')).toContainEqual({
      query: 'cats',
      tabId: 't1',
      engineId: 'duckduckgo',
      grouped: true
    })
    // The default is not written by a pick.
    expect(commands()).not.toContain('settings.update')
    expect(omnibox(el).hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(input(el))
    // Enter searches the picked engine.
    await pressEnter(input(el))
    await act(async () => {
      await vi.waitFor(() => expect(commands()).toContain('urlbar.submit'))
    })
    expect(callsTo('urlbar.submit')[0]).toMatchObject({
      input: 'https://duckduckgo.com/?q=cats',
      tabId: 't1'
    })
    expect(commands()).not.toContain('settings.update')
  })

  it('Set as default stands in the footer once the query’s engine is not the default, and runs the Settings row’s command alone: settings.update with the engine, nothing to the EEA choice record', async () => {
    const el = await render(phone())
    await type(input(el), 'cats')
    await open(el)
    await press(radio('DuckDuckGo'))
    const sheet = await open(el)
    // The picked engine is the checked row now; the footer offers the default.
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([
      radio('DuckDuckGo')
    ])
    expect(document.activeElement).toBe(radio('DuckDuckGo'))
    const action = setDefault()!
    expect(action).not.toBeNull()
    expect(action.textContent).toBe('Set as default')
    expect(action.closest('.zen-sheet-footer')).not.toBeNull()
    expect(sheet.contains(action)).toBe(true)
    invoke.mockClear()
    await press(action)
    expect(callsTo('settings.update')).toEqual([{ searchEngineId: 'duckduckgo' }])
    expect(commands().filter((c) => c.startsWith('searchChoice'))).toEqual([])
    expect(commands()).not.toContain('urlbar.submit')
    // The query keeps its engine; the terms stay.
    expect(input(el).placeholder).toBe('Search with DuckDuckGo')
    expect(input(el).value).toBe('cats')
    expect(control(el).getAttribute('aria-label')).toBe('Search engine: DuckDuckGo')
  })

  it('the default picked again is the plain bar over the same terms', async () => {
    const el = await render(phone())
    await type(input(el), 'cats')
    await open(el)
    await press(radio('DuckDuckGo'))
    expect(input(el).placeholder).toBe('Search with DuckDuckGo')
    await open(el)
    invoke.mockClear()
    await press(radio('Google'))
    expect(control(el).getAttribute('aria-label')).toBe('Search engine: Google')
    expect(input(el).placeholder).toBe('Search or enter address')
    expect(input(el).value).toBe('cats')
    // The rows are the default's again: no engine named to the host.
    expect(callsTo('urlbar.suggest')).toContainEqual({ query: 'cats', tabId: 't1', grouped: true })
    expect(commands()).not.toContain('settings.update')
  })

  it('the engine picked again closes the picker and changes nothing', async () => {
    const el = await render(phone())
    await type(input(el), 'cats')
    await open(el)
    invoke.mockClear()
    await press(radio('Google'))
    expect(control(el).getAttribute('aria-label')).toBe('Search engine: Google')
    expect(input(el).placeholder).toBe('Search or enter address')
    expect(input(el).value).toBe('cats')
    expect(commands()).toEqual([])
  })

  it('a typed @keyword gives way to the pick: its query alone stays as the terms', async () => {
    const el = await render(phone())
    await type(input(el), '@bing cats')
    expect(control(el).getAttribute('aria-label')).toBe('Search engine: Bing')
    expect(input(el).placeholder).toBe('Search with Bing')
    const sheet = await open(el)
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([
      radio('Bing')
    ])
    // Bing is this query's engine, not the default: the footer offers it as the default.
    expect(sheet.contains(setDefault()!)).toBe(true)
    await press(radio('DuckDuckGo'))
    expect(input(el).value).toBe('cats')
    expect(input(el).placeholder).toBe('Search with DuckDuckGo')
    expect(control(el).getAttribute('aria-label')).toBe('Search engine: DuckDuckGo')
    expect(commands()).not.toContain('settings.update')
  })

  it('reads the chosen default and checks it: the setting, not Google, is the picker’s current row', async () => {
    const el = await render(phone('bing'))
    expect(control(el).getAttribute('aria-label')).toBe('Search engine: Bing')
    expect(input(el).placeholder).toBe('Search or enter address')
    await open(el)
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([
      radio('Bing')
    ])
    expect(setDefault()).toBeNull()
  })
})
