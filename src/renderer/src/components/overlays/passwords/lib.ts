import type { UIEvent } from 'react'
import { useState } from 'react'
import { NOTE_MAX_LENGTH, type CredentialSummary, type UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { relativeTime } from '@renderer/lib/utils'
import { useViewport } from '@renderer/lib/formFactor'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay } from '@renderer/lib/ui'

/** The smallest passphrase the vault accepts (mirrors `PasswordService.setPassphrase`). */
export const MIN_PASSPHRASE = 8

export const DOT_MASK = '••••••••••••'

/** The phone layout: the header menulist, panes over the full page, stacked rows (v2 §5, §6). */
export function usePhone(): boolean {
  return useViewport().formFactor === 'phone'
}

/** Tracks whether a scroller has left its top, for the header hairline (v2 §9.7). */
export function useScrolled(): { scrolled: boolean; onScroll: (e: UIEvent<HTMLElement>) => void } {
  const [scrolled, setScrolled] = useState(false)
  return {
    scrolled,
    onScroll: (e) => {
      const next = e.currentTarget.scrollTop > 0
      if (next !== scrolled) setScrolled(next)
    }
  }
}

/** Open the login's page (or its origin) in a new tab and close the manager. */
export function openSite(
  state: UIState,
  credential: Pick<CredentialSummary, 'url' | 'origin'>
): void {
  const tab = activeTab(state)
  run('urlbar.submit', {
    input: credential.url || credential.origin,
    newTab: true,
    tabId: tab?.id ?? null
  })
  closeOverlay()
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/** `relativeTime` mid-sentence ("Changed just now"): the shared helper capitalises "Just now". */
export function relativeTimeInSentence(ts: number): string {
  const text = relativeTime(ts)
  return text === 'Just now' ? 'just now' : text
}

/** How close to Chrome's note limit (ID-34) the counter under the field comes up. */
export const NOTE_COUNTER_FROM = NOTE_MAX_LENGTH - 100

/**
 * The note field's counter, "940 / 1000", once the note is within a hundred characters of the
 * limit (the field clips there); nothing before, so a short note has no number under it.
 */
export function noteCounter(length: number): string | undefined {
  return length >= NOTE_COUNTER_FROM ? `${length} / ${NOTE_MAX_LENGTH}` : undefined
}

/**
 * The validation text for a note over the limit – one that arrived by sync from a device
 * without the clip – which holds Save until it is shortened; null while the note fits.
 */
export function noteOverLimit(length: number): string | null {
  const over = length - NOTE_MAX_LENGTH
  if (over <= 0) return null
  return `The note is ${over} ${over === 1 ? 'character' : 'characters'} over the limit of ${NOTE_MAX_LENGTH}`
}

/** The same match as `CredentialStore.search`: every term somewhere in site, URL, username or notes. */
export function matchLogins(list: CredentialSummary[], query: string): CredentialSummary[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return list
  return list.filter((c) => {
    const hay = `${c.origin} ${c.url} ${c.username} ${c.notes}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

/** The host of a login's origin; the origin itself when it is not a URL. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

/** Alphabetical groups of logins by registrable domain, usernames then hosts sorted inside each. */
export function groupBySite(
  list: CredentialSummary[]
): Array<{ domain: string; favicon: string | null; entries: CredentialSummary[] }> {
  const groups = new Map<string, CredentialSummary[]>()
  for (const c of list) {
    const key = c.domain
    const entries = groups.get(key)
    if (entries) entries.push(c)
    else groups.set(key, [c])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, entries]) => ({
      domain,
      favicon: entries.find((e) => e.favicon)?.favicon ?? null,
      entries: entries.sort(
        (a, b) =>
          a.username.localeCompare(b.username) || hostOf(a.origin).localeCompare(hostOf(b.origin))
      )
    }))
}

/** The host of whatever the user typed, for the generator's per-site rules (undefined when unclear). */
export function domainFromInput(input: string): string | undefined {
  const text = input.trim()
  if (!text) return undefined
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname
    return host.includes('.') ? host : undefined
  } catch {
    return undefined
  }
}
