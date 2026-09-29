import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HintBubble } from '../iph'

vi.mock('@renderer/lib/api', () => ({
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const {
  forgetHintBubble,
  hintBubbleBarItem,
  hintBubbleEdge,
  hintBubbleStore,
  hintBubbleTabId,
  markTabGroupsDragHintShown,
  overviewGroupsHintDue,
  requestOverviewGroupsHint,
  resetIphSession,
  showHintBubble,
  TAB_GROUPS_DRAG_HINT_TEXT,
  TAB_SWITCHER_HINT_TEXT,
  takeOverviewGroupsHintRequest
} = await import('../iph')

const NOW = 1_800_000_000_000

const settings = (
  record: Partial<{ availableAt: number | null; shown: boolean }> = {}
): { iph: { tabGroupsDragAndDrop: { availableAt: number | null; shown: boolean } } } => ({
  iph: { tabGroupsDragAndDrop: { availableAt: null, shown: false, ...record } }
})

/** The overview at rest with a card to point at, opened by the tip. */
const ready = { fromTip: true, open: true, hasAnchor: true }

const BAR_BUBBLE: HintBubble = {
  id: 'tabSwitcher',
  anchorItem: 'tabs',
  anchor: { x: 300, y: 860, width: 44, height: 44 },
  edge: 'bottom',
  text: TAB_SWITCHER_HINT_TEXT
}

const CARD_BUBBLE: HintBubble = {
  id: 'tabGroupsDragAndDrop',
  at: 'overview',
  tabId: 't1',
  anchor: { x: 12, y: 120, width: 164, height: 200 },
  text: TAB_GROUPS_DRAG_HINT_TEXT
}

beforeEach(() => {
  vi.mocked(run).mockClear()
  resetIphSession()
  forgetHintBubble()
  takeOverviewGroupsHintRequest()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the overview bubble's words", () => {
  it("are Chrome's dialog folded into one sentence, the hold kept, no full stop (the bubbles carry none)", () => {
    expect(TAB_GROUPS_DRAG_HINT_TEXT).toBe(
      'Touch and hold a tab, then drag it onto another to group them'
    )
    // Two lines inside the bubble's 288 at 15/400: the sentence is under the Tabs bubble's
    // accessibility variant's length, which the same card holds on two lines.
    expect(TAB_GROUPS_DRAG_HINT_TEXT.length).toBeLessThan(80)
  })
})

describe("the tips card's request", () => {
  it('is left by Try it now and taken once – a second take reads nothing', () => {
    expect(takeOverviewGroupsHintRequest()).toBe(false)
    requestOverviewGroupsHint()
    expect(takeOverviewGroupsHintRequest()).toBe(true)
    expect(takeOverviewGroupsHintRequest()).toBe(false)
  })

  it('two taps before an opening are one request', () => {
    requestOverviewGroupsHint()
    requestOverviewGroupsHint()
    expect(takeOverviewGroupsHintRequest()).toBe(true)
    expect(takeOverviewGroupsHintRequest()).toBe(false)
  })
})

describe('the overview bubble is due', () => {
  it('when the tip opened the overview, the record is unspent, the overview at rest with a card to point at', () => {
    expect(overviewGroupsHintDue({ settings: settings(), ...ready })).toBe(true)
  })

  it("never on an overview the tip did not open – the Tabs button's, the pill's pull, a swipe (Chrome's own trigger is off by default and is a message card, not this)", () => {
    expect(overviewGroupsHintDue({ settings: settings(), ...ready, fromTip: false })).toBe(false)
  })

  it('never once spent – the bubble has been up on this device', () => {
    expect(overviewGroupsHintDue({ settings: settings({ shown: true }), ...ready })).toBe(false)
    expect(
      overviewGroupsHintDue({ settings: settings({ availableAt: NOW, shown: true }), ...ready })
    ).toBe(false)
  })

  it('never before the overview rests, nor with no loose card to stand on', () => {
    expect(overviewGroupsHintDue({ settings: settings(), ...ready, open: false })).toBe(false)
    expect(overviewGroupsHintDue({ settings: settings(), ...ready, hasAnchor: false })).toBe(false)
  })

  it("keeps no availability clock – Chrome's is ANY for this feature – and a stamp changes nothing", () => {
    expect(
      overviewGroupsHintDue({ settings: settings({ availableAt: NOW - 1000 }), ...ready })
    ).toBe(true)
    expect(overviewGroupsHintDue({ settings: settings({ availableAt: NOW }), ...ready })).toBe(true)
  })
})

describe("the record's writes", () => {
  it('marks the bubble shown as a one-bubble patch, stamping the day it was spent, once', () => {
    markTabGroupsDragHintShown(settings(), NOW)
    expect(run).toHaveBeenCalledWith('settings.update', {
      iph: { tabGroupsDragAndDrop: { availableAt: NOW, shown: true } }
    })
    // A stamp already there is kept.
    vi.mocked(run).mockClear()
    markTabGroupsDragHintShown(settings({ availableAt: NOW - 5000 }), NOW)
    expect(run).toHaveBeenCalledWith('settings.update', {
      iph: { tabGroupsDragAndDrop: { availableAt: NOW - 5000, shown: true } }
    })
    // Spent is spent.
    vi.mocked(run).mockClear()
    markTabGroupsDragHintShown(settings({ shown: true }), NOW)
    expect(run).not.toHaveBeenCalled()
  })

  it("the patch names its own record alone – the Tabs button's is not carried along", () => {
    markTabGroupsDragHintShown(settings(), NOW)
    const patch = vi.mocked(run).mock.calls[0]?.[1] as { iph: Record<string, unknown> }
    expect(Object.keys(patch.iph)).toEqual(['tabGroupsDragAndDrop'])
  })
})

describe('the two anchor kinds', () => {
  it("a bar bubble's literal is #641's, no `at`: it has an edge and a bar item, no card", () => {
    expect(hintBubbleEdge(BAR_BUBBLE)).toBe('bottom')
    expect(hintBubbleBarItem(BAR_BUBBLE)).toBe('tabs')
    expect(hintBubbleTabId(BAR_BUBBLE)).toBeNull()
    expect('at' in BAR_BUBBLE).toBe(false)
  })

  it('an overview bubble has a card and sits on no bar edge and no bar item', () => {
    expect(hintBubbleEdge(CARD_BUBBLE)).toBeNull()
    expect(hintBubbleBarItem(CARD_BUBBLE)).toBeNull()
    expect(hintBubbleTabId(CARD_BUBBLE)).toBe('t1')
  })

  it('no bubble answers null to all three', () => {
    expect(hintBubbleEdge(null)).toBeNull()
    expect(hintBubbleBarItem(null)).toBeNull()
    expect(hintBubbleTabId(null)).toBeNull()
  })

  it('the store holds one bubble of either kind at a time, the later replacing the earlier outright', () => {
    showHintBubble(BAR_BUBBLE)
    expect(hintBubbleStore.get().bubble).toBe(BAR_BUBBLE)
    showHintBubble(CARD_BUBBLE)
    expect(hintBubbleStore.get()).toEqual({ bubble: CARD_BUBBLE, leaving: false })
  })
})
