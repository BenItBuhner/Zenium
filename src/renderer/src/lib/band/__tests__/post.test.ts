import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BannerDismissReason } from '@renderer/lib/ui'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const touch = { value: false }
vi.mock('@renderer/lib/formFactor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/formFactor')>()
  return { ...actual, isTouchLayout: () => touch.value }
})

import { dismissBanner, uiStore } from '@renderer/lib/ui'
import {
  bandIsTheDoor,
  dismissPosted,
  postBanner,
  postedKeyUp,
  postedUp,
  setBandDoor,
  type BandDoor
} from '../post'
import type { BandRequest } from '../tenants'

interface FakeBand extends BandDoor {
  shown: Array<{ id: number; request: BandRequest }>
  standing: Map<number, BandRequest>
  end(id: number, reason: BannerDismissReason | 'displaced'): void
}

function fakeBand(): FakeBand {
  let next = 100
  const listeners = new Set<() => void>()
  const band: FakeBand = {
    shown: [],
    standing: new Map(),
    show(request) {
      const id = next++
      band.shown.push({ id, request })
      band.standing.set(id, request)
      for (const l of listeners) l()
      return id
    },
    dismiss(id, reason) {
      band.end(id, reason)
    },
    end(id, reason) {
      const request = band.standing.get(id)
      if (!request) return
      band.standing.delete(id)
      for (const l of listeners) l()
      request.onEnd?.(reason)
    },
    up: (id) => band.standing.has(id),
    upByKey: (key) => [...band.standing.values()].some((r) => r.key === key),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return band
}

describe('postBanner', () => {
  beforeEach(() => {
    touch.value = true
  })
  afterEach(() => {
    setBandDoor(null)
    for (const b of uiStore.get().banners) dismissBanner(b.id)
    uiStore.set({ banners: [] })
    touch.value = false
  })

  it('without a band door the banner stack is the door, with the ends unchanged', () => {
    const heard: BannerDismissReason[] = []
    expect(bandIsTheDoor()).toBe(false)
    const id = postBanner(
      {
        title: 'No internet connection',
        key: 'offline',
        duration: null,
        onDismiss: (r) => heard.push(r)
      },
      'state'
    )
    expect(uiStore.get().banners.map((b) => b.title)).toEqual(['No internet connection'])
    expect(postedUp(id)).toBe(true)
    expect(postedKeyUp('offline')).toBe(true)
    dismissPosted(id, 'close')
    expect(heard).toEqual(['close'])
    expect(postedUp(id)).toBe(false)
  })

  it('on a touch host with the band mounted the message goes to the band', () => {
    const band = fakeBand()
    setBandDoor(band)
    expect(bandIsTheDoor()).toBe(true)
    const heard: BannerDismissReason[] = []
    const id = postBanner(
      {
        title: 'Show Reader View?',
        key: 'reader',
        duration: 10_000,
        action: { label: 'Show', onPick: () => undefined },
        onDismiss: (r) => heard.push(r)
      },
      'offer'
    )
    expect(uiStore.get().banners).toEqual([])
    expect(band.shown).toHaveLength(1)
    expect(band.shown[0].request.form).toBe('offer')
    expect(band.shown[0].request.title).toBe('Show Reader View?')
    expect(postedUp(id)).toBe(true)
    expect(postedKeyUp('reader')).toBe(true)
    // The band's own end reaches the tenant in its vocabulary…
    band.end(band.shown[0].id, 'displaced')
    expect(heard).toEqual(['program'])
    expect(postedUp(id)).toBe(false)
    expect(postedKeyUp('reader')).toBe(false)
    // …and a take-down after the end is nothing.
    dismissPosted(id, 'close')
    expect(heard).toEqual(['program'])
  })

  it("the tenant's take-down reaches the band with its reason", () => {
    const band = fakeBand()
    setBandDoor(band)
    const heard: BannerDismissReason[] = []
    const id = postBanner({ title: 'T', onDismiss: (r) => heard.push(r) }, 'state')
    dismissPosted(id)
    expect(heard).toEqual(['program'])
    expect(band.standing.size).toBe(0)
  })

  it('off the touch layouts the banner stack stays the door even with a band mounted', () => {
    touch.value = false
    const band = fakeBand()
    setBandDoor(band)
    expect(bandIsTheDoor()).toBe(false)
    const id = postBanner({ title: 'Desktop', duration: null }, 'state')
    expect(band.shown).toEqual([])
    expect(uiStore.get().banners.map((b) => b.title)).toEqual(['Desktop'])
    dismissPosted(id)
  })

  it('a message posted to the banner stack is still found after the band mounts', () => {
    const id = postBanner({ title: 'Early', key: 'early', duration: null }, 'state')
    setBandDoor(fakeBand())
    expect(postedUp(id)).toBe(true)
    expect(postedKeyUp('early')).toBe(true)
    dismissPosted(id)
    expect(postedKeyUp('early')).toBe(false)
  })
})
