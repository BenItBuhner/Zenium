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

/** `60 s`, `2 min`, `1 h` for the copy toast. */
export function clearsInLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}
