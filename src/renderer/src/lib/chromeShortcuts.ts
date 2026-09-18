import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Events } from '@shared/types'

/**
 * Chrome shortcuts a page tab may claim for itself.
 *
 * A chrome page (`shared/internalPages.ts`, `render: 'chrome'`) lives in the chrome document, so
 * the keys the core turns into chrome events reach it as any other part of the chrome: Ctrl+L
 * opens the URL bar, Escape closes what is on top, Ctrl+F opens the find bar. Some of those the
 * page has a better answer to – Ctrl+F on Settings focuses "Find in Settings" (Firefox's
 * about:preferences, Chrome's chrome://settings), where the find bar would search a page that
 * has no text to search. A page claims such an event while it is showing
 * ({@link useChromeShortcut}); the chrome offers every claimable event to the claims first
 * ({@link offerChromeShortcut}, in `useMainEvents`) and keeps its own meaning for whatever no one
 * takes. Everything not listed in {@link ClaimableShortcut} stays the chrome's, always.
 *
 * A claim answers `true` when it took the event; the most recent claim is asked first, so a
 * surface stacked over a page (a sheet of its own) can take the key ahead of the page beneath.
 * This is the hook the interface doc (`internal-page-tabs.md` §7) names for the desktop's pages.
 */
export type ClaimableShortcut = 'find.open'

/** A claim: given the event's payload, take it (`true`) or leave it to the chrome (`false`). */
export type ShortcutClaim<K extends ClaimableShortcut> = (payload: Events[K]) => boolean

type Claims = { [K in ClaimableShortcut]: ShortcutClaim<K>[] }

const claims: Claims = { 'find.open': [] }

/** Register a claim on `action`; returns the release. Later claims are asked before earlier ones. */
export function claimChromeShortcut<K extends ClaimableShortcut>(
  action: K,
  claim: ShortcutClaim<K>
): () => void {
  const list = claims[action] as ShortcutClaim<K>[]
  list.push(claim)
  return () => {
    const at = list.indexOf(claim)
    if (at >= 0) list.splice(at, 1)
  }
}

/**
 * Offer a chrome event to the pages' claims: `true` when one took it and the chrome must not act
 * on it itself.
 */
export function offerChromeShortcut<K extends ClaimableShortcut>(
  action: K,
  payload: Events[K]
): boolean {
  const list = claims[action] as ShortcutClaim<K>[]
  for (let i = list.length - 1; i >= 0; i--) if (list[i](payload)) return true
  return false
}

/**
 * Claim `action` for as long as the component is mounted and `claim` is not null. The latest
 * `claim` is what runs, without re-registering (so the claim's place in the order is where the
 * component mounted, not where it last rendered).
 */
export function useChromeShortcut<K extends ClaimableShortcut>(
  action: K,
  claim: ShortcutClaim<K> | null
): void {
  const latest = useRef(claim)
  useLayoutEffect(() => {
    latest.current = claim
  }, [claim])
  const active = claim !== null
  useEffect(() => {
    if (!active) return
    return claimChromeShortcut(action, (payload: Events[K]) => latest.current?.(payload) ?? false)
  }, [action, active])
}

/** Test seam: forget every claim. */
export function resetChromeShortcutClaims(): void {
  for (const key of Object.keys(claims) as ClaimableShortcut[]) claims[key].length = 0
}
