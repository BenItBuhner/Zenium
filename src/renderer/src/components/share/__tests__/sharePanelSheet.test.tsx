// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SharePanelRequest } from '@shared/types'
import { viewportStore } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'

/*
 * The browser's own share panel (Android below 14; SH-03) rendered for real in happy-dom, its
 * sheet's spring cranked by hand: the preview's three forms – a page's title over its link
 * behind the favicon, a selection's text over the link to its highlight with no favicon, an
 * image's picture and "Image" – the apps row with More as its last cell, the chips by kind, and
 * a private tab's panel the same sheet less the QR code chip. The requests are the host's
 * (`Share.kt`: a selection comes with its text and link and neither title nor favicon; an image
 * with its picture alone).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: async () => null,
  onEvent: () => () => undefined
}))

const { SharePanelLayer } = await import('../SharePanelSheet')

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

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

const TARGETS = [
  { component: 'com.example.a/.Share', label: 'Alpha', icon: 'data:image/webp;base64,AAAA' },
  { component: 'com.example.b/.Share', label: 'Beta', icon: 'data:image/webp;base64,BBBB' },
  { component: 'com.example.c/.Share', label: 'Gamma', icon: 'data:image/webp;base64,CCCC' }
]

const HIGHLIGHT = 'https://example.com/#:~:text=This%20domain,permission.'
const PASSAGE =
  'This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.'

/** A page's share as the host sends it, with what a test names changed. */
function request(over: Partial<SharePanelRequest> = {}): SharePanelRequest {
  return {
    id: 'share-panel-1',
    kind: 'link',
    title: 'Example Domain',
    url: 'https://example.com/',
    text: null,
    favicon: 'data:image/png;base64,AAAA',
    image: null,
    tabId: 'tab-1',
    private: false,
    targets: [...TARGETS],
    ...over
  }
}

const selection = (over: Partial<SharePanelRequest> = {}): SharePanelRequest =>
  request({
    id: 'share-panel-2',
    kind: 'text',
    title: null,
    url: HIGHLIGHT,
    text: PASSAGE,
    favicon: null,
    ...over
  })

const picture = (over: Partial<SharePanelRequest> = {}): SharePanelRequest =>
  request({
    id: 'share-panel-3',
    kind: 'image',
    title: null,
    url: null,
    favicon: null,
    image: 'data:image/webp;base64,IMG',
    ...over
  })

/** One tree at a time: a root left mounted would keep its layer on the store and mount a second sheet. */
function unmount(): void {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
}

function render(el: ReactElement): void {
  unmount()
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

/** Run the sheet's spring to rest. */
function rest(): void {
  for (let i = 0; i < 200 && frames.scheduled; i++) act(() => frames.run(1))
  expect(frames.scheduled).toBe(false)
}

/** The layer as the shell mounts it, with the store holding `req`. */
function show(req: SharePanelRequest): void {
  act(() => uiStore.set({ sharePanel: req }))
  render(<SharePanelLayer />)
  rest()
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const qa = <T extends HTMLElement>(selector: string): T[] => [
  ...document.querySelectorAll<T>(selector)
]
const panel = (): HTMLElement | null => q('.zen-sheet.zen-share-panel, .zen-share-panel')
const preview = (): HTMLElement => q('.zen-share-panel-preview')!
const title = (): string => q('.zen-share-panel .zen-menu-link-title')?.textContent ?? ''
const detail = (): string | null => q('.zen-share-panel .zen-menu-link-url')?.textContent ?? null
const cells = (row: string): HTMLElement[] =>
  qa(`.zen-share-panel [data-row="${row}"] .zen-share-panel-cell`)
const kinds = (row: string): string[] => cells(row).map((c) => c.dataset.kind ?? '')
const captions = (row: string): string[] =>
  cells(row).map((c) => c.querySelector('.zen-share-panel-caption')?.textContent ?? '')

beforeEach(() => {
  run.mockClear()
  frames.install()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone', coarse: true })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  // The layer is 800 px tall and the sheet's content 300 px: a sheet with room to stand.
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
  unmount()
  act(() => uiStore.set({ sharePanel: null }))
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false }))
  vi.unstubAllGlobals()
  frames.now = 0
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

describe("the share panel's sheet (SH-03)", () => {
  it("previews a page's share as its title over its link behind the favicon, and the title names the sheet", () => {
    show(request())
    expect(panel()).not.toBeNull()
    expect(preview().dataset.kind).toBe('link')
    expect(preview().querySelector('.zen-menu-link-favicon')).not.toBeNull()
    expect(preview().querySelector('.zen-menu-link-thumbnail')).toBeNull()
    expect(title()).toBe('Example Domain')
    expect(detail()).toBe('https://example.com/')
    const heading = q('.zen-share-panel .zen-menu-link-title')!
    expect(heading.id).not.toBe('')
    expect(q(`[aria-labelledby="${heading.id}"]`)).not.toBeNull()
  })

  it("leads a selection's preview with the selected text, the link to its highlight beneath, and draws no favicon", () => {
    show(selection())
    expect(preview().dataset.kind).toBe('text')
    expect(preview().querySelector('.zen-menu-link-favicon')).toBeNull()
    expect(preview().querySelector('.zen-menu-link-thumbnail')).toBeNull()
    expect(title()).toBe(PASSAGE)
    expect(detail()).toBe(HIGHLIGHT)
  })

  it("shows a selection's text alone when it came without a link (not a web page)", () => {
    show(selection({ url: null }))
    expect(title()).toBe(PASSAGE)
    expect(detail()).toBeNull()
  })

  it('previews an image as the picture itself, named Image, with nothing beneath', () => {
    show(picture())
    expect(preview().dataset.kind).toBe('image')
    expect(preview().querySelector('.zen-menu-link-favicon')).toBeNull()
    const img = preview().querySelector<HTMLImageElement>('img.zen-menu-link-thumbnail')!
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('data:image/webp;base64,IMG')
    expect(title()).toBe('Image')
    expect(detail()).toBeNull()
  })

  it('draws the apps in the order the host ranked them, each under its name, and More as the last cell', () => {
    show(request())
    expect(kinds('apps')).toEqual(['target', 'target', 'target', 'more'])
    expect(captions('apps')).toEqual(['Alpha', 'Beta', 'Gamma', 'More'])
    expect(cells('apps').map((c) => c.dataset.component ?? null)).toEqual([
      ...TARGETS.map((t) => t.component),
      null
    ])
    expect(
      cells('apps')
        .slice(0, 3)
        .map((c) =>
          c.querySelector<HTMLImageElement>('img.zen-share-panel-app')?.getAttribute('src')
        )
    ).toEqual(TARGETS.map((t) => t.icon))
    // A row with no apps at all still ends in More: the system sheet is always a way out.
    show(request({ targets: [] }))
    expect(kinds('apps')).toEqual(['more'])
  })

  it("gives each share its chips: a page's four in Chrome's order, a selection's and an image's two", () => {
    show(request())
    expect(kinds('chips')).toEqual(['copy', 'screenshot', 'print', 'qr'])
    expect(captions('chips')).toEqual(['Copy link', 'Long screenshot', 'Print', 'QR code'])
    show(selection())
    expect(captions('chips')).toEqual(['Copy text', 'Long screenshot'])
    show(picture())
    expect(captions('chips')).toEqual(['Copy image', 'Long screenshot'])
  })

  it("draws a private tab's panel as the same sheet – preview, apps row, More – less the QR code chip", () => {
    // The title's id is React's per mount; the markup is compared without it.
    const markup = (el: HTMLElement | null): string => el!.outerHTML.replace(/ id="[^"]*"/g, '')
    show(request())
    const publicPreview = markup(preview())
    const publicApps = markup(q('.zen-share-panel [data-row="apps"]'))
    show(request({ private: true }))
    expect(markup(preview())).toBe(publicPreview)
    expect(markup(q('.zen-share-panel [data-row="apps"]'))).toBe(publicApps)
    expect(kinds('chips')).toEqual(['copy', 'screenshot', 'print'])
    // Nothing marks the sheet as private: the panel has no incognito dress of its own.
    expect(panel()?.outerHTML).not.toContain('private')
  })

  it('answers the host with the pick once the sheet has left: an app by its component, More as more', () => {
    show(request())
    const beta = cells('apps')[1]
    act(() => {
      beta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    rest()
    const answers = run.mock.calls.filter(([name]) => name === 'share.panelAction')
    expect(answers).toEqual([
      [
        'share.panelAction',
        { id: 'share-panel-1', kind: 'target', component: 'com.example.b/.Share' }
      ]
    ])
    expect(uiStore.get().sharePanel).toBeNull()

    show(request({ id: 'share-panel-4' }))
    const more = cells('apps').at(-1)!
    expect(more.dataset.kind).toBe('more')
    act(() => {
      more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    rest()
    expect(run.mock.calls.filter(([name]) => name === 'share.panelAction').at(-1)).toEqual([
      'share.panelAction',
      { id: 'share-panel-4', kind: 'more' }
    ])
  })
})
