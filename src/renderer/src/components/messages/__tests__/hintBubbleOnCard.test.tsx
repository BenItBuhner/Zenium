// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HintBubble } from '@renderer/lib/iph'

/*
 * The in-product help bubble's second kind (TB-19, the tips card's seed): on a tab card in the
 * overview (`OverviewHintBubble`; HintBubbleCard.tsx, stack.ts `hintBubbleOnCard`) – §9.20's pose
 * against the card's box, flush under it at gap 0 and start-aligned, flipped above when the room
 * below runs out, placed once as it goes up; the same status region with the drag-to-group
 * sentence; on no bar edge, covering no page. The bar kind's pins live in hintBubble.test.tsx and
 * are untouched: the bar path is byte-equivalent.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { HintBubbleCard } = await import('../HintBubbleCard')
const { HINT_TAP_SETTLE_MS, releaseHeldTouch } = await import('../holdTouch')
const { MessageLayer } = await import('../MessageLayer')
const { hintBubbleOnCard, MESSAGE_INSET } = await import('../stack')
const {
  dismissHintBubble,
  forgetHintBubble,
  HINT_BUBBLE_ID,
  showHintBubble,
  TAB_GROUPS_DRAG_HINT_TEXT
} = await import('@renderer/lib/iph')
const { claimMessageCards, coverBandStore, uiStore } = await import('@renderer/lib/ui')

const LAYER = { left: 12, top: 40, width: 336, height: 700 }
const WIDTH = 320
const HEIGHT = 76

/** The first card of a two-column grid, window coordinates: 12 in from the layer's left. */
const CARD_BUBBLE: HintBubble = {
  id: 'tabGroupsDragAndDrop',
  at: 'overview',
  tabId: 't1',
  anchor: { x: LAYER.left + 12, y: LAYER.top + 60, width: 150, height: 190 },
  text: TAB_GROUPS_DRAG_HINT_TEXT
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
  host.getBoundingClientRect = () => LAYER as DOMRect
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
  releaseHeldTouch()
  forgetHintBubble()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
  vi.useRealTimers()
})

describe("the placement on a card (§9.20's pose, `hintBubbleOnCard`)", () => {
  const layer = { width: 400, height: 800 }
  const size = { width: 200, height: 60 }

  it('start-aligns with a card in the leading half, flush under it at gap 0', () => {
    const at = hintBubbleOnCard({ x: 20, y: 100, width: 150, height: 180 }, size, layer)
    expect(at).toEqual({ left: 20, top: 280, side: 'below' })
  })

  it('end-aligns with a card in the trailing half, as an anchor in the trailing half of its bar does', () => {
    const at = hintBubbleOnCard({ x: 230, y: 100, width: 150, height: 180 }, size, layer)
    expect(at).toEqual({ left: 230 + 150 - 200, top: 280, side: 'below' })
  })

  it('keeps an alignment that fits at either edge of the layer', () => {
    // A leading card at the very left: start-aligned on the inset.
    expect(hintBubbleOnCard({ x: 8, y: 100, width: 150, height: 180 }, size, layer).left).toBe(8)
    // A trailing card at the very right: end-aligned on the inset.
    expect(hintBubbleOnCard({ x: 242, y: 100, width: 150, height: 180 }, size, layer).left).toBe(
      392 - 200
    )
    // A narrow trailing card whose end-alignment starts inside the inset: kept where it is.
    expect(
      hintBubbleOnCard(
        { x: 210, y: 100, width: 30, height: 180 },
        { width: 230, height: 60 },
        layer
      ).left
    ).toBe(10)
  })

  it('slides the least distance that fits when neither alignment does – the phone’s two columns under a 320 bubble', () => {
    const phone = { width: 336, height: 700 }
    const bubble = { width: 320, height: 76 }
    // The left column: start-aligned would end at 332 > 328; end-aligned starts negative; slid.
    expect(hintBubbleOnCard({ x: 12, y: 60, width: 150, height: 190 }, bubble, phone).left).toBe(
      MESSAGE_INSET
    )
    // The right column: end-aligned starts at 4 < 8, start-aligned ends past the edge; slid.
    expect(hintBubbleOnCard({ x: 174, y: 60, width: 150, height: 190 }, bubble, phone).left).toBe(
      MESSAGE_INSET
    )
  })

  it('flips above the card when the room below is short and the room above is more', () => {
    const at = hintBubbleOnCard({ x: 20, y: 600, width: 150, height: 180 }, size, layer)
    expect(at).toEqual({ left: 20, top: 540, side: 'above' })
  })

  it('stays below and slides up when neither side has the room – never leaving the card', () => {
    const tall = { width: 200, height: 300 }
    const at = hintBubbleOnCard({ x: 20, y: 300, width: 150, height: 250 }, tall, layer)
    // Below: 250 of room; above: 292. Above is more but still short: the flip takes it, clamped.
    expect(at.side).toBe('above')
    expect(at.top).toBe(MESSAGE_INSET)
    // With less room above than below, kept below and slid up to the bottom inset.
    const low = hintBubbleOnCard({ x: 20, y: 100, width: 150, height: 500 }, tall, layer)
    expect(low).toEqual({ left: 20, top: layer.height - MESSAGE_INSET - 300, side: 'below' })
  })
})

describe('the card', () => {
  it("is the same status region with the drag-to-group sentence, placed once as `left` and `top` against the card's box", () => {
    const measured = vi.fn()
    act(() =>
      root!.render(
        createElement(HintBubbleCard, { bubble: CARD_BUBBLE, leaving: false, onMeasure: measured })
      )
    )
    const card = host!.querySelector<HTMLElement>('.zen-hint-bubble')!
    expect(card.getAttribute('role')).toBe('status')
    expect(card.id).toBe(HINT_BUBBLE_ID)
    expect(card.textContent).toBe(TAB_GROUPS_DRAG_HINT_TEXT)
    // The kind and the card it is about; no bar edge.
    expect(card.dataset.at).toBe('overview')
    expect(card.dataset.anchor).toBe('t1')
    expect(card.dataset.edge).toBeUndefined()
    // The card is at layer x 12, 150 wide, in the leading half; a 320 bubble fits neither
    // alignment in the 336 layer and slides to the inset. Flush under the card's bottom:
    // 60 + 190 = 250.
    expect(card.style.left).toBe(`${MESSAGE_INSET}px`)
    expect(card.style.top).toBe('250px')
    expect(card.dataset.side).toBe('below')
    expect(measured).toHaveBeenCalledWith(HEIGHT)
  })

  it('stands over a card low in the grid, and says so for its arrival', () => {
    const low: HintBubble = {
      ...CARD_BUBBLE,
      anchor: { x: LAYER.left + 12, y: LAYER.top + 480, width: 150, height: 190 }
    }
    act(() => root!.render(createElement(HintBubbleCard, { bubble: low, leaving: false })))
    const card = host!.querySelector<HTMLElement>('.zen-hint-bubble')!
    // Below: 700 − 8 − 670 = 22 of room, short of 76; above has 472: flipped, flush over the top.
    expect(card.style.top).toBe(`${480 - HEIGHT}px`)
    expect(card.dataset.side).toBe('above')
  })

  it('marks itself leaving for the fade, the pose kept', () => {
    act(() => root!.render(createElement(HintBubbleCard, { bubble: CARD_BUBBLE, leaving: true })))
    const card = host!.querySelector<HTMLElement>('.zen-hint-bubble')!
    expect(card.dataset.leaving).toBe('')
    expect(card.dataset.at).toBe('overview')
  })
})

describe('the layer', () => {
  it('draws the bubble on no edge and clips no page out from under it', () => {
    releaseCards = claimMessageCards()
    act(() => root!.render(createElement(MessageLayer)))
    act(() => showHintBubble(CARD_BUBBLE))
    expect(
      host!.querySelector<HTMLElement>('.zen-message-layer .zen-hint-bubble')!.dataset.at
    ).toBe('overview')
    expect(coverBandStore.get()).toEqual({ top: 0, bottom: 0 })
    act(() => dismissHintBubble())
    expect(coverBandStore.get()).toEqual({ top: 0, bottom: 0 })
  })
})

describe('the touch (a touch that begins on the bubble ends on it, `holdTouch`)', () => {
  /** The bubble over the grid's last row – the New Tab card under it (the emulator's fourth run). */
  const opened = vi.fn()
  const scene = (bubble: HintBubble | null): void =>
    act(() =>
      root!.render(
        createElement(
          Fragment,
          null,
          bubble ? createElement(HintBubbleCard, { bubble, leaving: false }) : null,
          createElement('button', { type: 'button', onClick: opened }, 'New tab')
        )
      )
    )
  const bubbleEl = (): HTMLElement => host!.querySelector<HTMLElement>('.zen-hint-bubble')!
  const plus = (): HTMLElement => host!.querySelector<HTMLElement>('button')!
  const pointer = (type: string, on: HTMLElement, pointerId = 1): void => {
    on.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId }))
  }
  const click = (on: HTMLElement): void => {
    on.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  beforeEach(() => opened.mockReset())

  it("a tap on the bubble lands on nothing under it – though the bubble is gone before the tap's click arrives (the fourth run: the New Tab card beneath opened a tab)", () => {
    scene(CARD_BUBBLE)
    act(() => pointer('pointerdown', bubbleEl()))
    // The first touch took the bubble down and the fade swept its node before the click came.
    scene(null)
    expect(host!.querySelector('.zen-hint-bubble')).toBeNull()
    act(() => pointer('pointerup', document.body))
    act(() => click(plus()))
    expect(opened).not.toHaveBeenCalled()
    // One shot: the swallow stood down with the click it took.
    act(() => click(plus()))
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('the next touch is its own: a tap elsewhere after a touch on the bubble runs what it touched', () => {
    scene(CARD_BUBBLE)
    act(() => pointer('pointerdown', bubbleEl()))
    scene(null)
    act(() => pointer('pointerdown', plus(), 2))
    act(() => pointer('pointerup', plus(), 2))
    act(() => click(plus()))
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('stands down when the touch is cancelled – a scroll took it, no click follows', () => {
    scene(CARD_BUBBLE)
    act(() => pointer('pointerdown', bubbleEl()))
    act(() => pointer('pointercancel', document.body))
    act(() => click(plus()))
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it(`holds ${HINT_TAP_SETTLE_MS} ms after the finger lifts – a slow frame's late click is still the bubble's – and no longer`, () => {
    scene(CARD_BUBBLE)
    act(() => pointer('pointerdown', bubbleEl()))
    act(() => pointer('pointerup', document.body))
    act(() => vi.advanceTimersByTime(HINT_TAP_SETTLE_MS - 1))
    act(() => click(plus()))
    expect(opened).not.toHaveBeenCalled()

    act(() => pointer('pointerdown', bubbleEl()))
    act(() => pointer('pointerup', document.body))
    act(() => vi.advanceTimersByTime(HINT_TAP_SETTLE_MS))
    act(() => click(plus()))
    expect(opened).toHaveBeenCalledTimes(1)
  })
})

describe('the stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
  const rule = (selector: string): string => {
    const at = css.indexOf(`\n  ${selector} {`)
    expect(at, selector).toBeGreaterThan(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it("keeps the bubble the touch's target through its fade: a tap on the bubble takes it down and lands on nothing under it (the emulator's second run: the card beneath was picked)", () => {
    // The layer is inert and the card opts back in; the fade turns that off nowhere.
    expect(rule('.zen-message')).toContain('pointer-events: auto')
    expect(rule('.zen-hint-bubble')).not.toContain('pointer-events')
    expect(rule('.zen-hint-bubble[data-leaving]')).not.toContain('pointer-events')
    expect(rule(".zen-hint-bubble[data-at='overview']")).not.toContain('pointer-events')
  })
})
