// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MenuDescriptor, MenuItemDescriptor, SharePanelRequest, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { MenuSheet } from '../MenuSheet'
import { SharePanelLayer } from '../../share/SharePanelSheet'
import { topBackSurface } from '@renderer/lib/back'
import { viewportStore } from '@renderer/lib/formFactor'
import { SheetPresence } from '@renderer/lib/motion/presence'
import {
  SHARE_ROW_KEY,
  SHARE_SEAM_BUSY_MS,
  SHARE_SEAM_GUARD_MS,
  SHARE_SEAM_OUT_MS
} from '@renderer/lib/shareSeam'
import { browserStore, openSharePanel, uiStore } from '@renderer/lib/ui'

/*
 * The menu-to-panel seam (v2 draft §9.38's hand-off; `lib/shareSeam.ts`), rendered for real in
 * happy-dom: on a host whose share panel stands in for the system sheet (Android below 14) the
 * app menu's Share row runs its pick with the sheet standing and its rows inert (the tapped row
 * taking §9.30's spinner once the gather has run 150 ms, the others as they were), and the host's
 * `share.panel` request is drawn in the menu's own chassis – the same sheet element, its header
 * now the share's preview, its body the panel's chips and apps, the menu's rows and title once
 * more in inert layers fading out for §11's 120 ms, the back surface the panel's, the handle
 * "Dismiss". An answer closes the sheet with the panel and tells the host of nothing but the
 * answer; a dismissal releases the share; a menu whose request never comes leaves on the guard;
 * a page's request, or one for a menu that has gone, rises in the panel's own sheet; on a host
 * whose share sheet is the system's the row is picked as any other row. Reduced motion is the
 * cut. The frame loop is cranked by hand and the layout given sizes (happy-dom lays nothing out).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class Frames {
  now = 1000
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
    vi.stubGlobal('performance', { now: () => this.now, mark: () => undefined })
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
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => undefined)

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** Run every scheduled frame to quiet. */
function runAll(max = 200): void {
  for (let n = 0; n < max && frames.scheduled; n++) act(() => frames.run(1))
}

const elapse = (ms: number): void => {
  act(() => void vi.advanceTimersByTime(ms))
}

// --- the menu, the host, the request -----------------------------------------------------------

let n = 0
function item(label: string, patch: Partial<MenuItemDescriptor> = {}): MenuItemDescriptor {
  return {
    id: `menu_1_${++n}`,
    type: 'normal',
    label,
    enabled: true,
    checked: false,
    submenu: null,
    ...patch
  }
}
const sep = (): MenuItemDescriptor => item('', { type: 'separator' })

/** The phone app menu as the core composes it: the icon row, then the list with Share… at its head. */
function appMenu(id = 'menu_1'): MenuDescriptor {
  n = 0
  return {
    id,
    source: 'app',
    x: null,
    y: null,
    items: [
      item('Forward', { glyph: 'forward', enabled: false, key: 'icon.forward' }),
      item('Reload', { glyph: 'reload', key: 'icon.reload' }),
      sep(),
      item('Share…', { key: SHARE_ROW_KEY }),
      item('Print…', { key: 'row.print' }),
      sep(),
      item('Settings', { key: 'row.settings' })
    ]
  }
}

/** The host's `share.panel` for the menu's share of the page (`Share.kt`). */
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
    targets: [
      { component: 'com.example.a/.Share', label: 'Alpha', icon: 'data:image/webp;base64,AAAA' },
      { component: 'com.example.b/.Share', label: 'Beta', icon: 'data:image/webp;base64,BBBB' }
    ],
    ...over
  }
}

/**
 * The browser state the sheet reads its host's capabilities from: a phone with one empty space.
 * The viewport is pinned to the phone after it (`formFactor.ts` re-derives the layout from the
 * window on every browser snapshot; happy-dom's window is a desktop's).
 */
function host(sharePanel: boolean): void {
  browserStore.set({
    state: {
      platform: 'android',
      capabilities: { share: true, sharePanel },
      tabs: {},
      spaces: [{ id: 'space', name: 'Space', activeTabId: null, tabIds: [] }],
      activeSpaceId: 'space',
      essentialTabIds: [],
      foreignTabIds: [],
      settings: { ...DEFAULT_SETTINGS }
    } as unknown as UIState
  })
  viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
}

const layer = (m: MenuDescriptor): ReactElement => (
  <>
    <SheetPresence>
      <MenuSheet key={m.id} menu={m} />
    </SheetPresence>
    <SharePanelLayer />
  </>
)

async function show(m: MenuDescriptor = appMenu()): Promise<void> {
  uiStore.set({ menu: m, snapshot: 'data:image/png;base64,PAGE', snapshotTabId: 'tab-1' })
  render(layer(m))
  await settle()
  runAll()
}

// --- reading the sheet ----------------------------------------------------------------------------

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const qa = <T extends HTMLElement>(selector: string): T[] => [
  ...document.querySelectorAll<T>(selector)
]
const sheets = (): HTMLElement[] => qa('.zen-sheet')
const sheet = (): HTMLElement | null => q('.zen-sheet')
const rows = (): HTMLButtonElement[] => qa<HTMLButtonElement>('.zen-sheet-item')
const rowByText = (text: string): HTMLButtonElement =>
  rows().find((b) => b.textContent === text && !b.closest('.zen-share-seam-out'))!
const handle = (): string | null => q('.zen-sheet-handle-hit')?.getAttribute('aria-label') ?? null
const commands = (name: string): unknown[] =>
  invoke.mock.calls.filter(([nm]) => nm === name).map(([, args]) => args)
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const escape = (): void => {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
}
const reducedMotion = (matches: boolean): void => {
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: matches && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined
    })
  })
}

/** Pick the Share row and wait for the pick to go out. */
async function pickShare(): Promise<void> {
  click(rowByText('Share…'))
  await settle()
  runAll()
}

/** The host's request arrives. */
async function arrive(req: SharePanelRequest = request()): Promise<void> {
  await act(async () => {
    await openSharePanel(req)
  })
  await settle()
  runAll()
}

beforeEach(() => {
  vi.useFakeTimers()
  frames.install()
  frames.now = 1000
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
  invoke.mockClear()
  Object.assign(window, { zen: { invoke, on: () => () => undefined } })
  reducedMotion(false)
  host(true)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  act(() =>
    uiStore.set({
      menu: null,
      sharePanel: null,
      shareSeam: null,
      snapshot: null,
      snapshotTabId: null
    })
  )
  browserStore.set({ state: null })
  invoke.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (window as { matchMedia?: unknown }).matchMedia
  act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
})

describe("the app menu's Share row below Android 14 (the seam's first half: the gather)", () => {
  it('runs the pick with the sheet standing – the host gathers before the menu is let go (§9.38) – and tells the host of no close', async () => {
    await show()
    expect(sheets()).toHaveLength(1)
    await pickShare()
    expect(commands('menu.click')).toEqual([{ menuId: 'menu_1', itemId: 'menu_1_4' }])
    expect(commands('menu.close')).toEqual([])
    expect(uiStore.get().menu?.id).toBe('menu_1')
    expect(uiStore.get().shareSeam).toEqual({
      phase: 'gathering',
      menuId: 'menu_1',
      itemId: 'menu_1_4'
    })
    // The sheet stands where it was, still the menu's.
    expect(sheets()).toHaveLength(1)
    expect(rowByText('Print…')).toBeTruthy()
    expect(topBackSurface()?.name).toBe('menu')
  })

  it('holds the rows inert while it gathers: another row picked meanwhile runs nothing', async () => {
    await show()
    await pickShare()
    click(rowByText('Print…'))
    await settle()
    runAll()
    expect(commands('menu.click')).toEqual([{ menuId: 'menu_1', itemId: 'menu_1_4' }])
    expect(uiStore.get().menu?.id).toBe('menu_1')
  })

  it("shows §9.30's busy sign on the tapped Share row once the gather has run 150 ms – the 16 spinner in its trailing slot and aria-busy, the row and the others at full opacity, never disabled – and the guard stands", async () => {
    await show()
    await pickShare()
    const share = rowByText('Share…')
    const spinnerOf = (row: HTMLElement): Element | null => row.querySelector('svg.animate-spin')
    // Nothing yet: a fast host's request would be in before the sign.
    expect(share.getAttribute('aria-busy')).toBeNull()
    expect(spinnerOf(share)).toBeNull()
    elapse(SHARE_SEAM_BUSY_MS - 1)
    expect(share.getAttribute('aria-busy')).toBeNull()
    expect(spinnerOf(share)).toBeNull()
    elapse(1)
    await settle()
    expect(share.getAttribute('aria-busy')).toBe('true')
    const spinner = spinnerOf(share)!
    expect(spinner).not.toBeNull()
    // The row's trailing slot, at 16 (the phone's glyph is 20), hidden from the tree.
    expect(share.lastElementChild).toBe(spinner)
    expect(spinner.classList.contains('h-4')).toBe(true)
    expect(spinner.classList.contains('w-4')).toBe(true)
    expect(spinner.getAttribute('aria-hidden')).toBe('true')
    // The label stays in the flow: busy is not disabled, and no row is dimmed or disabled for it.
    expect(share.textContent).toBe('Share…')
    expect(rows().filter((row) => row.hasAttribute('aria-busy'))).toEqual([share])
    for (const row of rows()) {
      expect(row.getAttribute('aria-disabled')).toBeNull()
      expect(row.classList.contains('opacity-40')).toBe(false)
    }
    expect(rowByText('Print…').disabled).toBe(false)
    expect(uiStore.get().menu?.id).toBe('menu_1')
    expect(handle()).toBe('Resize menu')
    // The 4 s guard runs on as before, the busy row leaving with the menu.
    elapse(SHARE_SEAM_GUARD_MS - SHARE_SEAM_BUSY_MS)
    await settle()
    expect(uiStore.get().menu).toBeNull()
    expect(uiStore.get().shareSeam).toBeNull()
  })

  it('shows no sign for a gather that is over inside 150 ms: the hand-off carries no spinner', async () => {
    await show()
    await pickShare()
    elapse(SHARE_SEAM_BUSY_MS - 50)
    await arrive()
    expect(qa('[aria-busy]')).toHaveLength(0)
    expect(qa('svg.animate-spin')).toHaveLength(0)
    // The armed timer was let go with the gather: past its hour, with the rows' copy still
    // fading, no sign appears in the copy or the panel.
    elapse(SHARE_SEAM_OUT_MS / 2)
    await settle()
    expect(qa('.zen-share-seam-out')).toHaveLength(2)
    expect(qa('[aria-busy]')).toHaveLength(0)
    expect(qa('svg.animate-spin')).toHaveLength(0)
    elapse(SHARE_SEAM_OUT_MS)
    await settle()
    expect(qa('.zen-share-seam-out')).toHaveLength(0)
    expect(qa('[aria-busy]')).toHaveLength(0)
  })

  it("lets the busy row fade with the rows' copy at the hand-off – the sign goes with the seam, not before, and the panel's own rows carry none", async () => {
    await show()
    await pickShare()
    elapse(SHARE_SEAM_BUSY_MS)
    await settle()
    expect(rowByText('Share…').getAttribute('aria-busy')).toBe('true')
    await arrive()
    const copy = q('.zen-share-seam > .zen-share-seam-out')!
    const shareCopy = [...copy.querySelectorAll<HTMLElement>('.zen-sheet-item')].find(
      (row) => row.textContent === 'Share…'
    )!
    expect(shareCopy.getAttribute('aria-busy')).toBe('true')
    expect(shareCopy.querySelector('svg.animate-spin')).not.toBeNull()
    // Every busy row is in the inert copy; the panel's content has none.
    expect(qa('[aria-busy]').every((el) => el.closest('.zen-share-seam-out') !== null)).toBe(true)
    expect(q('.zen-share-seam-in [aria-busy]')).toBeNull()
    expect(q('.zen-share-seam-in svg.animate-spin')).toBeNull()
    elapse(SHARE_SEAM_OUT_MS)
    await settle()
    expect(qa('[aria-busy]')).toHaveLength(0)
    expect(qa('svg.animate-spin')).toHaveLength(0)
  })

  it('lets the menu leave on the guard when no request comes (a share the host refused), as a pick would have had it', async () => {
    await show()
    await pickShare()
    elapse(SHARE_SEAM_GUARD_MS - 1)
    expect(uiStore.get().menu?.id).toBe('menu_1')
    elapse(1)
    await settle()
    expect(uiStore.get().menu).toBeNull()
    expect(uiStore.get().shareSeam).toBeNull()
    expect(commands('menu.close')).toEqual([])
  })

  it('picks the row as any other where the system sheet is the share sheet (Android 14 and later): the sheet leaves first, then the pick runs', async () => {
    host(false)
    await show()
    click(rowByText('Share…'))
    await settle()
    expect(uiStore.get().shareSeam).toBeNull()
    runAll()
    // The pick goes out once the sheet has been unpainted (two frames on), the menu gone.
    act(() => frames.run(2))
    expect(uiStore.get().menu).toBeNull()
    expect(commands('menu.click')).toEqual([{ menuId: 'menu_1', itemId: 'menu_1_4' }])
  })
})

describe('the hand-off (the seam’s second half: the menu’s chassis becomes the panel’s)', () => {
  it("draws the menu's own request in the same sheet element: the header the preview, the body the panel's rows, one sheet and no second", async () => {
    await show()
    const chassis = sheet()!
    await pickShare()
    await arrive()
    expect(uiStore.get().shareSeam).toEqual({
      phase: 'hosting',
      menuId: 'menu_1',
      panelId: 'share-panel-1'
    })
    expect(uiStore.get().sharePanel?.id).toBe('share-panel-1')
    // The same element, now the panel's; the panel's own layer stands aside.
    expect(sheets()).toHaveLength(1)
    expect(sheet()).toBe(chassis)
    expect(chassis.classList.contains('zen-share-panel')).toBe(true)
    expect(chassis.querySelector('.zen-sheet-header > .zen-share-panel-preview')).not.toBeNull()
    expect(
      chassis.querySelector('.zen-share-panel-preview .zen-menu-link-title')?.textContent
    ).toBe('Example Domain')
    expect(chassis.querySelector('.zen-share-panel-preview .zen-menu-link-url')?.textContent).toBe(
      'https://example.com/'
    )
    expect(
      [...chassis.querySelectorAll<HTMLElement>('[data-row="chips"] .zen-share-panel-cell')].map(
        (c) => c.dataset.kind
      )
    ).toEqual(['copy', 'qr', 'screenshot', 'print'])
    expect(
      [...chassis.querySelectorAll<HTMLElement>('[data-row="apps"] .zen-share-panel-cell')].map(
        (c) => c.querySelector('.zen-share-panel-caption')?.textContent
      )
    ).toEqual(['Alpha', 'Beta', 'More'])
    // The preview names the sheet, as the title did.
    const heading = chassis.querySelector('.zen-share-panel-preview .zen-menu-link-title')!
    expect(chassis.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(handle()).toBe('Dismiss')
    expect(topBackSurface()?.name).toBe('share-panel')
  })

  it("fades the menu's rows and title out where they stood – once more, inert, over 120 ms – as the panel rises", async () => {
    await show()
    await pickShare()
    await arrive()
    const out = qa('.zen-share-seam-out')
    expect(out).toHaveLength(2)
    for (const layerEl of out) {
      expect(layerEl.hasAttribute('inert')).toBe(true)
      expect(layerEl.getAttribute('aria-hidden')).toBe('true')
    }
    const bodyOut = q('.zen-share-seam > .zen-share-seam-out')!
    expect(bodyOut.querySelector('.zen-sheet-item')?.textContent).toBe('Share…')
    const titleOut = q('.zen-sheet-header > .zen-share-seam-out[data-title]')!
    expect(titleOut.textContent).toBe('Zenium')
    expect(q('.zen-share-seam-in [data-row="chips"]')).not.toBeNull()
    expect(q('.zen-sheet-header > .zen-share-panel-preview.zen-share-seam-in')).not.toBeNull()
    elapse(SHARE_SEAM_OUT_MS)
    await settle()
    expect(qa('.zen-share-seam-out')).toHaveLength(0)
    expect(q('.zen-share-seam-in [data-row="chips"]')).not.toBeNull()
  })

  it("draws the fading rows where the list was scrolled to when Share was tapped – the chassis starts the panel's content at its top", async () => {
    await show()
    const scroller = q<HTMLElement>('.zen-sheet-scroll')!
    scroller.scrollTop = 180
    await pickShare()
    await arrive()
    const copy = q<HTMLElement>('.zen-share-seam > .zen-share-seam-out > .zen-share-seam-scrolled')!
    expect(copy.style.transform).toBe('translateY(-180px)')
    expect(copy.querySelector('.zen-sheet-item')?.textContent).toBe('Share…')
  })

  it('draws the fading rows unshifted when the list stood at its top', async () => {
    await show()
    await pickShare()
    await arrive()
    const copy = q<HTMLElement>('.zen-share-seam > .zen-share-seam-out > .zen-share-seam-scrolled')!
    expect(copy.style.transform).toBe('')
  })

  it('cuts under reduced motion: no outgoing layer, the panel simply where the rows were', async () => {
    reducedMotion(true)
    await show()
    await pickShare()
    await arrive()
    expect(qa('.zen-share-seam-out')).toHaveLength(0)
    expect(q('.zen-share-seam [data-row="apps"]')).not.toBeNull()
    expect(sheets()).toHaveLength(1)
  })

  it('answers the host once the sheet has left and closes the menu with the panel – the host hears the answer and no menu.close', async () => {
    await show()
    await pickShare()
    await arrive()
    const beta = qa<HTMLElement>('[data-row="apps"] .zen-share-panel-cell')[1]
    expect(beta.dataset.component).toBe('com.example.b/.Share')
    click(beta)
    await settle()
    runAll()
    expect(commands('share.panelAction')).toEqual([
      { id: 'share-panel-1', kind: 'target', component: 'com.example.b/.Share' }
    ])
    expect(uiStore.get().sharePanel).toBeNull()
    expect(uiStore.get().shareSeam).toBeNull()
    expect(uiStore.get().menu).toBeNull()
    expect(commands('menu.close')).toEqual([])
  })

  it('dismisses the panel to the page on Escape (the back gesture’s way too): the share released, the menu gone', async () => {
    await show()
    await pickShare()
    await arrive()
    escape()
    await settle()
    runAll()
    expect(commands('share.panelAction')).toEqual([{ id: 'share-panel-1', kind: 'dismiss' }])
    expect(uiStore.get().menu).toBeNull()
    expect(uiStore.get().sharePanel).toBeNull()
    expect(uiStore.get().shareSeam).toBeNull()
    expect(commands('menu.close')).toEqual([])
  })

  it("lets a page's request rise in the panel's own sheet, the gathering menu let go", async () => {
    await show()
    await pickShare()
    await arrive(request({ id: 'share-panel-9', source: 'page' }))
    expect(uiStore.get().shareSeam).toBeNull()
    expect(uiStore.get().menu).toBeNull()
    expect(uiStore.get().sharePanel?.id).toBe('share-panel-9')
    expect(commands('menu.close')).toEqual([])
    // The panel's own layer draws it, not the menu's (which is on its way out).
    expect(q('.zen-share-panel [data-row="apps"]')).not.toBeNull()
    expect(q('.zen-share-panel .zen-share-seam')).toBeNull()
  })

  it("takes a hosted panel down with the seam when a page's request supersedes it: no frame draws the older request on its own while the page's cover is captured", async () => {
    await show()
    await pickShare()
    await arrive()
    expect(uiStore.get().shareSeam?.phase).toBe('hosting')
    // The newer request's sheet waits on the page's capture; the host let the older share go
    // when it took the newer one, so the older panel must not stand meanwhile.
    let capture!: (data: string) => void
    const captured = new Promise<string>((resolve) => {
      capture = resolve
    })
    invoke.mockImplementation((name) =>
      name === 'overlay.snapshot' ? captured : Promise.resolve(undefined)
    )
    let opened!: Promise<void>
    act(() => {
      opened = openSharePanel(request({ id: 'share-panel-9', source: 'page' }))
    })
    await settle()
    runAll()
    try {
      expect(commands('overlay.snapshot')).toHaveLength(1)
      expect(qa('.zen-share-panel')).toHaveLength(0)
      expect(sheets()).toHaveLength(1)
      expect(uiStore.get().sharePanel).toBeNull()
      expect(uiStore.get().shareSeam).toBeNull()
      expect(uiStore.get().menu).toBeNull()
      // The chrome answers nothing for the older panel: its supersession is the host's own.
      expect(commands('share.panelAction')).toEqual([])
      expect(commands('menu.close')).toEqual([])
    } finally {
      // The capture comes in whatever was found (left pending it would hold the next test's).
      await act(async () => {
        capture('data:image/png;base64,PAGE9')
        await opened
      })
    }
    await settle()
    runAll()
    expect(uiStore.get().sharePanel?.id).toBe('share-panel-9')
    expect(qa('.zen-share-panel')).toHaveLength(1)
    expect(q('.zen-share-panel [data-row="apps"]')).not.toBeNull()
    expect(q('.zen-share-panel .zen-share-seam')).toBeNull()
    expect(topBackSurface()?.name).toBe('share-panel')
    expect(commands('share.panelAction')).toEqual([])
  })

  it('hosts nothing for a menu that did not ask: a request arriving at a standing menu with no gather rises on its own', async () => {
    await show()
    await arrive()
    expect(uiStore.get().shareSeam).toBeNull()
    expect(uiStore.get().sharePanel?.id).toBe('share-panel-1')
    // The menu stands untouched and the panel is its own sheet over it (the host superseded a share).
    expect(uiStore.get().menu?.id).toBe('menu_1')
    expect(q('.zen-share-panel .zen-share-seam')).toBeNull()
  })
})
