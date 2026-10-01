import type { LucideIcon } from 'lucide-react'
import type { BannerDismissReason, BannerOptions } from '@renderer/lib/ui'

/**
 * The tenants' side of the page-edge band (motion spec §3 / §4): what today's four §9.33
 * banners on the touch hosts – the install offer, the reader offer, the connectivity state and
 * the phone's default-browser offer – ask of the band, and how the band's ends read back as the
 * ends the tenants already act on. Pure: the mapping is one to one with today's words and ends
 * (no string changes), so the tenants' own code (`installBanner.ts`, `readerEntryMessage.ts`,
 * `connectivityMessages.ts`, `PhoneShell.tsx`) keeps its ends and only changes its door – with
 * one ruling the band adds (spec §9 item 6, {@link unansweredEnd}): the Back gesture and the
 * swipe put the band away UNANSWERED and are no refusal, where a card's swipe was one.
 *
 * The band itself – one at a time, the state > offer priority, the clock, the dismissals, the
 * never-on rules – is the shared model's (`lib/band`, Desktop's W8-M2); this module only
 * shapes the request and the answer.
 */

/**
 * The band's two forms (§3.1): an OFFER proposes something and runs the clock – accent glyph,
 * exactly one action, the × refuses it; a STATE reports something and stands while the state
 * holds – status ink, no clock, no action or the state's own.
 */
export type BandForm = 'offer' | 'state'

/** One of the band's actions: the §9.11 secondary at 40 on touch. */
export interface BandAction {
  label: string
  pick(): void
}

/**
 * A state's status ink for its glyph (§3.1): the chrome's ok / warn / danger inks; a state with
 * none (the default-browser reminder is no alarm) draws it deemphasised. An offer's glyph is the
 * accent whatever this says.
 */
export type BandTone = 'ok' | 'warn' | 'danger'

/**
 * What a tenant adds to its banner for the band: a second, dismissing action a state may carry,
 * a state's tone, and what it does when the band is put away UNANSWERED (`onAway`).
 */
export interface BandExtras {
  secondary?: BandAction
  tone?: BandTone
  /**
   * The band was put away without an answer – the system Back (the band's Escape, spec §9 item
   * 6) or a swipe up: no refusal is remembered, so the tenant's `onDismiss` is NOT called (its
   * `swipe` and `close` are today's refusals: the install prompt's cooldown, the default-browser
   * campaign's dismissal, the reader offer's mute). What the tenant does instead is bookkeeping
   * only – the install prompt tells the core the band is gone with no refusal, the reader offer
   * marks its standing offer spent – or nothing.
   */
  onAway?(): void
}

/**
 * Why a band left, in the tenants' vocabulary: the §9.33 host's reasons – `action` (the action
 * taken), `close` (the ×), `swipe` (swiped up off the page), `timeout` (the clock), `replaced`
 * (a newer band took its place), `program` (its tenant or a rule took it down: a navigation,
 * the tab leaving the front, a gate) – and the band's own two: `escape`, the system Back (the
 * band's Escape; the stack's cards never had one), and `displaced`, a pull-to-refresh begun on
 * the held page that took it over (§3.2: a pull while a band stands dismisses the band first).
 */
export type BandEndReason = BannerDismissReason | 'displaced' | 'escape'

/**
 * The ends that put the band away UNANSWERED (spec §9 item 6: Escape – the system Back on
 * Android – and the swipe leave the band without starting a cooldown; a refusal that is
 * remembered is only ever an explicit button, here the ×). The clock running out and the
 * tenants' own take-downs keep today's readings.
 */
export function unansweredEnd(reason: BandEndReason): boolean {
  return reason === 'escape' || reason === 'swipe'
}

/** What a tenant asks of the band: the spec's content `[glyph] Title · detail [Action] [×]`. */
export interface BandRequest {
  form: BandForm
  title: string
  detail?: string
  /** The Lucide glyph before the title: accent ink for offers, status ink for states (§3.1). */
  glyph?: LucideIcon
  /** The band's action, if it has one (offers always do). */
  action?: BandAction
  /**
   * A second, dismissing action a state may carry ("Not now" on the default-browser band, §4):
   * the same end as the × – the content component shows it only where it has room.
   */
  secondary?: BandAction
  /** A state's status ink for its glyph (§3.1); none draws it deemphasised. */
  tone?: BandTone
  /** Bands of one `key` do not pile up: a newer one replaces the standing one (§3.2). */
  key?: string
  /**
   * The clock, ms: offers run `BAND_CLOCK_MS` (paused under a finger and while the page is not
   * in front, armed at the show); null for states, which stand while the state holds.
   */
  clock: number | null
  /** The band left; `reason` says how, in the tenants' vocabulary. */
  onEnd?(reason: BandEndReason): void
}

/**
 * A tenant's §9.33 banner, as the band: the words, glyph and action carry over unchanged; the
 * form decides the clock – an offer keeps the banner's clock (its tenant's `duration`, today
 * the install prompt's `BANNER_TIMEOUT_MS` and the reader's `READER_ENTRY_CLOCK_MS`, both
 * 10 s = `BAND_CLOCK_MS`), a state has none whatever the banner asked. A banner with no action
 * cannot be an offer (an offer proposes something): it is shown as a state.
 */
export function bandRequestFromBanner(
  opts: BannerOptions,
  form: BandForm,
  extras: BandExtras = {}
): BandRequest {
  const shape: BandForm = opts.action ? form : 'state'
  const request: BandRequest = {
    form: shape,
    title: opts.title,
    clock: shape === 'offer' ? (opts.duration ?? null) : null
  }
  if (opts.detail !== undefined) request.detail = opts.detail
  if (opts.icon) request.glyph = opts.icon
  if (opts.action) {
    const action = opts.action
    request.action = { label: action.label, pick: () => action.onPick() }
  }
  if (extras.secondary && shape === 'state') request.secondary = extras.secondary
  if (extras.tone && shape === 'state') request.tone = extras.tone
  if (opts.key !== undefined) request.key = opts.key
  const { onDismiss } = opts
  const { onAway } = extras
  if (onDismiss || onAway) {
    // An unanswered end (§9 item 6) never reaches the tenant's `onDismiss`, whose `swipe` and
    // `close` are today's refusals; it goes to `onAway`, or nowhere.
    request.onEnd = (reason) => {
      if (unansweredEnd(reason)) onAway?.()
      else onDismiss?.(bannerReasonOf(reason))
    }
  }
  return request
}

/**
 * The band's end as the banner's dismiss reason the tenant already acts on. A `displaced` band
 * – the pull-to-refresh took the page over – was the chrome's doing, not the user's answer to
 * the offer: it reads as `program`, which no tenant counts as a refusal (the install prompt
 * reports nothing to the core, the reader offer's site stays unmuted); the offer may come back.
 * The unanswered ends ({@link unansweredEnd}) do not travel this way from
 * {@link bandRequestFromBanner}; asked anyway, `escape` reads as `program` too – no refusal.
 */
export function bannerReasonOf(reason: BandEndReason): BannerDismissReason {
  return reason === 'displaced' || reason === 'escape' ? 'program' : reason
}

/** Whether a band's end was the user's own doing (the action, the ×, the swipe, the Back) – not a rule's. */
export function userEnded(reason: BandEndReason): boolean {
  return reason === 'action' || reason === 'close' || reason === 'swipe' || reason === 'escape'
}
