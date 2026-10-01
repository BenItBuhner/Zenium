import { Info } from 'lucide-react'
import {
  bandStore,
  chooseBand,
  dismissBand,
  showBand,
  type BandDismissReason,
  type BandOptions
} from '@renderer/lib/band'
import type { BannerDismissReason } from '@renderer/lib/ui'
import type { BandDoor } from './post'
import type { BandEndReason, BandRequest } from './tenants'

/**
 * The tenants' door onto the band's shared model (`lib/band.ts`, motion spec §3.2): a request
 * becomes one `showBand`, its ends come back in the tenants' words. The model scopes bands per
 * tab when asked; Android's four tenants ask for the window (`tabId: null`) and keep their own
 * tab and navigation ends as today (the install prompt's core retires it, the reader offer's
 * effect judges the page left) – one to one with the §9.33 banner they replace.
 */

/**
 * The model's end in the tenants' vocabulary: `back` – the system Back on Android
 * (`TouchBandLayer`), the band's Escape – and `escape` – the Escape key with focus in the band –
 * stay their own words, UNANSWERED ends the tenants hear apart from the ×'s refusal (spec §9
 * item 6; `tenants.ts` `unansweredEnd`); a navigation's take-down is the chrome's doing
 * (`program`), which no tenant counts as an answer.
 */
export function tenantReasonOf(reason: BandDismissReason): BandEndReason {
  return reason === 'navigation' ? 'program' : reason
}

/** A request without a tenant's `key` stands under one of its own: the same key again replaces. */
let anonymous = 0

/**
 * The model's `showBand` options for a tenant's request: the words, glyph, tone, clock and the
 * one action carry over; the × keeps the content component's name ("Dismiss") on every band.
 */
export function bandOptionsOf(request: BandRequest): BandOptions {
  const options: BandOptions = {
    key: request.key ?? `band-${++anonymous}`,
    form: request.form,
    tabId: null,
    // Every tenant names its glyph (§3.1); a request without one gets the plain information mark.
    icon: request.glyph ?? Info,
    title: request.title,
    duration: request.clock
  }
  if (request.detail !== undefined) options.detail = request.detail
  if (request.tone !== undefined) options.tone = request.tone
  if (request.action) {
    const action = request.action
    options.action = { label: action.label, onPick: () => action.pick() }
  }
  if (request.onEnd) {
    const onEnd = request.onEnd
    options.onDismiss = (reason) => onEnd(tenantReasonOf(reason))
  }
  return options
}

/** The door the touch shells register with `setBandDoor` while the band is mounted. */
export function createModelDoor(): BandDoor {
  return {
    show: (request) => showBand(bandOptionsOf(request)),
    dismiss: (id, reason: BannerDismissReason) => dismissBand(id, reason),
    up: (id) => bandStore.get().entries.some((e) => e.id === id),
    upByKey: (key) => bandStore.get().entries.some((e) => e.key === key),
    // The model's own choice – what the band's layer draws (`PageEdgeBand`, `TouchBandLayer`
    // read the same): under a cover a request posted after it waits, unchosen (§3.2).
    shown: (id) => chooseBand(bandStore.get())?.id === id,
    subscribe: (listener) => bandStore.subscribe(listener)
  }
}
