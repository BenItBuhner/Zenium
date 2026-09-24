import type { JSX } from 'react'
import type { Tab } from '@shared/types'
import { Favicon } from './Favicon'

/**
 * The favicon's seat on a pinned row or an Essentials tile (tabs-11): the favicon and, while the
 * tab asks for attention (`Tab.attention` – its page changed its title while the tab was not in
 * front), Chrome's attention indicator: a 6 px disc in the window's accent at the favicon's
 * top-right corner, its edges 1 px outside the favicon's box on both sides, the favicon punched
 * out 1 px around it so the dot reads on any icon (Chrome's `TabIcon` clears the same ring). The
 * seat is the favicon's own box – 16 in a row, 20 in a tile, never shrinking – so nothing beside
 * it moves when the dot comes or goes; the dot is full ink (§9.29: a badge is never dimmed with
 * its row's rest opacity – a sleeping row dims its favicon, not the dot) and says nothing itself:
 * the row's description carries the word (`tabRowStates`).
 *
 * One disc per icon (§9.29, the lead's #436 ruling 3): where the icon is `marked` already – the
 * Essentials tile's audio disc while its tab plays – the attention dot yields: no second disc,
 * no punch-out, and the flag stands in the words alone until the sound stops or is muted, when
 * the dot draws. A pinned row's audio is a glyph in its trailing slot, not a disc on the icon,
 * so the row's dot never yields.
 */
export function FaviconSeat({
  tab,
  size = 16,
  marked = false
}: {
  tab: Tab
  size?: number
  marked?: boolean
}): JSX.Element {
  const attention = tab.attention === true && !marked
  return (
    <span
      className="zen-favicon-seat"
      style={{ width: size, height: size }}
      data-attention={attention || undefined}
    >
      <Favicon tab={tab} size={size} />
      {attention && <span className="zen-attention-dot" aria-hidden />}
    </span>
  )
}
