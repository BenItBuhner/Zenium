// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HintBubble } from '@renderer/lib/iph'

/*
 * The in-product help bubble on the message layer (TB-19; HintBubbleCard.tsx, MessageLayer.tsx,
 * stack.ts): §9.20's anchored pose without Chrome's arrow (the lead's (a) on #641) – placed once
 * as it goes up, its `left` end-aligning it with the anchor's box inside the layer's insets, flush
 * against the bar band's edge at gap 0 – a status region with Chrome's sentence that the anchor
 * names as its description (`HINT_BUBBLE_ID`, the lead's (j)), the page clipped out from under it
 * on the bar's edge for as long as it is up, through its fade.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { HintBubbleCard } = await import('../HintBubbleCard')
const { MessageLayer } = await import('../MessageLayer')
const { hintBubbleLeft, hintCoverFor, HINT_BUBBLE_PADDING, HINT_BUBBLE_WIDTH, MESSAGE_INSET } =
  await import('../stack')
const {
  dismissHintBubble,
  forgetHintBubble,
  HINT_BUBBLE_EXIT_MS,
  HINT_BUBBLE_ID,
  showHintBubble,
  TAB_SWITCHER_HINT_TEXT
} = await import('@renderer/lib/iph')
const { claimMessageCards, coverBandStore, uiStore } = await import('@renderer/lib/ui')

const LAYER_LEFT = 12
const LAYER_WIDTH = 388
const WIDTH = 300
const HEIGHT = 44

const BUBBLE: HintBubble = {
  id: 'tabSwitcher',
  anchorItem: 'tabs',
  // The Tabs button towards the right end of a bottom bar.
  anchor: { x: 296, y: 860, width: 44, height: 44 },
  edge: 'bottom',
  text: TAB_SWITCHER_HINT_TEXT
}

let root: Root | null = null
let host: HTMLDivElement | null = null
let releaseCards: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => WIDTH
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => HEIGHT
  })
  host = document.createElement('div')
  host.className = 'zen-message-layer'
  host.getBoundingClientRect = () =>
    ({ left: LAYER_LEFT, width: LAYER_WIDTH, top: 0, height: 800 }) as DOMRect
  document.body.appendChild(host)
  root = createRoot(host)
  forgetHintBubble()
  uiStore.set({ toasts: [], banners: [], screenshotCards: [] })
  coverBandStore.set({ top: 0, bottom: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  releaseCards?.()
  releaseCards = null
  forgetHintBubble()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
  vi.useRealTimers()
})

describe('the placement', () => {
  it("end-aligns the bubble with the anchor's box and keeps it inside the insets", () => {
    // The anchor's right edge at 350: a 300 bubble's right edge sits there.
    expect(hintBubbleLeft(350, 300, 400)).toBe(50)
    // An anchor too near the left edge: slid to the left inset, no flip.
    expect(hintBubbleLeft(120, 300, 400)).toBe(MESSAGE_INSET)
    // An anchor past the right inset: slid back to it.
    expect(hintBubbleLeft(398, 300, 400)).toBe(400 - MESSAGE_INSET - 300)
    // A bubble wider than the layer allows sits at the left inset.
    expect(hintBubbleLeft(200, 500, 400)).toBe(MESSAGE_INSET)
  })

  it("is §9.20's notice width: 320, the sentence on two lines at 288", () => {
    // The stylesheet's `width` and `padding` are pinned to these two constants in
    // lib/__tests__/v2Tokens.test.ts; this is the arithmetic the lead's (c) states.
    expect(HINT_BUBBLE_WIDTH).toBe(320)
    expect(HINT_BUBBLE_PADDING).toBe(16)
    expect(HINT_BUBBLE_WIDTH - 2 * HINT_BUBBLE_PADDING).toBe(288)
  })

  it('covers the card at the edge and the inset over it, nothing while unmeasured', () => {
    expect(hintCoverFor(HEIGHT)).toBe(HEIGHT + MESSAGE_INSET)
    expect(hintCoverFor(0)).toBe(0)
  })
})

describe('the card', () => {
  it("is a status region with Chrome's sentence, placed once as it mounts", () => {
    const measured = vi.fn()
    act(() =>
      root!.render(
        createElement(HintBubbleCard, { bubble: BUBBLE, leaving: false, onMeasure: measured })
      )
    )
    const card = host!.querySelector<HTMLElement>('.zen-hint-bubble')!
    expect(card.getAttribute('role')).toBe('status')
    // The id the anchor's `aria-describedby` names while the bubble stands (PhoneShell.tsx).
    expect(card.id).toBe(HINT_BUBBLE_ID)
    expect(card.textContent).toBe(TAB_SWITCHER_HINT_TEXT)
    expect(card.dataset.edge).toBe('bottom')
    expect(card.dataset.anchor).toBe('tabs')
    expect(card.dataset.leaving).toBeUndefined()
    // The anchor's right edge in the layer: 296 + 44 − 12 = 328; the card's right edge sits on it.
    expect(card.style.left).toBe(`${328 - WIDTH}px`)
    // No arrow: nothing else is written on the element.
    expect(card.style.getPropertyValue('--zen-hint-arrow-x')).toBe('')
    expect(measured).toHaveBeenCalledWith(HEIGHT)
  })

  it('marks itself leaving for the fade', () => {
    act(() => root!.render(createElement(HintBubbleCard, { bubble: BUBBLE, leaving: true })))
    expect(host!.querySelector<HTMLElement>('.zen-hint-bubble')!.dataset.leaving).toBe('')
  })
})

describe('the layer', () => {
  it('draws the bubble and clips the page out from under it, through its fade', () => {
    releaseCards = claimMessageCards()
    act(() => root!.render(createElement(MessageLayer)))
    expect(host!.querySelector('.zen-message-layer')).toBeNull()
    act(() => showHintBubble(BUBBLE))
    expect(host!.querySelector('.zen-message-layer .zen-hint-bubble')).not.toBeNull()
    expect(coverBandStore.get()).toEqual({ top: 0, bottom: hintCoverFor(HEIGHT) })
    act(() => dismissHintBubble())
    expect(host!.querySelector<HTMLElement>('.zen-hint-bubble')!.dataset.leaving).toBe('')
    expect(coverBandStore.get().bottom).toBe(hintCoverFor(HEIGHT))
    act(() => vi.advanceTimersByTime(HINT_BUBBLE_EXIT_MS))
    expect(host!.querySelector('.zen-hint-bubble')).toBeNull()
    expect(coverBandStore.get()).toEqual({ top: 0, bottom: 0 })
  })

  it('puts a top-docked bar’s bubble on the top strip', () => {
    releaseCards = claimMessageCards()
    act(() => root!.render(createElement(MessageLayer)))
    act(() => showHintBubble({ ...BUBBLE, edge: 'top' }))
    expect(coverBandStore.get()).toEqual({ top: hintCoverFor(HEIGHT), bottom: 0 })
  })
})
