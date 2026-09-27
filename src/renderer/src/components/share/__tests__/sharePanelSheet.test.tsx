// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { QrCodeRequest } from '@shared/qrScan'
import type { SharePanelRequest } from '@shared/types'
import { viewportStore } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'

/*
 * The browser's own share panel (Android below 14; SH-03) rendered for real in happy-dom, its
 * sheet's spring cranked by hand: the preview's three forms – a page's title over its link
 * behind the favicon, a selection's text over the page's link (the highlight's `#:~:text=`
 * fragment off the displayed line) with no favicon, an image's picture and "Image" – then the
 * chips in the Android 14 action row's order above the hairline, the apps row with More as its
 * last cell under it (v2 draft §9.38), the chips the subject's alone, and a private tab's panel
 * the same sheet, QR code included. The requests are the host's (`Share.kt`: a selection comes
 * with its text and link and neither title nor favicon; an image with its picture alone).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: async () => null,
  onEvent: () => () => undefined
}))

const { SharePanelLayer } = await import('../SharePanelSheet')
const { showQrCode, dismissQrCode } = await import('@renderer/lib/qrCode')
const { QR_CODE_SEAM_GUARD_MS, SHARE_SEAM_BUSY_MS, SHARE_SEAM_OUT_MS } =
  await import('@renderer/lib/shareSeam')

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
    source: 'menu',
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
  dismissQrCode()
  act(() => uiStore.set({ sharePanel: null, qrCode: null, qrCodeSeam: null }))
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

  it("leads a selection's preview with the selected text, the page's link beneath without the highlight's fragment, and draws no favicon", () => {
    show(selection())
    expect(preview().dataset.kind).toBe('text')
    expect(preview().querySelector('.zen-menu-link-favicon')).toBeNull()
    expect(preview().querySelector('.zen-menu-link-thumbnail')).toBeNull()
    expect(title()).toBe(PASSAGE)
    expect(detail()).toBe('https://example.com/')
    expect(panel()?.textContent).not.toContain('#:~:text=')
    // The request in the store still carries the whole link: the share does, only the line does not.
    expect(uiStore.get().sharePanel?.url).toBe(HIGHLIGHT)
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

  it('reads from the subject down: the preview, the chips, a hairline, then the apps row nearest the thumb (§9.38)', () => {
    show(request())
    const sheet = panel()!
    const order = [
      sheet.querySelector('.zen-share-panel-preview'),
      sheet.querySelector('[data-row="chips"]'),
      sheet.querySelector('.zen-sheet-sep'),
      sheet.querySelector('[data-row="apps"]')
    ]
    for (const el of order) expect(el).not.toBeNull()
    for (let i = 1; i < order.length; i++) {
      // DOCUMENT_POSITION_FOLLOWING: the later element comes after the earlier one in the tree.
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0)
    }
    expect(sheet.querySelectorAll('.zen-sheet-sep')).toHaveLength(1)
  })

  it("gives each share its chips in the action row's order: a page's four, a selection's two, an image's one", () => {
    show(request())
    expect(kinds('chips')).toEqual(['copy', 'qr', 'screenshot', 'print'])
    expect(captions('chips')).toEqual(['Copy link', 'QR code', 'Long screenshot', 'Print'])
    show(selection())
    expect(captions('chips')).toEqual(['Copy text', 'Long screenshot'])
    show(picture())
    expect(captions('chips')).toEqual(['Copy image'])
  })

  it("draws a private tab's panel as the same sheet – preview, chips with QR code, apps row, More", () => {
    // The title's id is React's per mount; the markup is compared without it.
    const markup = (el: HTMLElement | null): string => el!.outerHTML.replace(/ id="[^"]*"/g, '')
    show(request())
    const publicPreview = markup(preview())
    const publicChips = markup(q('.zen-share-panel [data-row="chips"]'))
    const publicApps = markup(q('.zen-share-panel [data-row="apps"]'))
    show(request({ private: true }))
    expect(markup(preview())).toBe(publicPreview)
    expect(markup(q('.zen-share-panel [data-row="chips"]'))).toBe(publicChips)
    expect(markup(q('.zen-share-panel [data-row="apps"]'))).toBe(publicApps)
    expect(kinds('chips')).toEqual(['copy', 'qr', 'screenshot', 'print'])
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

  it("reports a chip the chrome runs itself as `chip` – a page's awaited share hears `shared` for it, as Chrome's hub answers a first-party tap – and then runs it", () => {
    show(request({ id: 'share-panel-6', source: 'page', targets: [] }))
    expect(captions('chips')).toEqual(['Copy link', 'QR code'])
    const copy = cells('chips')[0]
    expect(copy.dataset.kind).toBe('copy')
    act(() => {
      copy.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    rest()
    const names = run.mock.calls.map(([name]) => name)
    expect(names.indexOf('share.panelAction')).toBeLessThan(names.indexOf('clipboard.writeText'))
    expect(run.mock.calls.filter(([name]) => name === 'share.panelAction')).toEqual([
      ['share.panelAction', { id: 'share-panel-6', kind: 'chip', chip: 'copy' }]
    ])
    expect(run.mock.calls.filter(([name]) => name === 'clipboard.writeText')).toEqual([
      ['clipboard.writeText', { text: 'https://example.com/', confirmation: 'Link copied' }]
    ])
    expect(uiStore.get().sharePanel).toBeNull()
  })

  it("previews a page's share of text and a link as the text over the link, and its chips as Copy and QR code", () => {
    show(
      request({
        id: 'share-panel-7',
        source: 'page',
        kind: 'text',
        title: 'A title',
        text: 'a message',
        url: 'https://example.com/'
      })
    )
    expect(preview().dataset.kind).toBe('text')
    expect(title()).toBe('a message')
    expect(detail()).toBe('https://example.com/')
    expect(captions('chips')).toEqual(['Copy', 'QR code'])
  })
})

/*
 * The QR code chip (SH-06; §9.38's hand-off, `lib/shareSeam.ts`'s code seam): the one pick the
 * panel does not leave for. The host hears it at once and encodes while the panel stands, its
 * cells inert; the code that comes back (`qr.code`, `showQrCode`) takes the panel's own sheet
 * element – the preview and rows fading as an inert copy over the code's content, Close |
 * Download in the footer – and its ways out end the code and the panel's request together, with
 * no second answer to the host.
 */
describe("the QR code chip hands the panel's chassis to the code sheet", () => {
  const code = (over: Partial<QrCodeRequest> = {}): QrCodeRequest => ({
    url: 'https://example.com/',
    tabId: 'tab-1',
    rows: ['0000', '0110', '0110', '0000'],
    error: null,
    ...over
  })
  const actions = (): unknown[] =>
    run.mock.calls.filter(([name]) => name === 'share.panelAction').map(([, args]) => args)
  const click = (el: Element): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }
  const elapse = (ms: number): void => {
    act(() => void vi.advanceTimersByTime(ms))
  }
  const qrCell = (): HTMLElement => cells('chips').find((c) => c.dataset.kind === 'qr')!
  /** The chip picked, the code arrived: the sheet is the code's. */
  async function handOff(): Promise<HTMLElement> {
    show(request())
    const chassis = q<HTMLElement>('.zen-sheet')!
    click(qrCell())
    await act(async () => {
      await showQrCode(code())
    })
    return chassis
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => uiStore.set({ snapshot: null, snapshotTabId: null }))
  })

  it('tells the host of the pick at once and keeps the sheet standing, its cells inert, while the host encodes', () => {
    show(request())
    click(qrCell())
    expect(actions()).toEqual([{ id: 'share-panel-1', kind: 'qr' }])
    expect(uiStore.get().sharePanel?.id).toBe('share-panel-1')
    expect(uiStore.get().qrCodeSeam).toEqual({ phase: 'encoding', panelId: 'share-panel-1' })
    expect(panel()).not.toBeNull()
    // Another cell meanwhile does nothing: one pick per panel.
    click(cells('apps')[1]!)
    click(cells('chips')[0]!)
    rest()
    expect(actions()).toEqual([{ id: 'share-panel-1', kind: 'qr' }])
    expect(uiStore.get().sharePanel?.id).toBe('share-panel-1')
    // No sign for an encode that is over inside 150 ms; §9.30's busy form after it – the
    // spinner in the glyph's place, aria-busy, never disabled.
    expect(qrCell().hasAttribute('aria-busy')).toBe(false)
    elapse(SHARE_SEAM_BUSY_MS)
    expect(qrCell().getAttribute('aria-busy')).toBe('true')
    expect(qrCell().querySelector('.zen-share-panel-box svg')).not.toBeNull()
    expect(qrCell().hasAttribute('disabled')).toBe(false)
  })

  it("draws the code in the same sheet element: the seam marked, one sheet and no second, the panel's class and header gone, the code's content and Close | Download in, the copy fading", async () => {
    const chassis = await handOff()
    expect(uiStore.get().qrCodeSeam).toEqual({
      phase: 'hosting',
      panelId: 'share-panel-1',
      promptId: uiStore.get().qrCode!.id
    })
    expect(uiStore.get().sharePanel?.id).toBe('share-panel-1')
    expect(qa('.zen-sheet')).toHaveLength(1)
    expect(q('.zen-sheet')).toBe(chassis)
    expect(chassis.classList.contains('zen-share-panel')).toBe(false)
    expect(chassis.querySelector('.zen-sheet-header')).toBeNull()
    const seam = chassis.querySelector<HTMLElement>('.zen-share-seam')!
    expect(seam.dataset.seam).toBe('qr-code')
    // The panel once more, inert and fading, over the code rising.
    const out = seam.querySelector<HTMLElement>('.zen-share-seam-out')!
    expect(out.hasAttribute('inert')).toBe(true)
    expect(out.getAttribute('aria-hidden')).toBe('true')
    expect(out.querySelector('.zen-share-panel-preview .zen-menu-link-title')?.textContent).toBe(
      'Example Domain'
    )
    expect(out.querySelectorAll('[data-row="chips"] .zen-share-panel-cell')).toHaveLength(4)
    const inLayer = seam.querySelector<HTMLElement>('.zen-share-seam-in')!
    expect(inLayer.querySelector('[data-testid="qr-code-sheet"]')).not.toBeNull()
    expect(inLayer.querySelector('h2')?.textContent).toBe('QR code')
    expect(inLayer.querySelector('.zen-sheet-title-block p')?.textContent).toBe(
      'Let someone nearby scan it to open the link.'
    )
    expect(inLayer.querySelector('[data-testid="qr-code-image"]')).not.toBeNull()
    expect(inLayer.querySelector('[data-testid="qr-code-url"]')?.textContent).toBe(
      'https://example.com/'
    )
    const buttons = [...chassis.querySelectorAll<HTMLButtonElement>('.zen-sheet-footer button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Close', 'Download'])
    expect(buttons[1]!.hasAttribute('data-primary')).toBe(true)
    expect(chassis.getAttribute('aria-labelledby')).toBe('zen-qr-code-title')
    // The copy leaves after its fade; the code stays.
    elapse(SHARE_SEAM_OUT_MS)
    expect(seam.querySelector('.zen-share-seam-out')).toBeNull()
    expect(seam.querySelector('[data-testid="qr-code-sheet"]')).not.toBeNull()
  })

  it('Download runs the sheet down and asks the host for the picture at the landing, the panel’s request ending with it and no second answer', async () => {
    const chassis = await handOff()
    click(chassis.querySelector('[data-testid="qr-code-download"]')!)
    rest()
    expect(actions()).toEqual([{ id: 'share-panel-1', kind: 'qr' }])
    expect(run.mock.calls.filter(([name]) => name === 'qr.download')).toEqual([
      ['qr.download', { url: 'https://example.com/' }]
    ])
    expect(uiStore.get().qrCode).toBeNull()
    expect(uiStore.get().qrCodeSeam).toBeNull()
    expect(uiStore.get().sharePanel).toBeNull()
  })

  it('Close runs the sheet down and ends the code with no download and no second answer', async () => {
    const chassis = await handOff()
    const close = [...chassis.querySelectorAll<HTMLButtonElement>('.zen-sheet-footer button')][0]!
    expect(close.textContent).toBe('Close')
    click(close)
    rest()
    expect(actions()).toEqual([{ id: 'share-panel-1', kind: 'qr' }])
    expect(run.mock.calls.filter(([name]) => name === 'qr.download')).toEqual([])
    expect(uiStore.get().qrCode).toBeNull()
    expect(uiStore.get().qrCodeSeam).toBeNull()
    expect(uiStore.get().sharePanel).toBeNull()
  })

  it('shows the too-long error in the card with Download disabled, in the same chassis', async () => {
    show(request())
    click(qrCell())
    await act(async () => {
      await showQrCode(code({ rows: [], error: 'too-long' }))
    })
    expect(qa('.zen-sheet')).toHaveLength(1)
    expect(q('.zen-qr-code-error')?.textContent).toBe(
      'This link is more than 2,331 characters, too long for a QR code.'
    )
    expect(q<HTMLButtonElement>('[data-testid="qr-code-download"]')?.disabled).toBe(true)
  })

  it('lets the panel leave on the guard when no code comes, as the pick would have had it, with no second answer', () => {
    show(request())
    click(qrCell())
    elapse(QR_CODE_SEAM_GUARD_MS)
    rest()
    expect(actions()).toEqual([{ id: 'share-panel-1', kind: 'qr' }])
    expect(uiStore.get().sharePanel).toBeNull()
    expect(uiStore.get().qrCodeSeam).toBeNull()
  })

  it("a code arriving with no panel standing for it rises on its own: the seam is the panel's alone", async () => {
    show(request({ id: 'share-panel-8' }))
    click(qrCell())
    // The panel dragged away while the host encodes: the request released, the seam gone.
    act(() => uiStore.set({ sharePanel: null, qrCodeSeam: null }))
    rest()
    await act(async () => {
      await showQrCode(code())
    })
    expect(uiStore.get().qrCode).not.toBeNull()
    expect(uiStore.get().qrCodeSeam).toBeNull()
  })
})
