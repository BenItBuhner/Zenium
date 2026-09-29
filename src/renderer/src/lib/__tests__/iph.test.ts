import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IPH_STATE, IPH_TAB_SWITCHER_AVAILABILITY_DAYS } from '@shared/iph'
import type { HintBubble } from '../iph'

/*
 * The phone's in-product help model (TB-19, lib/iph.ts): Chrome 152's `IPH_TabSwitcherButton`
 * rules on one device-local record – available 14 days, one education per session, never
 * again once shown or once the button was used – and the bubble store's life: up, leaving on
 * Chrome's 200 ms fade, gone at the sweep.
 */

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const {
  armIph,
  dismissHintBubble,
  forgetHintBubble,
  HINT_BUBBLE_EXIT_MS,
  hintBubbleEdge,
  hintBubbleStore,
  hintBubbleUp,
  IPH_ARM_DELAY_MS,
  iphSessionSpent,
  markTabSwitcherHintShown,
  noteTabSwitcherButtonUsed,
  resetIphSession,
  showHintBubble,
  spendIphSession,
  stampTabSwitcherHint,
  TAB_SWITCHER_HINT_ACCESSIBILITY_TEXT,
  TAB_SWITCHER_HINT_TEXT,
  tabSwitcherHintDue
} = await import('../iph')

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const settings = (
  tabSwitcher: Partial<{ availableAt: number | null; shown: boolean }> = {},
  onboardingDone = true
): { onboardingDone: boolean; iph: Pick<typeof DEFAULT_IPH_STATE, 'tabSwitcher'> } => ({
  onboardingDone,
  iph: { tabSwitcher: { availableAt: NOW - 15 * DAY, shown: false, ...tabSwitcher } }
})

/** The moment is right in every other way. */
const ready = {
  now: NOW,
  armed: true,
  calm: true,
  pageLoaded: true,
  privateTab: false,
  sessionSpent: false
}

const BUBBLE: HintBubble = {
  id: 'tabSwitcher',
  anchorItem: 'tabs',
  anchor: { x: 300, y: 860, width: 44, height: 44 },
  edge: 'bottom',
  text: TAB_SWITCHER_HINT_TEXT
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(run).mockClear()
  resetIphSession()
  forgetHintBubble()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Chrome's words", () => {
  it('are the grd strings verbatim', () => {
    expect(TAB_SWITCHER_HINT_TEXT).toBe('Open tabs to visit different pages at the same time')
    expect(TAB_SWITCHER_HINT_ACCESSIBILITY_TEXT).toBe(
      'To open tabs and visit different pages at the same time, tap the open tabs button'
    )
  })
})

describe('the tab switcher bubble is due', () => {
  it('when the first run is over, the record available 14 days and unspent, the moment right', () => {
    expect(tabSwitcherHintDue({ settings: settings(), ...ready })).toBe(true)
  })

  it('never inside the availability window, nor on a record with no stamp yet', () => {
    expect(IPH_TAB_SWITCHER_AVAILABILITY_DAYS).toBe(14)
    expect(
      tabSwitcherHintDue({ settings: settings({ availableAt: NOW - 13 * DAY }), ...ready })
    ).toBe(false)
    expect(
      tabSwitcherHintDue({ settings: settings({ availableAt: NOW - 14 * DAY }), ...ready })
    ).toBe(true)
    expect(tabSwitcherHintDue({ settings: settings({ availableAt: null }), ...ready })).toBe(false)
  })

  it('never once shown – the button used counts as shown', () => {
    expect(tabSwitcherHintDue({ settings: settings({ shown: true }), ...ready })).toBe(false)
  })

  it('never during the first run, in a private tab, before a page has loaded, or before the arm', () => {
    expect(tabSwitcherHintDue({ settings: settings({}, false), ...ready })).toBe(false)
    expect(tabSwitcherHintDue({ settings: settings(), ...ready, privateTab: true })).toBe(false)
    expect(tabSwitcherHintDue({ settings: settings(), ...ready, pageLoaded: false })).toBe(false)
    expect(tabSwitcherHintDue({ settings: settings(), ...ready, armed: false })).toBe(false)
  })

  it('never while the chrome is busy – a sheet, a dialog, the omnibox, the overview, a drag', () => {
    expect(tabSwitcherHintDue({ settings: settings(), ...ready, calm: false })).toBe(false)
  })
})

describe('one education per session', () => {
  it("is spent by any education – the gesture hint's toast, a promo – and read by default", () => {
    expect(iphSessionSpent()).toBe(false)
    expect(tabSwitcherHintDue({ settings: settings(), ...ready, sessionSpent: undefined })).toBe(
      true
    )
    spendIphSession()
    expect(iphSessionSpent()).toBe(true)
    expect(tabSwitcherHintDue({ settings: settings(), ...ready, sessionSpent: undefined })).toBe(
      false
    )
    expect(tabSwitcherHintDue({ settings: settings(), ...ready, sessionSpent: true })).toBe(false)
  })
})

describe("the record's writes", () => {
  it('stamps the availability clock once, on a record with no stamp, and leaves any other alone', () => {
    expect(stampTabSwitcherHint(settings({ availableAt: null }), NOW)).toBe(true)
    expect(run).toHaveBeenCalledWith('settings.update', {
      iph: { tabSwitcher: { availableAt: NOW, shown: false } }
    })
    vi.mocked(run).mockClear()
    expect(stampTabSwitcherHint(settings(), NOW)).toBe(false)
    expect(stampTabSwitcherHint(settings({ availableAt: null, shown: true }), NOW)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('marks the bubble shown, keeping the stamp, once', () => {
    markTabSwitcherHintShown(settings())
    expect(run).toHaveBeenCalledWith('settings.update', {
      iph: { tabSwitcher: { availableAt: NOW - 15 * DAY, shown: true } }
    })
    vi.mocked(run).mockClear()
    markTabSwitcherHintShown(settings({ shown: true }))
    expect(run).not.toHaveBeenCalled()
  })

  it("spends the record on the Tabs button's tap after the first run – Chrome's used event", () => {
    noteTabSwitcherButtonUsed(settings({ availableAt: null }))
    expect(run).toHaveBeenCalledWith('settings.update', {
      iph: { tabSwitcher: { availableAt: null, shown: true } }
    })
    vi.mocked(run).mockClear()
    noteTabSwitcherButtonUsed(settings({}, false))
    noteTabSwitcherButtonUsed(settings({ shown: true }))
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the deferred arm', () => {
  it('runs in an idle moment after the two seconds, never sooner', () => {
    const idle: Array<() => void> = []
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
      idle.push(cb)
      return idle.length
    })
    vi.stubGlobal('cancelIdleCallback', vi.fn())
    const armed = vi.fn()
    armIph(armed)
    vi.advanceTimersByTime(IPH_ARM_DELAY_MS - 1)
    expect(idle).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(idle).toHaveLength(1)
    expect(armed).not.toHaveBeenCalled()
    idle[0]!()
    expect(armed).toHaveBeenCalledTimes(1)
  })

  it('falls back to a macrotask after the delay where the idle callback is missing', () => {
    vi.stubGlobal('requestIdleCallback', undefined)
    const armed = vi.fn()
    armIph(armed)
    vi.advanceTimersByTime(IPH_ARM_DELAY_MS - 1)
    expect(armed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    vi.runOnlyPendingTimers()
    expect(armed).toHaveBeenCalledTimes(1)
  })

  it('is cancelled by the returned function at either stage', () => {
    const cancelIdle = vi.fn()
    vi.stubGlobal('requestIdleCallback', () => 7)
    vi.stubGlobal('cancelIdleCallback', cancelIdle)
    const armed = vi.fn()
    const early = armIph(armed)
    early()
    vi.advanceTimersByTime(IPH_ARM_DELAY_MS * 2)
    expect(armed).not.toHaveBeenCalled()
    const late = armIph(armed)
    vi.advanceTimersByTime(IPH_ARM_DELAY_MS)
    late()
    expect(cancelIdle).toHaveBeenCalledWith(7)
  })
})

describe('the bubble on screen', () => {
  it('goes up at once, leaves on the 200 ms fade and is gone at the sweep', () => {
    expect(hintBubbleUp()).toBe(false)
    showHintBubble(BUBBLE)
    expect(hintBubbleStore.get()).toEqual({ bubble: BUBBLE, leaving: false })
    dismissHintBubble()
    expect(hintBubbleStore.get()).toEqual({ bubble: BUBBLE, leaving: true })
    expect(hintBubbleUp()).toBe(true)
    vi.advanceTimersByTime(HINT_BUBBLE_EXIT_MS - 1)
    expect(hintBubbleStore.get().bubble).toBe(BUBBLE)
    vi.advanceTimersByTime(1)
    expect(hintBubbleStore.get()).toEqual({ bubble: null, leaving: false })
    expect(hintBubbleUp()).toBe(false)
  })

  it('dismisses once: a second dismissal and one with nothing up do nothing', () => {
    dismissHintBubble()
    expect(hintBubbleStore.get()).toEqual({ bubble: null, leaving: false })
    showHintBubble(BUBBLE)
    dismissHintBubble()
    const leaving = hintBubbleStore.get()
    dismissHintBubble()
    expect(hintBubbleStore.get()).toBe(leaving)
  })

  it('is forgotten outright when the shell leaves, its sweep cancelled', () => {
    showHintBubble(BUBBLE)
    dismissHintBubble()
    forgetHintBubble()
    expect(hintBubbleStore.get()).toEqual({ bubble: null, leaving: false })
    showHintBubble({ ...BUBBLE, edge: 'top' })
    vi.advanceTimersByTime(HINT_BUBBLE_EXIT_MS)
    expect(hintBubbleEdge(hintBubbleStore.get().bubble)).toBe('top')
  })
})
