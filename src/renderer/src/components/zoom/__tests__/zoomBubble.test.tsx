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

import { closeAllPopovers, openPopoverCount } from '@renderer/lib/portals'
import { openZoomBubble, showZoomBubble, uiStore } from '@renderer/lib/ui'
import { ZoomBubble } from '../ZoomBubble'
import { ZoomChip } from '../ZoomChip'

/*
 * The desktop's zoom bubble under the pill's zoom chip (zoom/ZoomBubble.tsx, §9.20) and its
 * Reset (W8-F12). The design lead's ruling: "Reset takes the page to 100 % and at 100 % the zoom
 * chip unmounts (§9.29), so a bubble re-opened by `zoom.changed` after Reset hangs from nothing,
 * which §9.20 forbids ('the popover does not detach from what opened it') — Reset ends the bubble
 * with its chip; drop the re-open on the reset it performed (one line where `zoom.changed`
 * re-raises it); Chrome's clocked post-change zoom notice is NOT owed (the chip's presence tells
 * the deviation)."
 *
 * The main's side is played here as it answers a `tab.setZoom`: the state push with the tab's new
 * zoom (the chip follows it) and the `zoom.changed` event (`useMainEvents` → `showZoomBubble`).
 * Only the change the bubble's own Reset asked for ends the bubble; a step's or a shortcut's
 * change raises it as before – the other paths to 100 % are the lead's to rule, not this slice's.
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

function stateAt(zoom: number): UIState {
  const tab = { ...page, zoom } as Tab
  return {
    platform: 'linux',
    capabilities: {},
    tabs: { [TAB_ID]: tab },
    spaces: [space],
    activeSpaceId: 'space',
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    settings: { pageControls: DEFAULT_PAGE_CONTROLS },
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

function render(state: UIState): void {
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
const resetButton = (): HTMLButtonElement =>
  [...bubble()!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Reset'
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

/** The bubble's Reset pressed, and the main's answer: the state at 100 % and its `zoom.changed`. */
async function resetFromBubble(): Promise<void> {
  press(resetButton())
  expect(run).toHaveBeenCalledWith('tab.setZoom', { tabId: TAB_ID, delta: null })
  render(stateAt(1))
  await zoomChanged(1)
}

function escape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
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
  // The swallow of a consumed press ends a tick after its release.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the zoom bubble’s Reset ends the bubble with its chip (W8-F12, §9.20 / §9.29)', () => {
  it('a step’s bubble: Reset → the `zoom.changed` at 100 % mounts NO bubble, and the chip is gone', async () => {
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
    expect(uiStore.get().zoomBubble).toBeNull()
    expect(bubble()).toBeNull()
    expect(chip()).toBeNull()
    expect(openPopoverCount()).toBe(0)
    // The page's picture went with the bubble, and the keyboard goes back to the page.
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('the chip’s bubble (it stays until put away): Reset ends it the same way', async () => {
    render(stateAt(1.25))
    await act(async () => {
      await openZoomBubble(TAB_ID, 1.25)
    })
    await settle()
    expect(bubble()).not.toBeNull()
    expect(uiStore.get().zoomBubble?.source).toBe('chip')
    expect(chip()!.getAttribute('aria-expanded')).toBe('true')

    await resetFromBubble()
    expect(uiStore.get().zoomBubble).toBeNull()
    expect(bubble()).toBeNull()
    expect(chip()).toBeNull()
    expect(openPopoverCount()).toBe(0)
  })

  it('a `zoom.changed` that is not the bubble’s own Reset raises the bubble as before – a step, and a shortcut’s reset to 100 %', async () => {
    render(stateAt(1.1))
    // A step (Ctrl+plus, Ctrl+wheel, the menu): the bubble comes up for it.
    await zoomChanged(1.1)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('110%')
    expect(uiStore.get().zoomBubble).toMatchObject({ tabId: TAB_ID, factor: 1.1, seq: 0 })
    // Another step while it is up re-raises it: the level follows, the clock restarts (`seq`).
    render(stateAt(1.25))
    await zoomChanged(1.25)
    expect(level()).toBe('125%')
    expect(uiStore.get().zoomBubble).toMatchObject({ factor: 1.25, seq: 1 })

    // A reset the bubble did not perform – Ctrl+0, the menu – while the bubble is up: not this
    // slice's to change. The bubble is re-raised at 100 % as before (flagged for the lead).
    render(stateAt(1))
    await zoomChanged(1)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('100%')
    expect(uiStore.get().zoomBubble).toMatchObject({ factor: 1, seq: 2 })
    expect(chip()).toBeNull()

    // And with no bubble up, a shortcut's reset to 100 % opens one as before.
    act(() => uiStore.set({ zoomBubble: null }))
    await settle()
    expect(bubble()).toBeNull()
    await zoomChanged(1)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('100%')
    expect(uiStore.get().zoomBubble).toMatchObject({ tabId: TAB_ID, factor: 1, source: 'auto' })
  })

  it('the mark is the one tab’s and the one change’s: the next `zoom.changed` for the tab raises the bubble again', async () => {
    render(stateAt(1.25))
    await zoomChanged(1.25)
    await resetFromBubble()
    expect(bubble()).toBeNull()
    // The user zooms again: a fresh step's bubble, with its chip.
    render(stateAt(1.1))
    await zoomChanged(1.1)
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('110%')
    expect(chip()).not.toBeNull()
  })

  it('#644’s sequence without the swallow: zoom → Reset → Escape → the FIRST press on Share lands whole', async () => {
    render(stateAt(1.25))
    await zoomChanged(1.25)
    // The chip's bubble, as W8-F7 had it up: the keyboard inside.
    act(() => uiStore.set({ zoomBubble: null }))
    await settle()
    await act(async () => {
      await openZoomBubble(TAB_ID, 1.25)
    })
    await settle()
    expect(bubble()).not.toBeNull()
    expect(bubble()!.contains(document.activeElement)).toBe(true)

    await resetFromBubble()
    // No re-opened bubble: none for Escape to close, none for the Share press to dismiss.
    expect(bubble()).toBeNull()
    expect(openPopoverCount()).toBe(0)
    escape()
    expect(openPopoverCount()).toBe(0)

    // The first press on the Share chip is its own: every event of it reaches the chip
    // unconsumed and its click runs – §9.20's light dismiss had nothing to close.
    const events = press(q('[data-share-chip]')!)
    for (const [name, e] of Object.entries(events)) {
      expect(e.defaultPrevented, `${name} of the first press on Share`).toBe(false)
    }
    expect(onShare).toHaveBeenCalledTimes(1)
  })
})

describe('FLAGGED for the design lead (W8-F12 §3): the other paths to 100 % – read here, not changed', () => {
  /*
   * Ctrl+0 / Cmd+0, a step that arrives at 100 % (Ctrl+plus from 90 %, the bubble's own + and −,
   * Ctrl+wheel over the page), the page context menu's Reset Zoom, the app menu's Reset Zoom and
   * the macOS menu bar's Actual Size all reach the main's `tabs.resetZoom` / `adjustZoom` and
   * come back as a `zoom.changed` at the default. None is the bubble's own Reset, so
   * `showZoomBubble` takes the path it always took: the open bubble re-raised at 100 % on the
   * chip's last place (until dismissed, for the chip's bubble; 5 s once a button was used), or a
   * fresh 1.5 s notice at the pill's trailing end – the chip gone by §9.29 either way, the bubble
   * over nothing that opened it. §9.20's light dismiss consumes the press that closes it: W8-F7's
   * swallow, whose drive reset by `tab.setZoom null` – this path, not the bubble's Reset (#644,
   * leg B). The lead ruled the Reset path alone; these stand as they are and are pinned as they
   * are, so a ruling on them has its red test ready to flip.
   */
  it('REPRO: Ctrl+0 with the chip’s bubble up leaves a 100 % bubble standing with no chip until a press closes it – and that press is consumed', async () => {
    render(stateAt(1.25))
    await act(async () => {
      await openZoomBubble(TAB_ID, 1.25)
    })
    await settle()
    expect(chip()).not.toBeNull()
    // Ctrl+0 (the keyboard's, the menu's, the context menu's): the main resets and says so.
    render(stateAt(1))
    await zoomChanged(1)
    expect(chip()).toBeNull()
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('100%')
    expect(uiStore.get().zoomBubble).toMatchObject({ source: 'chip', factor: 1 })
    expect(resetButton().disabled).toBe(true)
    expect(openPopoverCount()).toBe(1)
    // The press that closes it – on the Share chip – goes no further (§9.20 kept).
    const events = press(q('[data-share-chip]')!)
    expect(events.pointerdown.defaultPrevented).toBe(true)
    expect(events.click.defaultPrevented).toBe(true)
    expect(onShare).not.toHaveBeenCalled()
    await settle()
    expect(uiStore.get().zoomBubble).toBeNull()
  })

  it('REPRO: a step arriving at 100 % (Ctrl+plus from 90 %, the bubble’s own +) re-raises the bubble at 100 % with no chip; with none up, Ctrl+0 raises a fresh 1.5 s notice with no chip', async () => {
    render(stateAt(0.9))
    await zoomChanged(0.9)
    expect(chip()).not.toBeNull()
    // The bubble's own + from 90 %: the main lands on 100 % and says so.
    const plus = [...bubble()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label') === 'Zoom in'
    )!
    press(plus)
    expect(run).toHaveBeenCalledWith('tab.setZoom', { tabId: TAB_ID, delta: 1 })
    render(stateAt(1))
    await zoomChanged(1)
    expect(chip()).toBeNull()
    expect(bubble()).not.toBeNull()
    expect(level()).toBe('100%')
    expect(uiStore.get().zoomBubble).toMatchObject({ source: 'auto', factor: 1, seq: 1 })

    // No bubble up, the page zoomed: Ctrl+0 from the keyboard opens the notice at 100 %.
    act(() => uiStore.set({ zoomBubble: null }))
    await settle()
    await zoomChanged(1)
    expect(chip()).toBeNull()
    expect(bubble()).not.toBeNull()
    expect(uiStore.get().zoomBubble).toMatchObject({ source: 'auto', factor: 1, seq: 0 })
  })
})
