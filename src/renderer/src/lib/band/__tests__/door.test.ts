import { BookOpenText, Info } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bandStore, resetBands, setBandFrame, shownBand } from '@renderer/lib/band'
import { BAND_CLOCK_MS } from '@renderer/lib/motion/tokens'
import { bandOptionsOf, createModelDoor, tenantReasonOf } from '../door'
import type { BandRequest } from '../tenants'

beforeEach(() => {
  vi.useFakeTimers()
  resetBands()
  setBandFrame({ front: 't1', ok: true })
})

afterEach(() => {
  resetBands()
  vi.useRealTimers()
})

const offer = (over: Partial<BandRequest> = {}): BandRequest => ({
  form: 'offer',
  title: 'Show Reader View?',
  glyph: BookOpenText,
  action: { label: 'Show', pick: () => undefined },
  key: 'reader',
  clock: BAND_CLOCK_MS,
  ...over
})

describe('tenantReasonOf', () => {
  it("keeps Escape (the system Back) its own, unanswered end – not the ×'s – and reads a navigation as the chrome's", () => {
    expect(tenantReasonOf('escape')).toBe('escape')
    expect(tenantReasonOf('navigation')).toBe('program')
  })

  it('passes the shared ends through unchanged', () => {
    for (const reason of ['action', 'close', 'swipe', 'timeout', 'replaced', 'program'] as const)
      expect(tenantReasonOf(reason)).toBe(reason)
  })
})

describe('bandOptionsOf', () => {
  it("carries the request's words, glyph, form, clock and key; the window is the scope", () => {
    const options = bandOptionsOf(offer({ detail: 'example.org' }))
    expect(options).toMatchObject({
      key: 'reader',
      form: 'offer',
      tabId: null,
      icon: BookOpenText,
      title: 'Show Reader View?',
      detail: 'example.org',
      duration: BAND_CLOCK_MS
    })
    expect(options.action?.label).toBe('Show')
  })

  it('a state has no clock and carries its tone; a request without a glyph gets the information mark', () => {
    const options = bandOptionsOf({
      form: 'state',
      title: 'No internet connection',
      key: 'offline',
      clock: null,
      tone: 'warn'
    })
    expect(options.duration).toBeNull()
    expect(options.icon).toBe(Info)
    expect(options.action).toBeUndefined()
    expect(options.tone).toBe('warn')
    expect('tone' in bandOptionsOf({ form: 'state', title: 'T', key: 't', clock: null })).toBe(
      false
    )
  })

  it("the ×'s name carries over where the tenant gives one, and is left to the content otherwise", () => {
    const named = bandOptionsOf({
      form: 'state',
      title: 'Open links in Zenium',
      key: 'default-browser',
      clock: null,
      closeLabel: 'Not now'
    })
    expect(named.closeLabel).toBe('Not now')
    expect('closeLabel' in bandOptionsOf(offer())).toBe(false)
  })

  it('a request without a key stands under one of its own, never the same twice', () => {
    const a = bandOptionsOf(offer({ key: undefined }))
    const b = bandOptionsOf(offer({ key: undefined }))
    expect(a.key).not.toBe(b.key)
  })

  it("the action's pick and the end's reason reach the tenant in its own words", () => {
    const pick = vi.fn()
    const onEnd = vi.fn()
    const options = bandOptionsOf(offer({ action: { label: 'Show', pick }, onEnd }))
    options.action?.onPick()
    expect(pick).toHaveBeenCalledTimes(1)
    options.onDismiss?.('escape')
    options.onDismiss?.('navigation')
    options.onDismiss?.('swipe')
    expect(onEnd.mock.calls.map((c) => c[0])).toEqual(['escape', 'program', 'swipe'])
  })
})

describe('createModelDoor', () => {
  it('show stands the request at the model; up and upByKey read it; dismiss ends it with the reason', () => {
    const onEnd = vi.fn()
    const door = createModelDoor()
    const id = door.show(offer({ onEnd }))
    expect(door.up(id)).toBe(true)
    expect(door.upByKey('reader')).toBe(true)
    expect(shownBand()?.title).toBe('Show Reader View?')
    door.dismiss(id, 'close')
    expect(door.up(id)).toBe(false)
    expect(door.upByKey('reader')).toBe(false)
    expect(onEnd).toHaveBeenCalledWith('close')
  })

  it("the model's own ends come back through the door: the clock as timeout, a newer offer as replaced", () => {
    const first = vi.fn()
    const second = vi.fn()
    const door = createModelDoor()
    door.show(offer({ key: 'reader', onEnd: first }))
    door.show(offer({ key: 'install', title: 'Add App to Home screen', onEnd: second }))
    expect(first).toHaveBeenCalledWith('replaced')
    vi.advanceTimersByTime(BAND_CLOCK_MS + 1)
    expect(second).toHaveBeenCalledWith('timeout')
    expect(bandStore.get().entries).toHaveLength(0)
  })

  it('subscribe hears the model change and the unsubscribe stops it', () => {
    const door = createModelDoor()
    const heard = vi.fn()
    const off = door.subscribe(heard)
    const id = door.show(offer())
    expect(heard).toHaveBeenCalled()
    const calls = heard.mock.calls.length
    off()
    door.dismiss(id, 'program')
    expect(heard.mock.calls.length).toBe(calls)
  })
})
