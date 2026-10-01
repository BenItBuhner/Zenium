import { describe, expect, it, vi } from 'vitest'
import { Smartphone } from 'lucide-react'
import { BAND_CLOCK_MS } from '@renderer/lib/motion/tokens'
import type { BannerDismissReason, BannerOptions } from '@renderer/lib/ui'
import {
  bandRequestFromBanner,
  bannerReasonOf,
  unansweredEnd,
  userEnded,
  type BandEndReason
} from '../tenants'

const REASONS: BandEndReason[] = [
  'action',
  'close',
  'swipe',
  'timeout',
  'replaced',
  'program',
  'displaced',
  'escape',
  'back'
]

describe('bandRequestFromBanner', () => {
  it('carries an offer over one to one: words, glyph, action, key and clock', () => {
    const onPick = vi.fn()
    const opts: BannerOptions = {
      title: 'Add Zenium Notes to Home screen',
      detail: 'notes.example',
      icon: Smartphone,
      action: { label: 'Add', onPick },
      key: 'install',
      duration: 10_000
    }
    const request = bandRequestFromBanner(opts, 'offer')
    expect(request.form).toBe('offer')
    expect(request.title).toBe('Add Zenium Notes to Home screen')
    expect(request.detail).toBe('notes.example')
    expect(request.glyph).toBe(Smartphone)
    expect(request.key).toBe('install')
    expect(request.clock).toBe(BAND_CLOCK_MS)
    expect(request.action?.label).toBe('Add')
    request.action?.pick()
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('a state has no clock whatever the banner asked, and carries its tone; no tenant names its × (the band’s own "Dismiss" on every band)', () => {
    const request = bandRequestFromBanner(
      {
        title: 'Open links in Zenium',
        detail: 'Make it your default browser',
        action: { label: 'Set as default', onPick: () => undefined },
        key: 'default-browser',
        duration: 4000
      },
      'state',
      { tone: 'warn' }
    )
    expect(request.form).toBe('state')
    expect(request.clock).toBeNull()
    expect(request.action?.label).toBe('Set as default')
    expect(request.tone).toBe('warn')
    expect('closeLabel' in request).toBe(false)
  })

  it('a banner without an action cannot be an offer: it is shown as a state', () => {
    const request = bandRequestFromBanner(
      { title: 'No internet connection', key: 'offline', duration: null },
      'offer'
    )
    expect(request.form).toBe('state')
    expect(request.clock).toBeNull()
    expect(request.action).toBeUndefined()
    // A tone rides a state only (an offer's glyph is the accent).
    const offer = bandRequestFromBanner(
      { title: 'Show Reader View?', action: { label: 'Show', onPick: () => undefined } },
      'offer',
      { tone: 'warn' }
    )
    expect(offer.form).toBe('offer')
    expect(offer.tone).toBeUndefined()
  })

  it('leaves out what the banner did not have (no undefined keys for the content to trip on)', () => {
    const request = bandRequestFromBanner({ title: 'T' }, 'state')
    expect(Object.keys(request).sort()).toEqual(['clock', 'form', 'title'])
  })

  it('one offer, one clock (the Design Lead’s ruling): an offer runs the band’s BAND_CLOCK_MS, not a clock of its tenant’s – the install prompt’s old 12 s, a reader offer’s 10 s, a banner with none all come out as the one clock', () => {
    const action = { label: 'A', onPick: (): void => undefined }
    expect(bandRequestFromBanner({ title: 'T', action, duration: 12_000 }, 'offer').clock).toBe(
      BAND_CLOCK_MS
    )
    expect(bandRequestFromBanner({ title: 'T', action, duration: 10_000 }, 'offer').clock).toBe(
      BAND_CLOCK_MS
    )
    expect(bandRequestFromBanner({ title: 'T', action }, 'offer').clock).toBe(BAND_CLOCK_MS)
    expect(BAND_CLOCK_MS).toBe(10_000)
  })

  it('a prompt the user opened has no clock: a tenant that says `duration: null` posts an offer that stands until answered', () => {
    const request = bandRequestFromBanner(
      { title: 'T', action: { label: 'A', onPick: () => undefined }, duration: null },
      'offer'
    )
    expect(request.form).toBe('offer')
    expect(request.clock).toBeNull()
  })

  it("hands the band's answered ends to the tenant in the banner's vocabulary; the unanswered ones (the Back, Escape, the swipe) go to onAway and never to onDismiss", () => {
    const heard: BannerDismissReason[] = []
    let away = 0
    const request = bandRequestFromBanner(
      { title: 'T', onDismiss: (reason) => heard.push(reason) },
      'state',
      { onAway: () => void away++ }
    )
    for (const reason of REASONS) request.onEnd?.(reason)
    expect(heard).toEqual(['action', 'close', 'timeout', 'replaced', 'program', 'program'])
    expect(away).toBe(3)
  })

  it('a tenant with no onAway hears nothing of an unanswered end (no refusal, no cooldown); one with onAway alone still gets an onEnd', () => {
    const heard: BannerDismissReason[] = []
    const request = bandRequestFromBanner(
      { title: 'T', onDismiss: (reason) => heard.push(reason) },
      'state'
    )
    request.onEnd?.('back')
    request.onEnd?.('escape')
    request.onEnd?.('swipe')
    expect(heard).toEqual([])

    let away = 0
    const quiet = bandRequestFromBanner({ title: 'T' }, 'state', { onAway: () => void away++ })
    expect(quiet.onEnd).toBeDefined()
    quiet.onEnd?.('back')
    quiet.onEnd?.('close')
    expect(away).toBe(1)

    expect(bandRequestFromBanner({ title: 'T' }, 'state').onEnd).toBeUndefined()
  })
})

describe('the ends', () => {
  it('every banner reason is its own; displaced, escape and back read as program (not a refusal)', () => {
    for (const reason of REASONS) {
      expect(bannerReasonOf(reason)).toBe(
        reason === 'displaced' || reason === 'escape' || reason === 'back' ? 'program' : reason
      )
    }
  })

  it('the unanswered ends are the Back, Escape and the swipe – §9 item 6; the × is the explicit refusal', () => {
    expect(REASONS.filter(unansweredEnd)).toEqual(['swipe', 'escape', 'back'])
    expect(unansweredEnd('close')).toBe(false)
    expect(unansweredEnd('timeout')).toBe(false)
  })

  it("the user's own ends are the action, the ×, the swipe, Escape and the Back", () => {
    expect(REASONS.filter(userEnded)).toEqual(['action', 'close', 'swipe', 'escape', 'back'])
  })
})
