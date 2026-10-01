import { describe, expect, it, vi } from 'vitest'
import { Smartphone } from 'lucide-react'
import type { BannerDismissReason, BannerOptions } from '@renderer/lib/ui'
import { bandRequestFromBanner, bannerReasonOf, userEnded, type BandEndReason } from '../tenants'

const REASONS: BandEndReason[] = [
  'action',
  'close',
  'swipe',
  'timeout',
  'replaced',
  'program',
  'displaced'
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
    expect(request.clock).toBe(10_000)
    expect(request.action?.label).toBe('Add')
    request.action?.pick()
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(request.secondary).toBeUndefined()
  })

  it('a state has no clock whatever the banner asked, and may carry a second, dismissing action', () => {
    const notNow = vi.fn()
    const request = bandRequestFromBanner(
      {
        title: 'Open links in Zenium',
        detail: 'Make it your default browser',
        action: { label: 'Set as default', onPick: () => undefined },
        key: 'default-browser',
        duration: 4000
      },
      'state',
      { secondary: { label: 'Not now', pick: notNow }, tone: 'warn' }
    )
    expect(request.form).toBe('state')
    expect(request.clock).toBeNull()
    expect(request.action?.label).toBe('Set as default')
    expect(request.secondary?.label).toBe('Not now')
    request.secondary?.pick()
    expect(notNow).toHaveBeenCalledTimes(1)
    expect(request.tone).toBe('warn')
  })

  it('a banner without an action cannot be an offer: it is shown as a state', () => {
    const request = bandRequestFromBanner(
      { title: 'No internet connection', key: 'offline', duration: null },
      'offer'
    )
    expect(request.form).toBe('state')
    expect(request.clock).toBeNull()
    expect(request.action).toBeUndefined()
    // A second action rides a state only; an offer's one action is the rule.
    const offer = bandRequestFromBanner(
      { title: 'Show Reader View?', action: { label: 'Show', onPick: () => undefined } },
      'offer',
      { secondary: { label: 'Never', pick: () => undefined }, tone: 'warn' }
    )
    expect(offer.form).toBe('offer')
    expect(offer.secondary).toBeUndefined()
    expect(offer.tone).toBeUndefined()
  })

  it('leaves out what the banner did not have (no undefined keys for the content to trip on)', () => {
    const request = bandRequestFromBanner({ title: 'T' }, 'state')
    expect(Object.keys(request).sort()).toEqual(['clock', 'form', 'title'])
  })

  it('an offer with no clock of its own has none (the model may fall back to its own)', () => {
    const request = bandRequestFromBanner(
      { title: 'T', action: { label: 'A', onPick: () => undefined } },
      'offer'
    )
    expect(request.clock).toBeNull()
  })

  it("hands the band's ends to the tenant in the banner's vocabulary", () => {
    const heard: BannerDismissReason[] = []
    const request = bandRequestFromBanner(
      { title: 'T', onDismiss: (reason) => heard.push(reason) },
      'state'
    )
    for (const reason of REASONS) request.onEnd?.(reason)
    expect(heard).toEqual(['action', 'close', 'swipe', 'timeout', 'replaced', 'program', 'program'])
  })
})

describe('the ends', () => {
  it('every banner reason is its own; displaced reads as program (not a refusal)', () => {
    for (const reason of REASONS) {
      expect(bannerReasonOf(reason)).toBe(reason === 'displaced' ? 'program' : reason)
    }
  })

  it("the user's own ends are the action, the × and the swipe", () => {
    expect(REASONS.filter(userEnded)).toEqual(['action', 'close', 'swipe'])
  })
})
