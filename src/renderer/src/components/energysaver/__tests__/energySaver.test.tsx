// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import {
  ENERGY_SAVER_DETAIL,
  ENERGY_SAVER_TITLE,
  ENERGY_SAVER_TURN_OFF,
  energySaverLeafFits,
  energySaverLeafUp,
  energySaverOn,
  energySaverUi,
  openEnergySaverBubble
} from '@renderer/lib/energySaver'
import { mediaHubButtonFits, mediaHubReturnRow } from '@renderer/lib/mediaHub'
import { viewportStore } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, closeAllPopovers, placePopover } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { EnergySaverBubbleLayer } from '../EnergySaverBubble'
import { EnergySaverButton } from '../EnergySaverButton'

/*
 * The desktop toolbar's Energy Saver leaf (W8-2, settings-29; Chrome's `BatterySaverButton` and
 * `BatterySaverBubbleView`): the button the row mounts while the governor says the mode is on,
 * named by Chrome's one line, and the 320 bubble under it – the leaf on the title, "Energy Saver
 * is on", Zenium's sentence on what that does, and Chrome's "Turn off now" as a row that asks
 * the governor for the battery session's off and closes. The bubble goes with the mode.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const page = { id: 't1', url: 'https://example.com/', title: 'Example' } as Tab

/** Enough of a snapshot for the leaf, the bubble and the stores that read every push. */
function stateWith({
  energySaver = true,
  batteryFactor = 0.7,
  pins = {}
}: {
  energySaver?: boolean
  batteryFactor?: number
  pins?: Record<string, boolean>
} = {}): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true },
    tabs: { t1: page },
    spaces: [{ id: 'space', activeTabId: 't1', tabIds: ['t1'], containerId: 'default' }],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    settings: { toolbarPins: pins, resources: { batteryFactor } },
    resources: { system: { onBattery: true, batteryPercent: 37, energySaver } },
    media: []
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

const leaf = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-zen-energy-saver-button]')
const bubble = (): HTMLElement | null => q('[data-testid="energy-saver-bubble"]')

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** The page's capture lands and the popover takes its first paint. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The leaf and the layer as the shell mounts them, the bubble opened from the leaf. */
async function open(state: UIState): Promise<void> {
  browserStore.set({ state })
  render(
    <>
      <EnergySaverButton />
      <EnergySaverBubbleLayer />
    </>
  )
  click(leaf())
  await settle()
}

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  energySaverUi.set({ open: false, fromKeyboard: false, leafUp: false })
  browserStore.set({ state: null })
  viewportStore.set({ formFactor: 'desktop' })
  vi.mocked(run).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the leaf’s reading of the snapshot (lib/energySaver)', () => {
  it('reads the mode off the governor’s word, never the setting, and off a partial state', () => {
    expect(energySaverOn(stateWith())).toBe(true)
    expect(energySaverOn(stateWith({ energySaver: false }))).toBe(false)
    // A state without the snapshot (a test's partial state): off, no throw.
    expect(energySaverOn({ settings: {} } as unknown as UIState)).toBe(false)
  })

  it('puts the leaf up while the mode is on and the control is pinned – an absent record pins it', () => {
    const on = stateWith()
    expect(energySaverLeafUp(on, undefined)).toBe(true)
    expect(energySaverLeafUp(on, {})).toBe(true)
    expect(energySaverLeafUp(on, { media: false })).toBe(true)
    expect(energySaverLeafUp(on, { 'energy-saver': false })).toBe(false)
    expect(energySaverLeafUp(stateWith({ energySaver: false }), {})).toBe(false)
  })

  it('tiers the leaf by the row’s width on the hub’s one rule: folded at the 240 sidebar, back at the 302 with the always-there buttons, 32 more a button (L2)', () => {
    // The 240 sidebar's row (its two 8 gutters aside) with back, forward, reload and ⋯: no room.
    expect(energySaverLeafFits(240 - 16, 4)).toBe(false)
    // The 302 sidebar: the 286 row is the pill's 126 plus five 32 slots – the leaf returns there,
    // over a pill that still holds the 110 box the star and the tools return at.
    expect(mediaHubReturnRow(4)).toBe(286)
    expect(energySaverLeafFits(285, 4)).toBe(false)
    expect(energySaverLeafFits(286, 4)).toBe(true)
    // A fifth button beside it (the puzzle piece, the downloads button) moves the return by 32.
    expect(energySaverLeafFits(286, 5)).toBe(false)
    expect(energySaverLeafFits(318, 5)).toBe(true)
    // The same floor as the hub's, in both directions, so the two buttons never disagree on
    // what the pill needs; an unmeasured row shows the leaf as it shows the hub's button.
    for (const [width, others] of [
      [0, 4],
      [224, 4],
      [285, 4],
      [286, 4],
      [317, 5],
      [318, 5],
      [400, 6]
    ]) {
      expect(energySaverLeafFits(width, others)).toBe(mediaHubButtonFits(width, others))
    }
    expect(energySaverLeafFits(0, 9)).toBe(true)
  })

  it('says what the mode does here in the user’s words and for how long, two lines of the 320 notice (N3, N4, L3)', () => {
    expect(ENERGY_SAVER_DETAIL).toBe(
      'Background tabs are slowed and unloaded sooner until you plug in.'
    )
    // Two lines at 15/20 in the title block's 260 column (about 34 characters a line), and no
    // word of the governor's – budgets, throttling – that names the implementation. The span is
    // the mode's true one – on battery, so until the charger – not the turn-off's "until the
    // next unplug", which was the row's line before L3 folded it here.
    expect(ENERGY_SAVER_DETAIL.length).toBeLessThanOrEqual(68)
    expect(ENERGY_SAVER_DETAIL).toMatch(/until you plug in\.$/)
    expect(ENERGY_SAVER_DETAIL).not.toMatch(/budget|governor|throttl|%|unplugged/)
    // Chrome's line and its button's label, verbatim (IDS_BATTERY_SAVER_BUBBLE_TITLE,
    // IDS_BATTERY_SAVER_SESSION_TURN_OFF in sentence case).
    expect(ENERGY_SAVER_TITLE).toBe('Energy Saver is on')
    expect(ENERGY_SAVER_TURN_OFF).toBe('Turn off now')
  })
})

describe('EnergySaverButton', () => {
  it('is the toolbar’s leaf, named and tipped by Chrome’s one line, saying what it has open', () => {
    render(<EnergySaverButton />)
    const button = leaf()!
    expect(button.classList.contains('zen-toolbar-button')).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Energy Saver is on')
    expect(button.getAttribute('data-tooltip')).toBe('Energy Saver is on')
    // The tooltip is the chrome's own (a11y-26), never a native `title`; and the name is the
    // whole of it – nothing said twice as a description.
    expect(button.hasAttribute('title')).toBe(false)
    expect(button.hasAttribute('aria-description')).toBe(false)
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.querySelector('svg.lucide-leaf')).not.toBeNull()
  })

  it('wears the toolbar button menu marks the row hands it – a pinnable control on the desktop bar, its right-click Chrome’s Unpin / Customise Toolbar… (W8-1, context-menus-112) – and none without them', () => {
    render(<EnergySaverButton />)
    let button = leaf()!
    expect(button.hasAttribute('data-zen-menu')).toBe(false)
    expect(button.hasAttribute('data-zen-menu-control')).toBe(false)
    render(
      <EnergySaverButton
        menuMarks={{ 'data-zen-menu': 'toolbar', 'data-zen-menu-control': 'energy-saver' }}
      />
    )
    button = leaf()!
    expect(button.getAttribute('data-zen-menu')).toBe('toolbar')
    expect(button.getAttribute('data-zen-menu-control')).toBe('energy-saver')
  })

  it('publishes its own standing from the commit that mounts or unmounts it – the row’s width tier folding it says so to the bubble (L2)', () => {
    expect(energySaverUi.get().leafUp).toBe(false)
    render(<EnergySaverButton />)
    expect(energySaverUi.get().leafUp).toBe(true)
    // The row's tier unmounts the leaf (a sidebar narrowed to 240): the word goes with it.
    render(<></>)
    expect(energySaverUi.get().leafUp).toBe(false)
  })

  it('opens and closes the bubble, wearing the pressed fill off aria-expanded while it is up', async () => {
    const state = stateWith()
    browserStore.set({ state })
    render(
      <>
        <EnergySaverButton />
        <EnergySaverBubbleLayer />
      </>
    )
    expect(bubble()).toBeNull()
    click(leaf())
    // Not before the page's picture is in place: the bubble overhangs the content frame.
    expect(bubble()).toBeNull()
    await settle()
    expect(bubble()).not.toBeNull()
    expect(uiStore.get().floatingChrome).toBe(1)
    expect(leaf()!.getAttribute('aria-expanded')).toBe('true')
    // The keyboard's press on the leaf closes it (a pointer's is the layer's light dismiss).
    click(leaf())
    expect(energySaverUi.get().open).toBe(false)
    await act(async () => {
      await vi.waitFor(() => expect(bubble()).toBeNull())
    })
    expect(uiStore.get().floatingChrome).toBe(0)
    expect(leaf()!.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('EnergySaverBubble', () => {
  it('stands at the leaf’s leading edge by §9.20’s flip, not a clamp (N6): the leaf in the row’s trailing half prefers end-alignment, which would cross the margin, so the box flips to start on the anchor', () => {
    // The first line's geometry: the leaf 28 × 28 at x 172 in the 302 sidebar's nav row (8–294),
    // the bubble 320 wide at 172–491 under the row.
    const leaf = { x: 172, y: 44, width: 28, height: 28 }
    const row = { x: 8, y: 38, width: 286, height: 36 }
    const box = placePopover(leaf, row, { width: 1600, height: 1000 }, POPOVER_WIDTH.list)
    expect(box).toMatchObject({ side: 'below', left: 172, top: 74, width: 320, alignment: 'start' })
    // (1) The leaf's centre (186) is past the row's (151): end-alignment is preferred – a box
    // ending on the leaf's trailing edge, at x −120, over the 8 px margin. (2) It flips to
    // start on the leaf's leading edge, 172, which fits; (3) the slide never ran – a slide would
    // have left the preferred alignment in place at the margin, x 8.
    expect(
      placePopover(leaf, row, { width: 1600, height: 1000 }, POPOVER_WIDTH.list, undefined, 'end')
    ).toMatchObject({ left: 172, alignment: 'start' })
    // Room on the leading side (the same leaf far along a wide bar): the end alignment holds.
    const wide = { x: 8, y: 38, width: 1500, height: 36 }
    const far = { ...leaf, x: 1200 }
    expect(
      placePopover(far, wide, { width: 1600, height: 1000 }, POPOVER_WIDTH.list)
    ).toMatchObject({ left: 1200 + 28 - 320, alignment: 'end' })
  })

  it('is a 320 dialog named by its title: the leaf on the title block, Chrome’s title, Zenium’s sentence, and Turn off now below a hairline', async () => {
    await open(stateWith({ batteryFactor: 0.5 }))
    const dialog = bubble()!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('zen-energy-saver-title')
    // §9.20's list width: the popover's own width is the 320 of the three.
    expect(dialog.style.width).toBe('320px')
    const title = dialog.querySelector<HTMLElement>('#zen-energy-saver-title')!
    expect(title.tagName).toBe('H2')
    expect(title.textContent).toBe('Energy Saver is on')
    expect(dialog.querySelector('svg.lucide-leaf')).not.toBeNull()
    expect(dialog.querySelector<HTMLElement>('p')!.textContent).toBe(ENERGY_SAVER_DETAIL)
    // Chrome's cancel button as a plain one-line action row below the hairline (pr-584 L3):
    // the label alone, no second line – what "now" spans is the sentence's – so the row is the
    // 32 of a one-line desktop row; Chrome's OK is the light dismiss and has no row.
    const row = dialog.querySelector<HTMLElement>('[data-energy-saver-off]')!
    expect(row.tagName).toBe('BUTTON')
    expect(row.classList.contains('zen-v2-row')).toBe(true)
    expect(row.textContent).toBe('Turn off now')
    // The text block holds the label alone: no `line-clamp-2` description under it.
    expect(row.children).toHaveLength(1)
    expect(row.firstElementChild!.children).toHaveLength(1)
    expect(row.querySelector('.line-clamp-2')).toBeNull()
    expect(row.previousElementSibling?.classList.contains('h-px')).toBe(true)
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      row.textContent
    ])
    // The keyboard lands on the panel, arming nothing (§9.22's container; Chrome's default
    // button is its no-op OK): Tab reaches the row.
    expect(document.activeElement).toBe(dialog)
  })

  it('Turn off now asks the governor for the battery session’s off and lets the bubble go; the setting is not written', async () => {
    await open(stateWith())
    click(bubble()!.querySelector('[data-energy-saver-off]'))
    const sent = vi.mocked(run).mock.calls.filter(([name]) => name !== 'focus.chrome')
    expect(sent).toEqual([['resources.energySaverSession', { disabled: true }]])
    expect(sent.some(([name]) => name === 'settings.update')).toBe(false)
    await act(async () => {
      await vi.waitFor(() => expect(energySaverUi.get().open).toBe(false))
    })
    expect(bubble()).toBeNull()
  })

  it('goes with the mode – the charger, the threshold, the setting – and with the leaf’s pin', async () => {
    await open(stateWith())
    expect(bubble()).not.toBeNull()
    // The governor's next sample says the mode is off (plugged in): the bubble spoke for a leaf
    // that is gone.
    act(() => browserStore.set({ state: stateWith({ energySaver: false }) }))
    await act(async () => {
      await vi.waitFor(() => expect(energySaverUi.get().open).toBe(false))
    })
    expect(bubble()).toBeNull()

    await open(stateWith())
    expect(bubble()).not.toBeNull()
    // The leaf unpinned while the bubble is up (the Customise toolbar dialog is a page under it).
    act(() => browserStore.set({ state: stateWith({ pins: { 'energy-saver': false } }) }))
    await act(async () => {
      await vi.waitFor(() => expect(energySaverUi.get().open).toBe(false))
    })
  })

  it('goes with the leaf the row’s width tier folds – no state push, the button’s own word (L2)', async () => {
    // The layer stands where `Root` mounts it, the leaf in the row beside it.
    const shell = (leafInRow: boolean): ReactElement => (
      <>
        <EnergySaverBubbleLayer />
        {leafInRow ? <EnergySaverButton /> : null}
      </>
    )
    browserStore.set({ state: stateWith() })
    render(shell(true))
    click(leaf())
    await settle()
    expect(bubble()).not.toBeNull()
    expect(energySaverUi.get().leafUp).toBe(true)
    // The row unmounts the leaf for want of width (the 240 sidebar): the same state, no push;
    // the bubble would otherwise float unanchored over a row with no leaf in it.
    render(shell(false))
    expect(leaf()).toBeNull()
    expect(energySaverUi.get().leafUp).toBe(false)
    await act(async () => {
      await vi.waitFor(() => expect(energySaverUi.get().open).toBe(false))
    })
    expect(bubble()).toBeNull()
  })

  it('opened from the keyboard, it asks the chrome for the focus and leaves the page without it (§9.22)', async () => {
    browserStore.set({ state: stateWith() })
    render(
      <>
        <EnergySaverButton />
        <EnergySaverBubbleLayer />
      </>
    )
    act(() => openEnergySaverBubble({ fromKeyboard: true }))
    await settle()
    expect(bubble()).not.toBeNull()
    expect(vi.mocked(run)).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(energySaverUi.get()).toEqual({ open: true, fromKeyboard: true, leafUp: true })
  })
})
