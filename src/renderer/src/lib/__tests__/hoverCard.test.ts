import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Rect } from '@shared/types'
import {
  HOVER_CARD_DELAY,
  HOVER_CARD_LEAVE_GRACE,
  HoverCardController,
  hoverCardHost,
  placeHoverCard,
  type HoverCardState
} from '../hoverCard'
import { POPOVER_HEIGHT_FLOOR, POPOVER_MARGIN } from '../portals'
import { createStore } from '../store'

const viewport = { width: 1600, height: 1000 }
const card = { width: 320, height: 92 }
const sidebarLeft: Rect = { x: 0, y: 0, width: 240, height: 1000 }
const row = (y: number): Rect => ({ x: 8, y, width: 224, height: 36 })

describe('placeHoverCard', () => {
  it('sits flush against a left sidebar, start-aligned with the row, at its own height', () => {
    expect(placeHoverCard(row(120), sidebarLeft, viewport, card)).toEqual({
      side: 'below',
      left: 240,
      top: 120,
      width: 320,
      maxHeight: 92
    })
  })

  it('goes to the left of a sidebar on the right', () => {
    const sidebarRight: Rect = { x: 1360, y: 0, width: 240, height: 1000 }
    expect(placeHoverCard({ ...row(120), x: 1368 }, sidebarRight, viewport, card)).toMatchObject({
      left: 1040,
      top: 120
    })
  })

  it('flips above a row near the bottom: end-aligned, its bottom edge on the row’s', () => {
    // The row at 940–976: 92 below its top would end at 1032, past the 992 margin line, and
    // there is more room above than below.
    expect(placeHoverCard(row(940), sidebarLeft, viewport, card)).toEqual({
      side: 'above',
      left: 240,
      bottom: 1000 - 976,
      width: 320,
      maxHeight: 92
    })
  })

  it('stays start-aligned up to the last row that fits, then flips', () => {
    const last = 1000 - POPOVER_MARGIN - card.height
    expect(placeHoverCard(row(last), sidebarLeft, viewport, card)).toMatchObject({
      side: 'below',
      top: last
    })
    expect(placeHoverCard(row(last + 1), sidebarLeft, viewport, card).side).toBe('above')
  })

  it('flipped, it still keeps the margin when the row runs under the window’s bottom edge', () => {
    expect(placeHoverCard(row(990), sidebarLeft, viewport, card)).toMatchObject({
      side: 'above',
      bottom: POPOVER_MARGIN
    })
  })

  it('never starts above the margin', () => {
    expect(placeHoverCard(row(2), sidebarLeft, viewport, card)).toMatchObject({
      side: 'below',
      top: 8
    })
  })

  it('keeps the card inside a narrow window', () => {
    const narrow = { width: 500, height: 600 }
    expect(placeHoverCard(row(100), sidebarLeft, narrow, card).left).toBe(500 - 320 - 8)
  })

  it('a card wider than the window minus 16 shrinks to that', () => {
    const tiny = { width: 300, height: 600 }
    expect(placeHoverCard(row(100), sidebarLeft, tiny, card)).toMatchObject({
      left: 8,
      width: 284
    })
  })

  it('is never taller than the window minus 16, shrinking rather than flipping when the room below is the larger', () => {
    // A tall card (many state lines) in a short window: it does not fit below the row's top,
    // there is more room below than above and the room below is not under the floor, so it
    // stays start-aligned and is capped to the room left.
    const short = { width: 1600, height: 400 }
    const tall = { width: 320, height: 380 }
    expect(placeHoverCard(row(40), sidebarLeft, short, tall)).toEqual({
      side: 'below',
      left: 240,
      top: 40,
      width: 320,
      maxHeight: 400 - POPOVER_MARGIN - 40
    })
    // With less room below than the floor it flips regardless, even where the room above is
    // smaller still, and is capped to that room: a 260 window, the row at 100–136 (below 152,
    // above 128).
    const tiny = { width: 1600, height: 260 }
    expect(260 - POPOVER_MARGIN - 100).toBeLessThan(POPOVER_HEIGHT_FLOOR)
    expect(placeHoverCard(row(100), sidebarLeft, tiny, tall)).toEqual({
      side: 'above',
      left: 240,
      bottom: 260 - 136,
      width: 320,
      maxHeight: 136 - POPOVER_MARGIN
    })
  })
})

describe('hoverCardHost', () => {
  it('shows the host of a web page without a leading www', () => {
    expect(hoverCardHost('https://www.example.com/a/b?c#d')).toBe('example.com')
    expect(hoverCardHost('http://docs.example.org:8080/x')).toBe('docs.example.org')
  })

  it('shows the address of a Zenium page, the word for a file, nothing for a blank tab', () => {
    expect(hoverCardHost('zen://settings/?pane=tabs')).toBe('zen://settings')
    expect(hoverCardHost('file:///home/me/notes.html')).toBe('File on this computer')
    expect(hoverCardHost('about:blank')).toBe('')
    expect(hoverCardHost('')).toBe('')
  })
})

describe('HoverCardController', () => {
  const box = (y: number): { anchor: Rect; sidebar: Rect } => ({
    anchor: row(y),
    sidebar: sidebarLeft
  })
  let store: ReturnType<typeof createStore<HoverCardState>>
  let ctl: HoverCardController
  // The card shows once `prepare` (the page capture) has settled: a timer step flushes it.
  const wait = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    store = createStore<HoverCardState>({ tabId: null, anchor: null, sidebar: null, by: null })
    ctl = new HoverCardController(store)
  })
  afterEach(() => vi.useRealTimers())

  it('shows the card once the pointer has rested on the row', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY - 1)
    expect(store.get().tabId).toBeNull()
    await wait(1)
    expect(store.get()).toEqual({
      tabId: 'a',
      anchor: row(100),
      sidebar: sidebarLeft,
      by: 'pointer'
    })
  })

  it('a pointer that leaves before the delay shows nothing', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(400)
    ctl.pointerLeave('a')
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBeNull()
  })

  it('moves to the next row at once while a card is up, and leaves with the pointer', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    // The leave of one row fires before the enter of the next: the card holds through the
    // grace and moves to the neighbour without another wait.
    ctl.pointerLeave('a')
    expect(store.get().tabId).toBe('a')
    await wait(HOVER_CARD_LEAVE_GRACE - 1)
    ctl.pointerEnter('b', () => box(138))
    await wait(0)
    expect(store.get().tabId).toBe('b')
    expect(store.get().anchor?.y).toBe(138)
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBe('b')
    // Into the gap past the rows: the grace runs out and the card goes.
    ctl.pointerLeave('b')
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get().tabId).toBeNull()
    // Back on a row: a fresh wait.
    ctl.pointerEnter('c', () => box(176))
    await wait(0)
    expect(store.get().tabId).toBeNull()
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBe('c')
  })

  it('keyboard focus shows the card at once and blur takes it down', async () => {
    ctl.focus('a', () => box(100))
    await wait(0)
    expect(store.get()).toMatchObject({ tabId: 'a', by: 'focus' })
    // The pointer leaving a row does not touch a card that focus put up.
    ctl.pointerLeave('a')
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get().tabId).toBe('a')
    ctl.blur('a')
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get().tabId).toBeNull()
  })

  it('focus walking to the next row moves the card without taking it down', async () => {
    const seen: Array<string | null> = []
    store.subscribe(() => seen.push(store.get().tabId))
    ctl.focus('a', () => box(100))
    await wait(0)
    // Blur and focus fire in the same turn when focus moves.
    ctl.blur('a')
    ctl.focus('b', () => box(138))
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get()).toMatchObject({ tabId: 'b', by: 'focus', anchor: row(138) })
    expect(seen).toEqual(['a', 'b'])
  })

  it('hide() drops a pending card as well as a shown one', async () => {
    ctl.pointerEnter('a', () => box(100))
    ctl.hide()
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBeNull()
    ctl.focus('a', () => box(100))
    ctl.hide()
    await wait(0)
    expect(store.get().tabId).toBeNull()
    expect(ctl.showing()).toBe(false)
  })

  it('a row that left the DOM before the delay shows nothing', async () => {
    ctl.pointerEnter('a', () => null)
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBeNull()
  })

  it('waits for the page capture, and a pointer that leaves meanwhile leaves nothing behind', async () => {
    let release: () => void = () => undefined
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    ctl = new HoverCardController(store, { prepare })
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(store.get().tabId).toBeNull()
    ctl.pointerLeave('a')
    release()
    await wait(0)
    expect(store.get().tabId).toBeNull()
    // The pointer that stays gets its card when the capture lands.
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    expect(prepare).toHaveBeenCalledTimes(2)
    release()
    await wait(0)
    expect(store.get().tabId).toBe('a')
  })

  it('the pointer coming back to the shown row drops a card on its way to another', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    ctl.pointerLeave('a')
    ctl.pointerEnter('b', () => box(138))
    ctl.pointerLeave('b')
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    expect(store.get()).toMatchObject({ tabId: 'a', anchor: row(100) })
  })

  describe('one at a time (§9.20): other chrome over the window blocks the card', () => {
    let busy = false
    beforeEach(() => {
      busy = false
      ctl = new HoverCardController(store, { blocked: () => busy })
    })

    it('shows no card for a pointer that arrives while a popover is open', async () => {
      busy = true
      ctl.pointerEnter('a', () => box(100))
      await wait(HOVER_CARD_DELAY)
      expect(store.get().tabId).toBeNull()
    })

    it('shows no card for focus that lands while a dialog is open', async () => {
      busy = true
      ctl.focus('a', () => box(100))
      await wait(0)
      expect(store.get().tabId).toBeNull()
    })

    it('drops a card whose wait ended after a popover opened (Ctrl+D during the rest)', async () => {
      const prepare = vi.fn(async () => undefined)
      ctl = new HoverCardController(store, { prepare, blocked: () => busy })
      ctl.pointerEnter('a', () => box(100))
      await wait(HOVER_CARD_DELAY - 1)
      busy = true
      await wait(1)
      expect(store.get().tabId).toBeNull()
      // Nothing was captured for a card that was not going to show.
      expect(prepare).not.toHaveBeenCalled()
    })

    it('drops a card whose page capture ended after a popover opened', async () => {
      let release: () => void = () => undefined
      const prepare = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      ctl = new HoverCardController(store, { prepare, blocked: () => busy })
      ctl.pointerEnter('a', () => box(100))
      await wait(HOVER_CARD_DELAY)
      expect(prepare).toHaveBeenCalledTimes(1)
      busy = true
      release()
      await wait(0)
      expect(store.get().tabId).toBeNull()
    })

    it('a card that is up comes down when the pointer moves on to a row under the block', async () => {
      ctl.pointerEnter('a', () => box(100))
      await wait(HOVER_CARD_DELAY)
      expect(store.get().tabId).toBe('a')
      busy = true
      ctl.pointerLeave('a')
      ctl.pointerEnter('b', () => box(138))
      await wait(0)
      expect(store.get().tabId).toBeNull()
    })

    it('once the chrome is free again a fresh rest shows the card', async () => {
      busy = true
      ctl.pointerEnter('a', () => box(100))
      await wait(HOVER_CARD_DELAY)
      busy = false
      ctl.pointerLeave('a')
      ctl.pointerEnter('a', () => box(100))
      await wait(HOVER_CARD_DELAY)
      expect(store.get().tabId).toBe('a')
    })
  })
})
