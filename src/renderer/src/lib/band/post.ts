import { useSyncExternalStore } from 'react'
import { isTouchLayout } from '@renderer/lib/formFactor'
import {
  dismissBanner,
  showBanner,
  uiStore,
  type BannerDismissReason,
  type BannerOptions
} from '@renderer/lib/ui'
import { bandRequestFromBanner, type BandExtras, type BandForm, type BandRequest } from './tenants'

/**
 * The tenants' one door to a page message: on the touch hosts (the phone, the tablet) the
 * install offer, the reader offer, the connectivity state and the phone's default-browser offer
 * go to the page-edge band (motion spec §3 / §4), which pulls the page down and stands in the
 * gap; everywhere else – and on the touch hosts until the band's model is mounted – they go to
 * the §9.33 banner stack as before, whose code is untouched. A tenant posts its `BannerOptions`
 * as today and says which form the band shows it in; the ends come back in the vocabulary the
 * tenant already acts on (`BannerDismissReason`).
 */

/**
 * The band's model as the door sees it (the seam the shared band implements and registers
 * with {@link setBandDoor} when it mounts on a touch host): show a request, take one down, and
 * say which stand – the standing ones by their own id and by their tenant's `key` – and which
 * one the band draws (`shown`: a standing request held back under a cover is up, not shown).
 */
export interface BandDoor {
  show(request: BandRequest): number
  dismiss(id: number, reason: BannerDismissReason): void
  up(id: number): boolean
  upByKey(key: string): boolean
  shown(id: number): boolean
  subscribe(listener: () => void): () => void
}

interface Posted {
  door: 'band' | 'banner'
  innerId: number
  key?: string
}

let bandDoor: BandDoor | null = null
const posted = new Map<number, Posted>()
let nextId = 1
const listeners = new Set<() => void>()
let offBand: (() => void) | null = null

function publish(): void {
  for (const l of listeners) l()
}

/** The band's model took the touch host's messages (null: it left; the banner stack is the door). */
export function setBandDoor(door: BandDoor | null): void {
  if (offBand) offBand()
  offBand = null
  bandDoor = door
  if (door) offBand = door.subscribe(publish)
  publish()
}

/** Whether a message posted now goes to the band. */
export function bandIsTheDoor(): boolean {
  return bandDoor !== null && isTouchLayout()
}

/**
 * Watch a request the band holds back (not shown at its post) for its first drawn frame and
 * tell the tenant once (`BandExtras.onShown`); the watch ends with the word, or with the
 * request if it goes before it is ever drawn. Returns the stop.
 */
function watchShown(door: BandDoor, innerId: number, onShown: () => void): () => void {
  let done = false
  let off: (() => void) | null = null
  const stop = (): void => {
    done = true
    off?.()
    off = null
  }
  off = door.subscribe(() => {
    if (done || (door.up(innerId) && !door.shown(innerId))) return
    const drawn = door.up(innerId)
    stop()
    if (drawn) onShown()
  })
  if (done) off()
  return stop
}

/**
 * Post a tenant's message; `form` is the band's form for it (§3.1), `extras` what the band
 * takes beyond the banner – a state's tone, what the tenant does when the band is put away
 * unanswered, what it does when a post held back first draws. Returns the id
 * {@link dismissPosted}, {@link postedUp} and {@link postedShown} take.
 */
export function postBanner(opts: BannerOptions, form: BandForm, extras?: BandExtras): number {
  const id = nextId++
  const forget = (): void => {
    posted.delete(id)
    publish()
  }
  if (bandDoor && isTouchLayout()) {
    const door = bandDoor
    const request = bandRequestFromBanner(opts, form, extras)
    const onEnd = request.onEnd
    let unwatch: (() => void) | null = null
    request.onEnd = (reason) => {
      unwatch?.()
      forget()
      onEnd?.(reason)
    }
    const innerId = door.show(request)
    posted.set(id, { door: 'band', innerId, key: opts.key })
    // Held back at the post (a cover stands): the tenant hears of the first drawn frame once.
    const onShown = extras?.onShown
    if (onShown && door.up(innerId) && !door.shown(innerId))
      unwatch = watchShown(door, innerId, onShown)
    publish()
    return id
  }
  const innerId = showBanner({
    ...opts,
    onDismiss: (reason) => {
      forget()
      opts.onDismiss?.(reason)
    }
  })
  posted.set(id, { door: 'banner', innerId, key: opts.key })
  publish()
  return id
}

/** Take a posted message down (`program`: the tenant's own doing, not the user's). */
export function dismissPosted(id: number, reason: BannerDismissReason = 'program'): void {
  const entry = posted.get(id)
  if (!entry) return
  if (entry.door === 'band') bandDoor?.dismiss(entry.innerId, reason)
  else dismissBanner(entry.innerId, reason)
}

/** Whether the message posted as `id` still stands (not leaving). */
export function postedUp(id: number): boolean {
  const entry = posted.get(id)
  if (!entry) return false
  if (entry.door === 'band') return bandDoor?.up(entry.innerId) === true
  return uiStore.get().banners.some((b) => b.id === entry.innerId && b.leaving !== true)
}

/**
 * Whether the message posted as `id` is on screen: at the band, the one the band draws (a post
 * the model holds back under a cover is up, not shown – `BandExtras.onShown` tells its tenant
 * when it is); at the stack, up – its card is drawn as it is posted.
 */
export function postedShown(id: number): boolean {
  const entry = posted.get(id)
  if (!entry) return false
  if (entry.door === 'band') return bandDoor?.shown(entry.innerId) === true
  return postedUp(id)
}

/**
 * Whether a message of `key` stands, at either door. At the band, a posted entry the model holds
 * back under a cover (a sheet, the keyboard) counts as up too – it is posted and will show – so
 * a tenant asking "already posted?" is answered the same under a cover as in the open.
 */
export function postedKeyUp(key: string): boolean {
  if (bandDoor?.upByKey(key)) return true
  return uiStore.get().banners.some((b) => b.key === key && b.leaving !== true)
}

function subscribePosted(listener: () => void): () => void {
  listeners.add(listener)
  const offUi = uiStore.subscribe(listener)
  return () => {
    listeners.delete(listener)
    offUi()
  }
}

/** React: whether a message of `key` stands, at either door. */
export function usePostedKeyUp(key: string): boolean {
  return useSyncExternalStore(
    subscribePosted,
    () => postedKeyUp(key),
    () => postedKeyUp(key)
  )
}
