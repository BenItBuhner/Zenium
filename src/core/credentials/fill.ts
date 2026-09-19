import type { Credential, Rect } from '../../shared/types'
import { siteLabel } from './origins'

/**
 * Pure decisions behind the in-page save prompt and the account picker, kept apart from the
 * service so the unit tests can drive them with plain data.
 */

/** What a page submitted, as the forms script reported it. */
export interface LoginCandidate {
  origin: string
  /** The page the form was on (what a new login is stored under). */
  url: string
  username: string
  password: string
  /** The form was a sign-up or change-password form (`autocomplete="new-password"`). */
  newPassword: boolean
}

export type SaveDecision =
  | { kind: 'save' }
  | { kind: 'update'; existing: Credential }
  | {
      kind: 'none'
      reason: 'empty' | 'disabled' | 'private' | 'never' | 'saved'
      /** `saved`: the login that already holds these credentials (its last use is recorded). */
      existing?: Credential
    }

export interface SaveContext {
  /** Settings → Passwords → Offer to save. */
  offerToSave: boolean
  /** The tab is in a private container. */
  isPrivate: boolean
  /** The site is on the never-save list. */
  neverSave: boolean
  /** Saved logins usable on the page's origin (`CredentialStore.findForOrigin`). */
  matches: Credential[]
}

const sameUser = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Save, update or stay quiet. A submitted username that matches a saved login with another
 * password is an update; the same password again is nothing new; an unknown username is a new
 * login. A form without a username field updates the one saved login of the site when its
 * password changed, and stays quiet when several are saved (there is no telling which one).
 */
export function decideSave(candidate: LoginCandidate, context: SaveContext): SaveDecision {
  if (!candidate.password) return { kind: 'none', reason: 'empty' }
  if (context.isPrivate) return { kind: 'none', reason: 'private' }
  if (context.neverSave) return { kind: 'none', reason: 'never' }
  if (!context.offerToSave) return { kind: 'none', reason: 'disabled' }
  const username = candidate.username.trim()
  if (username) {
    const same = context.matches.filter((c) => sameUser(c.username, username))
    const exact = same.find((c) => c.password === candidate.password)
    if (exact) return { kind: 'none', reason: 'saved', existing: exact }
    // Prefer the login saved for exactly this origin; then the most recently used one.
    const existing =
      same.find((c) => c.origin === candidate.origin) ??
      same.sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))[0]
    if (existing) return { kind: 'update', existing }
    return { kind: 'save' }
  }
  const exact = context.matches.find((c) => c.password === candidate.password)
  if (exact) return { kind: 'none', reason: 'saved', existing: exact }
  if (context.matches.length === 1) return { kind: 'update', existing: context.matches[0] }
  if (context.matches.length > 1) return { kind: 'none', reason: 'saved' }
  return { kind: 'save' }
}

/**
 * Order saved logins for the picker of a page at `pageOrigin`: logins stored under this exact
 * origin first, then those of sibling subdomains (same registrable domain), each group most
 * recently used first. The second line of a sibling shows its own site.
 */
export function orderLoginsForPicker(
  matches: Credential[],
  pageOrigin: string
): { credential: Credential; subtitle: string }[] {
  const recency = (c: Credential): number => c.lastUsedAt ?? c.updatedAt
  return [...matches]
    .sort((a, b) => {
      const exact = Number(b.origin === pageOrigin) - Number(a.origin === pageOrigin)
      return exact !== 0 ? exact : recency(b) - recency(a)
    })
    .map((credential) => ({
      credential,
      subtitle: credential.origin === pageOrigin ? '' : siteLabel(credential.origin)
    }))
}

/**
 * Where the page's field sits in the chrome: the field rectangle arrives in the page's CSS
 * pixels relative to the view's top-left corner (visual viewport), so it is scaled by the page
 * zoom and moved by the view's position in the window. The result is clipped to the view.
 */
export function anchorInChrome(field: Rect, view: Rect, zoom: number): Rect {
  const scale = zoom > 0 ? zoom : 1
  const x = view.x + field.x * scale
  const y = view.y + field.y * scale
  const width = field.width * scale
  const height = field.height * scale
  const left = Math.max(view.x, Math.min(view.x + view.width, x))
  const top = Math.max(view.y, Math.min(view.y + view.height, y))
  const right = Math.max(left, Math.min(view.x + view.width, x + width))
  const bottom = Math.max(top, Math.min(view.y + view.height, y + height))
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  }
}

/** The picker popover's width (design-language-v2-draft §9.20: 320 for a list without trailing controls). */
export const PICKER_WIDTH = 320
/** Transparent margin around the panel inside the popup surface, where its shadow draws. */
export const PICKER_SURFACE_PAD = 8
/** How close the panel may come to the window's edges. */
const PICKER_MARGIN = 8
/** The panel never grows past this share of the window; its list scrolls instead. */
const PICKER_MAX_SHARE = 0.6
/** Minimum height of the panel, whatever the page reports. */
const PICKER_MIN_HEIGHT = 40

/** The panel's 16 padding above and below its rows (§9.20). */
const PICKER_PADDING = 16
/** One-line rows (a login with no site line) and two-line rows (§9.2). */
const PICKER_ROW = 32
const PICKER_ROW_TWO_LINE = 52
/** The hairline and its 4px margins before the manage row, then the manage row itself. */
const PICKER_MANAGE_BLOCK = 9 + PICKER_ROW

/**
 * How tall the picker's panel comes out for `count` rows – all one-line, or all two-line when any
 * item has a subtitle – before its document has measured itself. The surface opens at this
 * height and follows the document's `autofill.surfaceSize` report afterwards.
 */
export function estimatePickerHeight(count: number, twoLine: boolean): number {
  const row = twoLine ? PICKER_ROW_TWO_LINE : PICKER_ROW
  return PICKER_PADDING * 2 + Math.max(1, count) * row + PICKER_MANAGE_BLOCK
}

/**
 * Where the popup surface that carries the picker goes, in window CSS pixels: its panel hangs
 * from the field – the panel's top border on the field's bottom edge, start edges aligned (gap 0,
 * no arrow, §9.20) – and flips above the field when the room below is short and there is more
 * above. `panelHeight` is what the picker's document asked for; the panel is clamped to 60% of
 * the window and to the room on its side, and the surface adds `PICKER_SURFACE_PAD` all around
 * for the panel's shadow. Pure; the anchor is `anchorInChrome`'s rect.
 */
export function placePickerSurface(
  anchor: Rect,
  viewport: { width: number; height: number },
  panelHeight: number
): Rect {
  const pad = PICKER_SURFACE_PAD
  const width = PICKER_WIDTH
  let left = anchor.x
  left = Math.min(Math.max(PICKER_MARGIN, left), viewport.width - width - PICKER_MARGIN)
  const below = viewport.height - (anchor.y + anchor.height) - PICKER_MARGIN
  const above = anchor.y - PICKER_MARGIN
  const cap = Math.max(PICKER_MIN_HEIGHT, Math.floor(viewport.height * PICKER_MAX_SHARE))
  const wanted = Math.max(PICKER_MIN_HEIGHT, Math.min(Math.ceil(panelHeight), cap))
  const flip = wanted > below && above > below
  const room = Math.max(PICKER_MIN_HEIGHT, flip ? above : below)
  const height = Math.min(wanted, room)
  const top = flip ? anchor.y - height : anchor.y + anchor.height
  return {
    x: Math.round(left - pad),
    y: Math.round(top - pad),
    width: width + pad * 2,
    height: Math.round(height + pad * 2)
  }
}

/** `60 s`, `2 min`, `1 h` for the copy toast. */
export function clearsInLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}
