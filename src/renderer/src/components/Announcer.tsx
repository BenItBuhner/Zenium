import type { JSX } from 'react'
import { announcerStore } from '@renderer/lib/announce'

/**
 * The chrome's one status region (v2 draft §9.30; parity row a11y-27): `role="status"` – polite,
 * so it waits for what the reader is saying, and atomic, so a message is read whole – visually
 * hidden, and told what `announce` (lib/announce.ts) was given: the tab that came to the front,
 * a download's start and end, the find bar's count, a zoom step, a tab muted or unmuted. The
 * words render under a key per message, so the same words said again later (a zoom key at the
 * ladder's end) come as a fresh node the reader picks up; `announce` empties the region a few
 * seconds after each message, so a reader that lands on it later finds nothing stale.
 */
export function Announcer(): JSX.Element {
  const { text, seq } = announcerStore.use()
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-announcer="">
      {text && <span key={seq}>{text}</span>}
    </div>
  )
}
