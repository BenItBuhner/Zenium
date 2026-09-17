import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Banner, Toast } from '../ui'

vi.stubGlobal('window', { zen: { invoke: async () => null, on: () => () => undefined } })

const {
  MAX_BANNERS,
  TOAST_ACTION_DURATION,
  TOAST_DURATION,
  dismissBanner,
  dismissToast,
  forgetBanner,
  forgetToast,
  holdBanner,
  holdToast,
  pickBannerAction,
  pickToastAction,
  pushToast,
  showBanner,
  uiStore
} = await import('../ui')
const { bannerSlots, coverFor } = await import('../../components/messages/stack')
const { viewCover } = await import('../layout')

const toasts = (): Toast[] => uiStore.get().toasts
const banners = (): Banner[] => uiStore.get().banners
const live = <T extends { leaving?: boolean }>(items: T[]): T[] => items.filter((m) => !m.leaving)

beforeEach(() => {
  vi.useFakeTimers()
  uiStore.set({ toasts: [], banners: [] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('toasts', () => {
  it('shows one live toast at a time: a new one sends the current one off', () => {
    pushToast('Saved')
    pushToast('Copied')
    expect(toasts().map((t) => [t.message, Boolean(t.leaving)])).toEqual([
      ['Saved', true],
      ['Copied', false]
    ])
    // The leaving card reports itself gone; without a card mounted the sweep does it.
    vi.advanceTimersByTime(1000)
    expect(toasts().map((t) => t.message)).toEqual(['Copied'])
  })

  it('the same message again restarts the clock instead of stacking', () => {
    pushToast('Bookmark added')
    vi.advanceTimersByTime(TOAST_DURATION - 100)
    pushToast('Bookmark added')
    expect(live(toasts())).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(live(toasts())).toHaveLength(1)
    vi.advanceTimersByTime(TOAST_DURATION)
    expect(live(toasts())).toHaveLength(0)
  })

  it('times out, and a toast with an action stays longer', () => {
    pushToast('Tab closed', 'info', { action: { label: 'Undo', onPick: () => undefined } })
    expect(toasts()[0].duration).toBe(TOAST_ACTION_DURATION)
    vi.advanceTimersByTime(TOAST_DURATION + 1)
    expect(live(toasts())).toHaveLength(1)
    vi.advanceTimersByTime(TOAST_ACTION_DURATION)
    expect(live(toasts())).toHaveLength(0)
  })

  it('a finger on the card pauses the clock; letting go gives at least a moment', () => {
    pushToast('Hold me')
    const id = toasts()[0].id
    vi.advanceTimersByTime(TOAST_DURATION - 50)
    holdToast(id, true)
    vi.advanceTimersByTime(10_000)
    expect(live(toasts())).toHaveLength(1)
    holdToast(id, false)
    vi.advanceTimersByTime(900)
    expect(live(toasts())).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(live(toasts())).toHaveLength(0)
  })

  it('picking the action runs it once and dismisses the toast', () => {
    const onPick = vi.fn()
    pushToast('Tab closed', 'info', { action: { label: 'Undo', onPick } })
    const id = toasts()[0].id
    pickToastAction(id)
    pickToastAction(id)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(toasts()[0].leaving).toBe(true)
    forgetToast(id)
    expect(toasts()).toHaveLength(0)
  })

  it('dismiss then forget is idempotent', () => {
    pushToast('Once')
    const id = toasts()[0].id
    dismissToast(id)
    dismissToast(id)
    expect(toasts().filter((t) => t.id === id)).toHaveLength(1)
    forgetToast(id)
    forgetToast(id)
    expect(toasts()).toHaveLength(0)
  })
})

describe('banners', () => {
  it('stacks newest first and caps the stack', () => {
    for (let i = 0; i < MAX_BANNERS + 1; i++) showBanner({ title: `b${i}` })
    const all = banners()
    expect(all.map((b) => b.title)).toEqual(['b3', 'b2', 'b1', 'b0'])
    expect(live(all).map((b) => b.title)).toEqual(['b3', 'b2', 'b1'])
    expect(all.find((b) => b.title === 'b0')?.leaving).toBe(true)
  })

  it('a banner of the same key replaces the one on screen and says why', () => {
    const onDismiss = vi.fn()
    showBanner({ title: 'Install Zenium?', key: 'install', onDismiss })
    showBanner({ title: 'Install Zenium now?', key: 'install' })
    expect(live(banners()).map((b) => b.title)).toEqual(['Install Zenium now?'])
    expect(onDismiss).toHaveBeenCalledWith('replaced')
  })

  it('stays until dismissed unless it has a duration', () => {
    const id = showBanner({ title: 'Stays' })
    const timed = showBanner({ title: 'Goes', duration: 1000 })
    vi.advanceTimersByTime(60_000)
    expect(live(banners()).map((b) => b.id)).toEqual([id])
    expect(banners().find((b) => b.id === timed)).toBeUndefined()
  })

  it('reports the dismiss reason once and runs the action once', () => {
    const onDismiss = vi.fn()
    const onPick = vi.fn()
    const id = showBanner({ title: 'Popup blocked', action: { label: 'Show', onPick }, onDismiss })
    pickBannerAction(id)
    pickBannerAction(id)
    dismissBanner(id, 'swipe')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('action')
    forgetBanner(id)
    expect(banners()).toHaveLength(0)
  })

  it('holding a timed banner pauses its clock', () => {
    const id = showBanner({ title: 'Timed', duration: 2000 })
    vi.advanceTimersByTime(1500)
    holdBanner(id, true)
    vi.advanceTimersByTime(5000)
    expect(live(banners())).toHaveLength(1)
    holdBanner(id, false)
    vi.advanceTimersByTime(1100)
    expect(live(banners())).toHaveLength(0)
  })
})

describe('stack geometry', () => {
  it('pushes older banners down by the newer ones above them', () => {
    const { y, height } = bannerSlots([40, 60, 0, 52], 8)
    expect(y).toEqual([0, 48, 116, 116])
    expect(height).toBe(168)
    expect(bannerSlots([])).toEqual({ y: [], height: 0 })
  })

  it('covers the frame edges by the stacks plus a gap on either side', () => {
    expect(coverFor(0, 0)).toEqual({ top: 0, bottom: 0 })
    expect(coverFor(100, 52, 8)).toEqual({ top: 116, bottom: 68 })
    expect(coverFor(100, 0, 8)).toEqual({ top: 116, bottom: 0 })
  })

  it('gives each view only the part of the strips that falls on it', () => {
    const area = { x: 0, y: 100, width: 400, height: 600 }
    const cover = { top: 60, bottom: 40 }
    expect(viewCover(area, area, cover)).toEqual({ top: 60, bottom: 40 })
    // Stacked split: the upper pane meets the banner strip only, the lower the toast strip only.
    expect(viewCover(area, { x: 0, y: 100, width: 400, height: 290 }, cover)).toEqual({
      top: 60,
      bottom: 0
    })
    expect(viewCover(area, { x: 0, y: 410, width: 400, height: 290 }, cover)).toEqual({
      top: 0,
      bottom: 40
    })
    expect(viewCover(area, { x: 0, y: 300, width: 400, height: 200 }, cover)).toBeUndefined()
    expect(viewCover(area, area, { top: 0, bottom: 0 })).toBeUndefined()
  })
})
