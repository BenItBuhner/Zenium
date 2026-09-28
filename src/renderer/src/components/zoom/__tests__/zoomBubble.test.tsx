// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_CONTAINER_ID, type Space, type Tab, type UIState } from '@shared/types'
import { DEFAULT_PAGE_CONTROLS, DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))

import { browserStore } from '@renderer/lib/browserStore'
import { closeAllPopovers, openPopoverCount } from '@renderer/lib/portals'
import { openZoomBubble, showZoomBubble, uiStore } from '@renderer/lib/ui'
import { ZoomBubble } from '../ZoomBubble'
import { ZoomChip } from '../ZoomChip'

/*
 * The desktop's zoom bubble under the pill's zoom chip (zoom/ZoomBubble.tsx, §9.20) and the
 * changes that take the chip away (W8-F12). The design lead's rulings:
 *
 * Round one – "Reset takes the page to 100 % and at 100 % the zoom chip unmounts (§9.29), so a
 * bubble re-opened by `zoom.changed` after Reset hangs from nothing, which §9.20 forbids ('the
 * popover does not detach from what opened it') — Reset ends the bubble with its chip; drop the
 * re-open on the reset it performed (one line where `zoom.changed` re-raises it); Chrome's clocked
 * post-change zoom notice is NOT owed (the chip's presence tells the deviation)."
 *
 * Round two – "PASS on the Reset fix. The three roads are RULED ALIKE. showZoomBubble reads the
 * chip's presence and raises nothing when there's no chip to hang from, on every road:
 * Ctrl+0/Cmd+0, the menu and context-menu resets, a step landing on 100%, and the wheel. Chrome's
 * 100% notice isn't owed; the chip leaving the pill and the page resizing are the feedback."
 *
 * The main's side is played here as it answers a `tab.setZoom`: the state push with the tab's new
 * zoom (`browserStore`, which the chip follows) and the `zoom.changed` event (`useMainEvents` →
 * `showZoomBubble`). One rule, the chip's own (`isZoomed`, zoom/bubble.ts): a change that leaves
 * the chip raises or re-raises the bubble; one that leaves none raises nothing and ends the bubble
 * standing – whichever road brought it: the bubble's Reset, Ctrl+0, a step, the wheel.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'a'

const page: Tab = {
  id: TAB_ID,
  url: 'https://a.example/',
  containerId: DEFAULT_CONTAINER_ID,
  title: 'a',
  favicon: null,
  loading: false,
  zoom: 1.25
} as unknown as Tab

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: DEFAULT_CONTAINER_ID,
  theme: null,
  tabIds: [TAB_ID],
  activeTabId: TAB_ID,
  pinnedCollapsed: false
}

/** The chrome's state with the tab at `zoom`; `defaultZoom` is the settings' default for web pages. */
function stateAt(zoom: number, defaultZoom = 1): UIState {
  const tab = { ...page, zoom } as Tab
  return {
    platform: 'linux',
    capabilities: {},
    tabs: { [TAB_ID]: tab },
    spaces: [space],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    shortcuts: [],
    media: [],
    glance: null,
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    settings: { pageControls: { ...DEFAULT_PAGE_CONTROLS, zoom: defaultZoom } },
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT
  } as unknown as UIState
}

/**
 * The chrome around the bubble: the pill's zoom chip (which goes at the default zoom, §9.29),
 * the Share chip as the next anchor a press lands on, and the bubble mounted from `ui.zoomBubble`
 * as `TabDialogs` mounts it.
 */
function Chrome({ state, onShare }: { state: UIState; onShare: () => void }): JSX.Element {
  const bubble = uiStore.use((s) => s.zoomBubble)
  const tab = state.tabs[TAB_ID]
  return (
    <div className="zen-pill">
      <ZoomChip state={state} tab={tab} />
      <button type="button" data-share-chip="" onClick={onShare}>
        share
      </button>
      {bubble && <ZoomBubble state={state} bubble={bubble} />}
    </div>
  )
}

let root: Root | null = null
let mount: HTMLElement | null = null
const onShare = vi.fn()

/** The main's state push: the store the chrome reads (`showZoomBubble` too) and the chrome drawn from it. */
function render(state: UIState): void {
  browserStore.set({ state })
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(<Chrome state={state} onShare={onShare} />))
}

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector)
const bubble = (): HTMLElement | null => q('[data-zoom-bubble]')
const chip = (): HTMLElement | null => q('[data-zoom-chip]')
const level = (): string | null => q('#zen-zoom-level')?.textContent ?? null
const button = (name: string): HTMLButtonElement =>
  [...bubble()!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name
  )!

/** The chrome layer drew the bubble and its first paint settled. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The main's `zoom.changed` for the tab, as `useMainEvents` hands it to `showZoomBubble`. */
async function zoomChanged(factor: number): Promise<void> {
  await act(async () => {
    await showZoomBubble(TAB_ID, factor)
  })
  await settle()
}

/** The main's answer to a change: the state at the new zoom, then its `zoom.changed`. */
async function mainZoomsTo(factor: number, defaultZoom = 1): Promise<void> {
  render(stateAt(factor, defaultZoom))
  await zoomChanged(factor)
}

/** A full press on a chrome control: down and up, then the click the browser synthesises. */
function press(target: Element): Record<string, Event> {
  const events: Record<string, Event> = {}
  const fire = (e: Event): void => {
    act(() => {
      target.dispatchEvent(e)
    })
    events[e.type] = e
  }
  fire(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
  fire(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  fire(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
  fire(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  fire(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return events
}

/** The chip's bubble, as the chip's press opens it: it stays, the keyboard inside (§9.22). */
async function openFromChip(factor: number): Promise<void> {
  await act(async () => {
    await openZoomBubble(TAB_ID, factor)
  })
  await settle()
  expect(bubble()).not.toBeNull()
  expect(uiStore.get().zoomBubble?.source).toBe('chip')
}

/** The bubble's Reset pressed (`tab.setZoom null`), and the main's answer at the default. */
async function resetFromBubble(defaultZoom = 1): Promise<void> {
  press(button('Reset'))
  expect(run).toHaveBeenCalledWith('tab.setZoom', { tabId: TAB_ID, delta: null })
  await mainZoomsTo(defaultZoom, defaultZoom)
}

/** Ctrl+wheel over the bubble's picture of the page: one notch, in (up) or out. */
function wheel(direction: 'in' | 'out'): void {
  const e = new WheelEvent('wheel', {
    deltaY: direction === 'in' ? -60 : 60,
    bubbles: true,
    cancelable: true
  })
  // happy-dom's WheelEvent drops the modifier the browser's carries.
  Object.defineProperty(e, 'ctrlKey', { value: true })
  act(() => {
    bubble()!.dispatchEvent(e)
  })
}

function escape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** Nothing stands: no bubble in the store or the document, no popover registered. */
function expectNothingUp(): void {
  expect(uiStore.get().zoomBubble).toBeNull()
  expect(bubble()).toBeNull()
  expect(chip()).toBeNull()
  expect(openPopoverCount()).toBe(0)
}

/** The first press on the Share chip is its own: every event unconsumed, its click run. */
function expectSharePressLands(): void {
  const events = press(q('[data-share-chip]')!)
  for (const [name, e] of Object.entries(events)) {
    expect(e.defaultPrevented, `${name} of the first press on Share`).toBe(false)
  }
  expect(onShare).toHaveBeenCalledTimes(1)
}

beforeEach(() => {
  cmd.mockClear()
  run.mockReset()
  onShare.mockReset()
  uiStore.set({ zoomBubble: null, snapshot: null, snapshotTabId: null })
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ zoomBubble: null, snapshot: null, snapshotTabId: null })
  browserStore.set({ state: null })
  // The swallow of a consumed press ends a tick after its release.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the zoom bubble’s Reset ends the bubble with its chip (W8-F12, §9.20 / §9.29)', () => {
  it('a step’s bubble: Reset → the `zoom.changed` at the default mounts NO bubble, and the chip is gone', async () => {
    render(stateAt(1.25))
    // A zoom step's own bubble (`zoom.changed` at 125 %), the chip standing beside it.
    await zoomChanged(1.25)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('125%')
    expect(chip()).not.toBeNull()
    expect(openPopoverCount()).toBe(1)

    await resetFromBubble()
    // Reset ends the bubble with its chip: nothing is re-raised at 100 %, and no popover is open
    // to hang from the place the chip left.
    expectNothingUp()
    // The page's picture went with the bubble, and the keyboard goes back to the page.
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('the chip’s bubble (it stays until put away): Reset ends it the same way', async () => {
    render(stateAt(1.25))
    await openFromChip(1.25)
    expect(chip()!.getAttribute('aria-expanded')).toBe('true')

    await resetFromBubble()
    expectNothingUp()
  })

  it('after a reset, the next change that leaves a chip raises a fresh bubble', async () => {
    render(stateAt(1.25))
    await zoomChanged(1.25)
    await resetFromBubble()
    expectNothingUp()
    // The user zooms again: a fresh step's bubble, with its chip.
    await mainZoomsTo(1.1)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('110%')
    expect(chip()).not.toBeNull()
    expect(uiStore.get().zoomBubble).toMatchObject({ tabId: TAB_ID, factor: 1.1, seq: 0 })
  })

  it('#644’s sequence without the swallow: zoom → Reset → Escape → the FIRST press on Share lands whole', async () => {
    render(stateAt(1.25))
    await zoomChanged(1.25)
    // The chip's bubble, as W8-F7 had it up: the keyboard inside.
    act(() => uiStore.set({ zoomBubble: null }))
    await settle()
    await openFromChip(1.25)
    expect(bubble()!.contains(document.activeElement)).toBe(true)

    await resetFromBubble()
    // No re-opened bubble: none for Escape to close, none for the Share press to dismiss.
    expectNothingUp()
    escape()
    expect(openPopoverCount()).toBe(0)
    // §9.20's light dismiss had nothing to close: the press is the Share chip's own.
    expectSharePressLands()
  })
})

describe('the three roads ruled alike (W8-F12 round two): a change that leaves no chip raises no bubble and ends the one standing', () => {
  it('Ctrl+0 with no bubble up: nothing rises – no bubble, no popover, no picture of the page asked for', async () => {
    render(stateAt(1.25))
    expect(chip()).not.toBeNull()
    // Ctrl+0 / Cmd+0, the app menu's and the context menu's Reset Zoom: the main resets and says so.
    await mainZoomsTo(1)
    expectNothingUp()
    expect(cmd).not.toHaveBeenCalledWith('overlay.snapshot', expect.anything())
    // The chip leaving the pill and the page resizing are the feedback; nothing to put away.
    escape()
    expect(openPopoverCount()).toBe(0)
    expectSharePressLands()
  })

  it('Ctrl+0 with the chip’s bubble up (W8-F7’s road): the bubble closes with its chip, nothing is re-raised, the next press lands whole', async () => {
    render(stateAt(1.25))
    await openFromChip(1.25)
    expect(bubble()!.contains(document.activeElement)).toBe(true)
    expect(openPopoverCount()).toBe(1)

    await mainZoomsTo(1)
    expectNothingUp()
    // The keyboard goes back to the page with the bubble (no chip left to hand it to).
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    // Nothing under the Share press: it is the chip's own – the W8-F7 swallow is gone on this road.
    expectSharePressLands()
  })

  it('Ctrl+0 with a step’s bubble up: the bubble closes with its chip instead of standing 5 s over nothing', async () => {
    render(stateAt(1.25))
    await zoomChanged(1.25)
    // A button of the bubble was used: on its own the bubble would now stand 5 s.
    press(button('Zoom in'))
    expect(run).toHaveBeenCalledWith('tab.setZoom', { tabId: TAB_ID, delta: 1 })
    await mainZoomsTo(1.5)
    expect(level()).toBe('150%')

    await mainZoomsTo(1)
    expectNothingUp()
  })

  it('a step arriving at the default: with none up nothing rises; the standing bubble closes with its chip', async () => {
    // Ctrl+plus from 90 %: the main lands on 100 %. No chip, no bubble.
    render(stateAt(0.9))
    await mainZoomsTo(1)
    expectNothingUp()

    // The bubble's own + from 90 %: the main lands on 100 % and the bubble ends with the chip.
    await mainZoomsTo(0.9)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('90%')
    press(button('Zoom in'))
    expect(run).toHaveBeenCalledWith('tab.setZoom', { tabId: TAB_ID, delta: 1 })
    await mainZoomsTo(1)
    expectNothingUp()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('the wheel landing on the default: Ctrl+wheel over the bubble asks the step, the main lands on 100 %, the bubble ends with the chip; over the page with none up, nothing rises', async () => {
    render(stateAt(0.9))
    await zoomChanged(0.9)
    expect(bubble()).not.toBeNull()
    // Ctrl+wheel over the bubble's picture keeps zooming: one notch up is one step in.
    wheel('in')
    expect(run).toHaveBeenCalledWith('tab.setZoom', { tabId: TAB_ID, delta: 1 })
    await mainZoomsTo(1)
    expectNothingUp()

    // Ctrl+wheel over the live page (the main's `zoom-changed` → `adjustZoom`) from 90 % lands
    // on 100 % with no bubble up: nothing rises.
    run.mockReset()
    await mainZoomsTo(0.9)
    // The notch's own bubble ran its clock out; the chip stands for the 90 %.
    act(() => uiStore.set({ zoomBubble: null }))
    await settle()
    expect(bubble()).toBeNull()
    expect(chip()).not.toBeNull()
    await mainZoomsTo(1)
    expectNothingUp()

    // And a notch that leaves a chip raises the bubble as before.
    await mainZoomsTo(1.1)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('110%')
    expect(chip()).not.toBeNull()
    wheel('out')
    expect(run).toHaveBeenCalledWith('tab.setZoom', { tabId: TAB_ID, delta: -1 })
  })

  it('a change that leaves a chip still raises the bubble: a step opens it, the next re-raises it (the clock restarts), and it stands until its clock', async () => {
    render(stateAt(1.1))
    await zoomChanged(1.1)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('110%')
    expect(chip()).not.toBeNull()
    expect(uiStore.get().zoomBubble).toMatchObject({ tabId: TAB_ID, factor: 1.1, seq: 0 })
    expect(openPopoverCount()).toBe(1)
    // Another step while it is up re-raises it: the level follows, the clock restarts (`seq`).
    await mainZoomsTo(1.25)
    expect(level()).toBe('125%')
    expect(uiStore.get().zoomBubble).toMatchObject({ factor: 1.25, seq: 1 })
    // A step down that still leaves a chip: re-raised again, not closed.
    await mainZoomsTo(1.1)
    expect(level()).toBe('110%')
    expect(uiStore.get().zoomBubble).toMatchObject({ factor: 1.1, seq: 2 })
    expect(chip()).not.toBeNull()
  })

  it('the rule is the chip’s, not 100 %: with the default zoom at 110 %, a step to 100 % leaves a chip and raises the bubble; the reset to 110 % raises none', async () => {
    // The settings' default zoom is 110 % (the page's default for every site without an exception).
    render(stateAt(1.1, 1.1))
    expect(chip()).toBeNull()
    // Ctrl+minus: the page at 100 % is AWAY from its default – the chip stands, the bubble comes.
    await mainZoomsTo(1, 1.1)
    expect(chip()).not.toBeNull()
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('100%')
    expect(button('Reset').disabled).toBe(false)
    // Reset takes it to 110 %, the default: the chip goes and the bubble ends with it.
    await resetFromBubble(1.1)
    expectNothingUp()
    // Ctrl+0 with none up, from 90 % to the 110 % default: nothing rises.
    await mainZoomsTo(0.9, 1.1)
    act(() => uiStore.set({ zoomBubble: null }))
    await settle()
    await mainZoomsTo(1.1, 1.1)
    expectNothingUp()
  })

  it('the chip’s rule is read against the change itself: a `zoom.changed` that runs ahead of its state push still ends the bubble', async () => {
    render(stateAt(1.25))
    await openFromChip(1.25)
    // The event arrives first (the store still says 125 %): the rule reads the event's factor.
    await zoomChanged(1)
    expect(uiStore.get().zoomBubble).toBeNull()
    expect(bubble()).toBeNull()
    expect(openPopoverCount()).toBe(0)
    // The push follows: the chip goes.
    render(stateAt(1))
    expectNothingUp()
  })
})
