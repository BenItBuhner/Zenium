// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HintBubble } from '@renderer/lib/iph'

/*
 * The in-product help bubble on the message layer (TB-19; HintBubbleCard.tsx, MessageLayer.tsx,
 * stack.ts): placed once as it goes up – its `left` puts the arrow under the anchor inside the
 * layer's insets, the arrow's tip kept off the corners – a status region with Chrome's sentence,
 * the page clipped out from under it on the bar's edge for as long as it is up, through its fade.
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
const { hintArrowX, hintBubbleLeft, hintCoverFor, HINT_ARROW_HEIGHT, MESSAGE_INSET } =
  await import('../stack')
const {
  dismissHintBubble,
  forgetHintBubble,
  HINT_BUBBLE_EXIT_MS,
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
  it('centres the bubble on the anchor and keeps it inside the insets', () => {
    expect(hintBubbleLeft(200, 300, 400)).toBe(50)
    expect(hintBubbleLeft(20, 300, 400)).toBe(MESSAGE_INSET)
    expect(hintBubbleLeft(390, 300, 400)).toBe(400 - MESSAGE_INSET - 300)
    // A bubble wider than the layer sits at the left inset.
    expect(hintBubbleLeft(200, 500, 400)).toBe(MESSAGE_INSET)
  })

  it("puts the arrow's tip under the anchor, off the corners", () => {
    expect(hintArrowX(200, 50, 300)).toBe(150)
    expect(hintArrowX(10, 8, 300)).toBe(18)
    expect(hintArrowX(395, 92, 300)).toBe(282)
  })

  it('covers the card, its arrow and the inset over it, nothing while unmeasured', () => {
    expect(hintCoverFor(HEIGHT)).toBe(HEIGHT + HINT_ARROW_HEIGHT + MESSAGE_INSET)
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
    expect(card.textContent).toBe(TAB_SWITCHER_HINT_TEXT)
    expect(card.dataset.edge).toBe('bottom')
    expect(card.dataset.anchor).toBe('tabs')
    expect(card.dataset.leaving).toBeUndefined()
    // The anchor's centre in the layer: 296 + 22 − 12 = 306; the card clamps to the right inset.
    const left = LAYER_WIDTH - MESSAGE_INSET - WIDTH
    expect(card.style.left).toBe(`${left}px`)
    expect(card.style.getPropertyValue('--zen-hint-arrow-x')).toBe(`${306 - left}px`)
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
