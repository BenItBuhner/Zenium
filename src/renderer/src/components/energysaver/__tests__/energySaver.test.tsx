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
  ENERGY_SAVER_TITLE,
  ENERGY_SAVER_TURN_OFF,
  energySaverDetail,
  energySaverLeafFits,
  energySaverLeafUp,
  energySaverOn,
  energySaverUi,
  openEnergySaverBubble
} from '@renderer/lib/energySaver'
import { mediaHubButtonFits, mediaHubReturnRow } from '@renderer/lib/mediaHub'
import { viewportStore } from '@renderer/lib/formFactor'
import { closeAllPopovers } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { EnergySaverBubbleLayer, TURN_OFF_DETAIL } from '../EnergySaverBubble'
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

  it('says what the mode does here in Zenium’s words, with the factor Settings › Performance holds', () => {
    expect(energySaverDetail(stateWith({ batteryFactor: 0.7 }))).toBe(
      'Zenium shrinks its memory, CPU and GPU budgets to 70%, so background tabs are throttled and unloaded sooner.'
    )
    expect(energySaverDetail(stateWith({ batteryFactor: 0.25 }))).toMatch(/to 25%,/)
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
    expect(dialog.querySelector<HTMLElement>('p')!.textContent).toBe(
      'Zenium shrinks its memory, CPU and GPU budgets to 50%, so background tabs are throttled and unloaded sooner.'
    )
    // Chrome's cancel button as a menu-style row below the hairline, its line saying what
    // "now" means; Chrome's OK is the light dismiss and has no row.
    const row = dialog.querySelector<HTMLElement>('[data-energy-saver-off]')!
    expect(row.tagName).toBe('BUTTON')
    expect(row.classList.contains('zen-v2-row')).toBe(true)
    expect(row.textContent).toBe(`Turn off now${TURN_OFF_DETAIL}`)
    expect(TURN_OFF_DETAIL).toBe('Until the next time your computer is unplugged.')
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
