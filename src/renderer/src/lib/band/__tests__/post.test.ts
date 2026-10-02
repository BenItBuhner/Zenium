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
  postedShown,
  postedUp,
  setBandDoor,
  type BandDoor
} from '../post'
import type { BandEndReason, BandRequest } from '../tenants'

interface FakeBand extends BandDoor {
  posted: Array<{ id: number; request: BandRequest }>
  standing: Map<number, BandRequest>
  /** A cover over the band: a request posted under it waits, undrawn, until `uncover`. */
  covered: boolean
  drawn: Set<number>
  uncover(): void
  end(id: number, reason: BandEndReason): void
}

function fakeBand(): FakeBand {
  let next = 100
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const l of listeners) l()
  }
  const band: FakeBand = {
    posted: [],
    standing: new Map(),
    covered: false,
    drawn: new Set(),
    show(request) {
      const id = next++
      band.posted.push({ id, request })
      band.standing.set(id, request)
      if (!band.covered) band.drawn.add(id)
      publish()
      return id
    },
    uncover() {
      band.covered = false
      for (const id of band.standing.keys()) band.drawn.add(id)
      publish()
    },
    dismiss(id, reason) {
      band.end(id, reason)
    },
    end(id, reason) {
      const request = band.standing.get(id)
      if (!request) return
      band.standing.delete(id)
      band.drawn.delete(id)
      publish()
      request.onEnd?.(reason)
    },
    up: (id) => band.standing.has(id),
    upByKey: (key) => [...band.standing.values()].some((r) => r.key === key),
    shown: (id) => band.standing.has(id) && band.drawn.has(id),
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
    expect(band.posted).toHaveLength(1)
    expect(band.posted[0].request.form).toBe('offer')
    expect(band.posted[0].request.title).toBe('Show Reader View?')
    expect(postedUp(id)).toBe(true)
    expect(postedShown(id)).toBe(true)
    expect(postedKeyUp('reader')).toBe(true)
    // The band's own end reaches the tenant in its vocabulary…
    band.end(band.posted[0].id, 'displaced')
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
    expect(band.posted).toEqual([])
    expect(uiStore.get().banners.map((b) => b.title)).toEqual(['Desktop'])
    // The stack's card is drawn as it is posted.
    expect(postedShown(id)).toBe(true)
    dismissPosted(id)
    expect(postedShown(id)).toBe(false)
  })

  it('a message posted to the banner stack is still found after the band mounts', () => {
    const id = postBanner({ title: 'Early', key: 'early', duration: null }, 'state')
    setBandDoor(fakeBand())
    expect(postedUp(id)).toBe(true)
    expect(postedKeyUp('early')).toBe(true)
    dismissPosted(id)
    expect(postedKeyUp('early')).toBe(false)
  })

  describe('a post the band holds back (seed #43)', () => {
    const offer = (onShown?: () => void): number =>
      postBanner(
        {
          title: 'Add Sketch to Home screen',
          key: 'install',
          duration: 10_000,
          action: { label: 'Add', onPick: () => undefined }
        },
        'offer',
        { onShown }
      )

    it('is up, not shown, until the band draws it; onShown then hears of the first drawn frame once', () => {
      const band = fakeBand()
      setBandDoor(band)
      band.covered = true
      const shown = vi.fn()
      const id = offer(shown)
      expect(postedUp(id)).toBe(true)
      expect(postedKeyUp('install')).toBe(true)
      expect(postedShown(id)).toBe(false)
      expect(shown).not.toHaveBeenCalled()
      // The band's other changes under the cover are not the show.
      band.show({ form: 'state', title: 'No internet connection', clock: null })
      expect(shown).not.toHaveBeenCalled()
      band.uncover()
      expect(postedShown(id)).toBe(true)
      expect(shown).toHaveBeenCalledTimes(1)
      // Later changes of the band repeat nothing.
      band.covered = true
      band.uncover()
      band.show({ form: 'state', title: 'Back online', clock: null })
      expect(shown).toHaveBeenCalledTimes(1)
    })

    it('shown at the post gets no onShown: its tenant reads postedShown at the post', () => {
      const band = fakeBand()
      setBandDoor(band)
      const shown = vi.fn()
      const id = offer(shown)
      expect(postedShown(id)).toBe(true)
      band.covered = true
      band.uncover()
      expect(shown).not.toHaveBeenCalled()
    })

    it('ended before it is ever drawn – by the band or by its tenant – never hears of a show, and the watch goes with it', () => {
      const band = fakeBand()
      setBandDoor(band)
      band.covered = true
      const byBand = vi.fn()
      const first = offer(byBand)
      band.end(band.posted[0].id, 'back')
      expect(postedUp(first)).toBe(false)
      const byTenant = vi.fn()
      const second = offer(byTenant)
      dismissPosted(second)
      expect(postedUp(second)).toBe(false)
      band.uncover()
      expect(byBand).not.toHaveBeenCalled()
      expect(byTenant).not.toHaveBeenCalled()
      expect(postedShown(first)).toBe(false)
      expect(postedShown(second)).toBe(false)
    })

    it('a tenant with no onShown is watched for nothing', () => {
      const band = fakeBand()
      setBandDoor(band)
      band.covered = true
      const id = offer()
      expect(postedShown(id)).toBe(false)
      band.uncover()
      expect(postedShown(id)).toBe(true)
      dismissPosted(id)
    })
  })
})
