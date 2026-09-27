import type { ReactElement } from 'react'
import { nativeHoverCard } from '@renderer/lib/hoverCard'

/**
 * The native tab hover card's text in the chrome's document (TABLET-05, the lead's (g)): while
 * the host draws the card above the live page (`Host.kt`, from the frames `lib/hoverCard.ts`
 * sends), a visually hidden node under the desktop card's id – `#zen-tab-hover-card`,
 * `role="tooltip"` – holds the frame's title, host and state lines in the order the desktop card
 * renders them, so the focused row describes itself by the card (`TabItem`'s `aria-describedby`,
 * `useHoverCardUp`) exactly as a desktop row does by the DOM card. The native layer stays
 * `NO_HIDE_DESCENDANTS`, so nothing speaks twice.
 *
 * Mounted once, at Android's root beside the shell (`main.tsx`): the description has one home
 * for every layout of the chrome that raises the native card – the tablet, whose
 * `TabletHoverCardHost` counts as the card's host and binds its dismissals, and the desktop
 * class (a mouse under DeX: `lib/formFactor.ts`), whose `TabHoverCard` counts as the host but
 * renders no node of its own on the native path. One `#zen-tab-hover-card` per document follows
 * from the controller writing exactly one of its two slices: the desktop card's node stands with
 * `ui.hoverCard`, this one with `nativeHoverCard`, never both.
 */
export function NativeHoverCardDescription(): ReactElement | null {
  const frame = nativeHoverCard.use((s) => s.frame)
  if (!frame) return null
  return (
    <div id="zen-tab-hover-card" role="tooltip" className="sr-only" data-tab-id={frame.tabId}>
      <div>{frame.title}</div>
      {frame.host && <div>{frame.host}</div>}
      {frame.lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  )
}
