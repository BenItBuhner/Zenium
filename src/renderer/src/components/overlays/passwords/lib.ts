import type { RefObject, UIEvent } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CredentialSummary, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { relativeTime } from '@renderer/lib/utils'
import { topBackSurface } from '@renderer/lib/back'
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

/*
 * The modal layers over the manager's page – the re-authentication prompt, a phone menulist's
 * picker sheet – counted so the page knows it is the lower surface of a stack (v2 §9.24,
 * §11.2): inert, and on a phone receded, while any of them is up.
 */
let layersOverPage = 0
const layerListeners = new Set<() => void>()

function subscribeLayers(listener: () => void): () => void {
  layerListeners.add(listener)
  return () => layerListeners.delete(listener)
}

/** Hold the manager's page under this layer for as long as the component is mounted. */
export function useOverPage(): void {
  useEffect(() => {
    layersOverPage++
    for (const listener of layerListeners) listener()
    return () => {
      layersOverPage--
      for (const listener of layerListeners) listener()
    }
  }, [])
}

/** Whether a modal layer is up over the manager's page. */
export function useUnderLayer(): boolean {
  return useSyncExternalStore(subscribeLayers, () => layersOverPage > 0)
}

/**
 * Escape for a surface stacked over the Passwords overlay. The surface is registered under
 * `name` in the back registry (a `useBackSurface` or `useBackDismissal` alongside); it takes
 * the key only while it is the topmost surface, before the window handler that would close
 * the whole overlay – so a prompt pops before the pane under it, and the pane before the panel.
 */
export function useEscape(name: string, close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || topBackSurface()?.name !== name) return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [name])
}

/**
 * Keyboard reach into a dialog or sheet (v2 §9.22). The dialog is the nearest `role="dialog"`
 * around `ref` (the desktop prompt's own box, the shared `BottomSheet` on a phone with its
 * grabber first in the order). On open, focus moves into it – the first field, else the first
 * control, else the container – unless something inside already has it; Tab and Shift+Tab wrap
 * inside it; when it closes, focus returns to the control that opened it, except after a click
 * that landed on another control, which keeps the focus it took.
 */
export function useFocusReach(ref: RefObject<HTMLElement | null>): void {
  // The opener is whatever had focus before the first render put a field in front of it.
  const [anchor] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>('[role="dialog"]') ?? ref.current
    if (!root) return
    if (!root.contains(document.activeElement)) {
      const items = tabbables(root)
      const first = items.find((el) => el.matches('input, textarea, select')) ?? items[0] ?? root
      first.focus({ preventScroll: true })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      const items = tabbables(root)
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (!root.contains(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const active = document.activeElement
      const lost = !active || active === document.body || root.contains(active)
      if (lost && anchor?.isConnected) anchor.focus({ preventScroll: true })
    }
  }, [ref, anchor])
}

/** The elements Tab visits inside `root`, in order. */
function tabbables(root: HTMLElement): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex]'
  )
  return [...all].filter(
    (el) =>
      !el.matches(':disabled, [tabindex="-1"], [inert], [inert] *') &&
      el.getClientRects().length > 0
  )
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
