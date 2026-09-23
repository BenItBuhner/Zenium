// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import type { SiteInfo } from '@shared/siteInfo'

/*
 * The phone site-information sheet's levels, rendered on the chassis (W5-17): the slide paints
 * the pane arriving with its content from its first frame and measures the sheet on the level it
 * shows (seed 51); and "Clear cookies?" / "Clear site data?" are levels of the sheet wearing the
 * §9.23 confirmation's keyboard contract exactly (§10.4, the design lead's seed-55 ruling): the
 * level's container takes the focus on entry, Tab reaches Cancel then the danger verb, Enter is
 * inert on the destructive question, Escape is one hop back to the row that opened it.
 */

const info: SiteInfo = {
  tabId: 't1',
  url: 'https://github.com/BenItBuhner/Zenium',
  host: 'github.com',
  site: 'github.com',
  origin: 'https://github.com',
  containerId: 'default',
  security: { state: 'secure', certificate: null, mixedContent: null },
  cookies: {
    items: [
      {
        name: 'logged_in',
        domain: '.github.com',
        path: '/',
        secure: true,
        httpOnly: true,
        session: false,
        size: 12
      },
      {
        name: '_gh_sess',
        domain: 'github.com',
        path: '/',
        secure: true,
        httpOnly: true,
        session: true,
        size: 400
      }
    ],
    thirdParty: []
  },
  storage: {
    usageBytes: 2048,
    quotaBytes: null,
    origins: ['https://github.com'],
    localStorageItems: 3,
    sessionStorageItems: 0,
    serviceWorkers: 0
  },
  permissions: [],
  siteData: { state: 'default', pattern: null, addable: '[*.]github.com', default: 'allow' }
}

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'site.info') return info
  if (name === 'site.clearCookies') return { removed: 2 }
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SiteInfoLayer } = await import('../SiteInfoSheet')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { siteInfoStore } = await import('@renderer/lib/siteInfo')
const { defaultShortcuts } = await import('@shared/shortcuts')

const page = {
  id: 't1',
  spaceId: 'space',
  containerId: 'default',
  url: info.url,
  title: 'Zenium',
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
} as unknown as Tab

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: 'default',
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

/** The state of a phone showing the page. */
const state = {
  platform: 'android',
  capabilities: { windowControls: false, requestBlocking: true, translate: true },
  tabs: { t1: page },
  spaces: [space],
  activeSpaceId: 'space',
  settings: {
    urlbarBehavior: 'normal',
    blocking: { level: 'balanced' },
    phoneBarPosition: 'bottom'
  },
  window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
  boosts: [],
  extensions: [],
  bookmarks: [],
  downloads: [],
  downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
  shortcuts: defaultShortcuts('linux', 'chrome'),
  blockedPopups: {},
  blocking: { enabled: true, siteExceptions: [] },
  translate: { available: true, tabs: {} },
  media: [],
  securityPrompts: [],
  autofill: { prompts: [], picker: null },
  siteData: { clearsAtNextLaunch: false },
  folders: {},
  essentialTabIds: [],
  glance: null
} as unknown as UIState

/**
 * Chrome's rule for `focus()`, which happy-dom lacks: an element that is not rendered – `hidden`,
 * `display: none` or `visibility: hidden` on it or an ancestor – or that stands in an inert
 * subtree takes no focus. The panes of the levels that are away are `hidden`.
 */
function installChromeFocusRule(): void {
  const native = HTMLElement.prototype.focus
  const rendered = (target: HTMLElement): boolean => {
    for (let el: HTMLElement | null = target; el; el = el.parentElement) {
      if (
        el.hidden ||
        el.style.visibility === 'hidden' ||
        el.style.display === 'none' ||
        el.hasAttribute('inert')
      )
        return false
    }
    return true
  }
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions
  ) {
    if (rendered(this)) native.call(this, options)
  })
}

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
const TRACK_WIDTH = 360
/** How many panes stood in the track's flow each time the chassis measured the sheet. */
let measured: number[] = []
let root: Root | null = null
let host: HTMLElement | null = null
const initialViewport = viewportStore.get()
const descriptors = Object.fromEntries(
  ['clientHeight', 'offsetHeight', 'offsetWidth'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
)

function render(el: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

/** The sheet up for the page on a phone, its reading of the site in. */
async function open(): Promise<void> {
  browserStore.set({ state })
  viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
  uiStore.set({ siteInfoOpen: true })
  siteInfoStore.set({ tabId: 't1', anchor: null, revision: 0 })
  render(<SiteInfoLayer />)
  await settle()
  await settle()
}

const sheet = (): HTMLElement => document.querySelector<HTMLElement>('.zen-sheet')!
const pane = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.zen-sheet-pane[data-level="${id}"]`)!
const panes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-sheet-pane')]
const inFlow = (): string[] =>
  panes()
    .filter((p) => !p.hidden && p.style.display !== 'none' && !p.hasAttribute('data-leaving'))
    .map((p) => p.dataset.level!)
const buttons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('button')
]
const row = (label: string): HTMLButtonElement =>
  buttons().find((b) => b.getAttribute('aria-label')?.startsWith(label))!
const byText = (text: string): HTMLButtonElement =>
  buttons().find((b) => !b.hidden && b.textContent?.trim() === text)!
const active = (): Element | null => document.activeElement
/** A key press as the WebView delivers it: on the focused element, up through the window. */
const key = (name: string, shift = false): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', {
    key: name,
    shiftKey: shift,
    bubbles: true,
    cancelable: true
  })
  act(() => {
    ;(active() ?? document.body).dispatchEvent(e)
  })
  return e
}
const click = (el: HTMLElement): void => act(() => el.click())
const rest = (): void => act(() => frames.run(200))
const commands = (): string[] => invoke.mock.calls.map(([name]) => name)

beforeEach(() => {
  frames.install()
  installChromeFocusRule()
  measured = []
  // happy-dom lays nothing out: the layer 800 tall, the sheet's content 300, the track 360 wide.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      // The chassis's measure: the sheet sized to its content for one synchronous layout.
      if (this.classList.contains('zen-sheet') && this.style.height === 'auto')
        measured.push(inFlow().length)
      return 300
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-track') ? TRACK_WIDTH : 0
    }
  })
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  viewportStore.set(initialViewport)
  uiStore.set({ siteInfoOpen: false, mediaSheet: null, overlay: 'none' })
  siteInfoStore.set({ tabId: null, anchor: null })
  browserStore.set({ state: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the level slide (seed 51, §11)', () => {
  it('renders every pane but the level shown hidden, so the chassis measures the sheet on that level before its first frame', async () => {
    await open()
    // Six panes stand in the track – the root, three detail levels, two confirmations – and one
    // is in flow; the sheet was measured on that one alone, at the mount and at the reading.
    expect(panes().map((p) => p.dataset.level)).toEqual([
      'main',
      'connection',
      'cookies',
      'permissions',
      'clear-cookies',
      'clear-data'
    ])
    expect(inFlow()).toEqual(['main'])
    expect(
      panes()
        .filter((p) => p.dataset.level !== 'main')
        .every((p) => p.hidden)
    ).toBe(true)
    expect(measured.length).toBeGreaterThan(0)
    expect(measured.every((n) => n === 1)).toBe(true)
  })

  it('paints the pane arriving whole and with its content from the first frame of a push: over the pane leaving, not faded in, not hidden from assistive technology', async () => {
    await open()
    const connection = row('Connection')
    expect(connection).toBeDefined()
    click(connection)
    // The first frame, as the push painted it before any animation frame ran.
    const arriving = pane('connection')
    const leaving = pane('main')
    expect(arriving.hidden).toBe(false)
    expect(arriving.style.opacity).toBe('')
    expect(arriving.hasAttribute('aria-hidden')).toBe(false)
    expect(arriving.hasAttribute('data-over')).toBe(true)
    expect(arriving.hasAttribute('data-leaving')).toBe(false)
    // At the track's far edge, ready to travel in: transform and opacity are all that move (§11).
    expect(arriving.style.transform).toBe(`translate3d(${TRACK_WIDTH.toFixed(2)}px, 0, 0)`)
    expect(leaving.hasAttribute('data-leaving')).toBe(true)
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(leaving.style.transform).toBe('')
    expect(Number(leaving.style.opacity)).toBe(1)
    // The panes not in play stay hidden through the slide.
    expect(
      panes()
        .filter((p) => p.hidden)
        .map((p) => p.dataset.level)
    ).toEqual(['cookies', 'permissions', 'clear-cookies', 'clear-data'])
    // Through the slide the arriving pane never fades and never hides; the leaving one, under,
    // shifts a little and dims, never to nothing.
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      act(() => frames.run(1))
      if (arriving.style.opacity !== '') seen.add(`arriving opacity ${arriving.style.opacity}`)
      if (arriving.hidden) seen.add('arriving hidden')
      if (arriving.getAttribute('aria-hidden') === 'true') seen.add('arriving aria-hidden')
      const dim = leaving.style.opacity === '' ? 1 : Number(leaving.style.opacity)
      if (dim < 0.5) seen.add(`leaving dimmed to ${leaving.style.opacity}`)
    }
    expect([...seen]).toEqual([])
    rest()
    // At rest: the connection pane alone, in flow, unmoved; the root hidden.
    expect(inFlow()).toEqual(['connection'])
    expect(arriving.style.transform).toBe('')
    expect(arriving.hasAttribute('data-over')).toBe(false)
    expect(leaving.hidden).toBe(true)
    expect(leaving.hasAttribute('data-leaving')).toBe(false)
    expect(leaving.hasAttribute('aria-hidden')).toBe(false)
    // The sheet was measured on the level arriving as the level changed.
    expect(measured.at(-1)).toBe(1)
  })

  it('on a pop the pane leaving is the deeper one and travels over the pane arriving, which is whole beneath it', async () => {
    await open()
    click(row('Connection'))
    rest()
    click(row('Back to site information'))
    const leaving = pane('connection')
    const arriving = pane('main')
    expect(leaving.hasAttribute('data-leaving')).toBe(true)
    expect(leaving.hasAttribute('data-over')).toBe(true)
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(leaving.style.transform).toBe('')
    expect(arriving.hidden).toBe(false)
    expect(arriving.hasAttribute('aria-hidden')).toBe(false)
    expect(arriving.hasAttribute('data-over')).toBe(false)
    // The root arrives from under: shifted by the under fraction, dimmed to the under value, and whole at rest.
    expect(arriving.style.transform).toBe(`translate3d(${(-0.3 * TRACK_WIDTH).toFixed(2)}px, 0, 0)`)
    expect(arriving.style.opacity).toBe('0.500')
    rest()
    expect(inFlow()).toEqual(['main'])
    expect(arriving.style.opacity).toBe('')
    expect(leaving.hidden).toBe(true)
  })

  it('takes the keyboard off the row that opened a level – left there it would sit in the pane leaving – and lands on the level’s first row, or on the sheet with none; one hop back returns it', async () => {
    await open()
    const connection = row('Connection')
    connection.focus()
    expect(active()).toBe(connection)
    click(connection)
    // The connection level has no control of its own: the sheet's held container takes the focus.
    expect(active()).not.toBe(connection)
    expect(active()).toBe(sheet())
    rest()
    // Escape: one hop back to the row.
    key('Escape')
    expect(active()).toBe(connection)
    rest()
    expect(inFlow()).toEqual(['main'])
    // A level with rows lands on its first: the cookies level's policy row.
    const cookies = row('Cookies and site data')
    cookies.focus()
    click(cookies)
    const first = pane('cookies').querySelector<HTMLElement>('button')!
    expect(active()).toBe(first)
    expect(pane('cookies').contains(active())).toBe(true)
    rest()
    // The back control: one hop back to the row too.
    click(row('Back to site information'))
    expect(active()).toBe(cookies)
  })
})

describe('the confirmations as levels (seed 55, §10.4, §9.22, §9.23)', () => {
  async function openCookies(): Promise<void> {
    await open()
    click(row('Cookies and site data'))
    rest()
  }

  it('"Clear cookies?" is a level one in from the row, a dialog of its own: a title block over the two-button footer, no header, named by its question', async () => {
    await openCookies()
    const clear = byText('Clear cookies')
    clear.focus()
    click(clear)
    const level = pane('clear-cookies')
    expect(level.hidden).toBe(false)
    expect(level.getAttribute('role')).toBe('alertdialog')
    expect(level.tabIndex).toBe(-1)
    expect(level.hasAttribute('data-destructive')).toBe(true)
    expect(level.dataset.confirm).toBe('clear-cookies')
    const title = document.getElementById(level.getAttribute('aria-labelledby')!)!
    const detail = document.getElementById(level.getAttribute('aria-describedby')!)!
    expect(title.textContent).toBe('Clear cookies?')
    expect(detail.textContent).toBe('Removes 2 cookies and signs you out of github.com.')
    // The §9.23 form: a title block, then the footer with Cancel first and the danger verb, no
    // default and no primary; nothing else in the level.
    expect([...level.children].map((c) => c.className)).toEqual([
      'zen-sheet-title-block',
      'zen-sheet-footer'
    ])
    const [cancel, verb] = [...level.querySelectorAll<HTMLButtonElement>('button')]
    expect(cancel!.textContent).toBe('Cancel')
    expect(verb!.getAttribute('aria-label')).toBe('Confirm clear cookies')
    expect(verb!.hasAttribute('data-danger')).toBe(true)
    expect(level.querySelector('[data-primary]')).toBeNull()
    // No header on a confirmation level: the back control went with the cookies level's header.
    expect(sheet().querySelector('.zen-sheet-header')).toBeNull()
    // The sheet is named by the question while the level stands.
    expect(sheet().getAttribute('aria-label')).toBe('Clear cookies?')
    // Not a sheet over the sheet: one dialog on the chassis.
    expect(document.querySelectorAll('.zen-sheet')).toHaveLength(1)
    rest()
    expect(inFlow()).toEqual(['clear-cookies'])
    expect(pane('cookies').hidden).toBe(true)
  })

  it('the container takes the focus on entry, no verb preselected; Tab reaches Cancel, then the verb, then the grabber; Shift+Tab from the container reaches the verb', async () => {
    await openCookies()
    const clear = byText('Clear cookies')
    clear.focus()
    click(clear)
    const level = pane('clear-cookies')
    const [cancel, verb] = [...level.querySelectorAll<HTMLButtonElement>('button')]
    expect(active()).toBe(level)
    let e = key('Tab')
    expect(active()).toBe(cancel)
    expect(e.defaultPrevented).toBe(true)
    // The step from Cancel to the verb is the browser's; from the verb Tab wraps to the grabber.
    verb!.focus()
    e = key('Tab')
    expect(active()?.getAttribute('aria-label')).toBe('Dismiss')
    expect(e.defaultPrevented).toBe(true)
    // And from the grabber Shift+Tab is back at the verb: the row that asked, in the pane
    // leaving, is no stop.
    e = key('Tab', true)
    expect(active()).toBe(verb)
    // Shift+Tab from the held container: the verb.
    level.focus()
    e = key('Tab', true)
    expect(active()).toBe(verb)
    expect(e.defaultPrevented).toBe(true)
    rest()
    // At rest the same, with the cookies pane hidden.
    level.focus()
    key('Tab')
    expect(active()).toBe(cancel)
  })

  it('Enter is inert on the destructive question: swallowed from the container, confirming nothing; a focused button answers its own', async () => {
    await openCookies()
    click(byText('Clear cookies'))
    const level = pane('clear-cookies')
    expect(active()).toBe(level)
    let e = key('Enter')
    expect(e.defaultPrevented).toBe(true)
    expect(commands()).not.toContain('site.clearCookies')
    expect(level.hidden).toBe(false)
    expect(sheet().getAttribute('aria-label')).toBe('Clear cookies?')
    // Enter on the verb itself is the button's, left to the browser.
    const verb = level.querySelector<HTMLButtonElement>('[data-action="confirm"]')!
    verb.focus()
    e = key('Enter')
    expect(e.defaultPrevented).toBe(false)
    expect(commands()).not.toContain('site.clearCookies')
  })

  it('Escape is one hop back to the row that opened it, and so is Cancel', async () => {
    await openCookies()
    const clear = byText('Clear cookies')
    clear.focus()
    click(clear)
    rest()
    expect(active()).toBe(pane('clear-cookies'))
    key('Escape')
    expect(active()).toBe(clear)
    expect(commands()).not.toContain('site.clearCookies')
    // The level is on its way out: aria-hidden at once, hidden at rest, the cookies header back.
    expect(pane('clear-cookies').getAttribute('aria-hidden')).toBe('true')
    rest()
    expect(pane('clear-cookies').hidden).toBe(true)
    expect(inFlow()).toEqual(['cookies'])
    expect(row('Back to site information')).toBeDefined()
    expect(sheet().getAttribute('aria-label')).toBe('Cookies and site data')
    // Cancel, by the keyboard: Tab to it, Space is the browser's click.
    click(clear)
    key('Tab')
    const cancel = active() as HTMLButtonElement
    expect(cancel.textContent).toBe('Cancel')
    click(cancel)
    expect(active()).toBe(clear)
    rest()
    expect(inFlow()).toEqual(['cookies'])
  })

  it('the verb pops the level and then does the deed; the keyboard parks on the sheet, the row it was asked from may go with the cookies', async () => {
    await openCookies()
    const clear = byText('Clear cookies')
    clear.focus()
    click(clear)
    rest()
    key('Tab')
    expect((active() as HTMLElement).textContent).toBe('Cancel')
    // The step from Cancel to the verb is the browser's.
    const verb = pane('clear-cookies').querySelector<HTMLButtonElement>('[data-action="confirm"]')!
    verb.focus()
    expect(verb.getAttribute('aria-label')).toBe('Confirm clear cookies')
    click(verb)
    expect(commands()).toContain('site.clearCookies')
    expect(invoke).toHaveBeenCalledWith('site.clearCookies', { tabId: 't1' })
    expect(active()).toBe(sheet())
    expect(pane('clear-cookies').getAttribute('aria-hidden')).toBe('true')
    rest()
    expect(inFlow()).toEqual(['cookies'])
    expect(pane('clear-cookies').hidden).toBe(true)
  })

  it('"Clear site data?" is the same level from the root, with its own words, back to its row on Cancel', async () => {
    await open()
    const clear = byText('Clear site data')
    clear.focus()
    click(clear)
    const level = pane('clear-data')
    expect(active()).toBe(level)
    expect(level.getAttribute('role')).toBe('alertdialog')
    expect(document.getElementById(level.getAttribute('aria-labelledby')!)!.textContent).toBe(
      'Clear site data?'
    )
    expect(document.getElementById(level.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Removes the cookies, stored data and permissions of github.com, then reloads the page.'
    )
    const [cancel, verb] = [...level.querySelectorAll<HTMLButtonElement>('button')]
    expect(cancel!.textContent).toBe('Cancel')
    expect(verb!.getAttribute('aria-label')).toBe('Confirm clear all site data')
    expect(sheet().getAttribute('aria-label')).toBe('Clear site data?')
    expect(sheet().querySelector('.zen-sheet-header')).toBeNull()
    key('Enter')
    expect(commands()).not.toContain('site.clearData')
    rest()
    click(cancel!)
    expect(active()).toBe(clear)
    rest()
    expect(inFlow()).toEqual(['main'])
    expect(commands()).not.toContain('site.clearData')
  })
})
