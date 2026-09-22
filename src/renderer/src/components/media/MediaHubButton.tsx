import type { JSX } from 'react'
import { SquarePlay } from 'lucide-react'
import type { UIState } from '@shared/types'
import {
  mediaHubEntries,
  mediaHubLabel,
  mediaPlaying,
  toggleMediaHub
} from '@renderer/lib/mediaHub'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { TOOLBAR_STROKE } from '../v2/controls'

/**
 * The accent dot that says something plays: on the hub's toolbar button, and – the same dot,
 * the same token, the window's `--zen-accent` (§9.29) – on the "⋯" menu button while that
 * toolbar button has folded, Firefox's badge on its menu button, since the menu's "Now
 * playing…" row is then where the hub goes. One of the two wears it, never both. Decorative:
 * the button it sits on names the state.
 */
export function MediaLiveDot({ state }: { state: UIState }): JSX.Element | null {
  if (!mediaPlaying(state)) return null
  return <span className="zen-mhub-dot" aria-hidden />
}

/**
 * Chrome's global media controls button (MW-16) in the toolbar row: there while any tab has
 * media to control (playing, or paused since), gone with the last one – as Chrome's is. Its
 * press opens the hub's popover (`MediaHubPopover`) under the row, end-aligned with it, and
 * closes it again (the chrome layer's light dismiss takes a pointer press while the popover is
 * up; the keyboard's press gets here). The tooltip is Chrome's line for the button.
 */
export function MediaHubButton({ state }: { state: UIState }): JSX.Element | null {
  const entries = mediaHubEntries(state)
  if (entries.length === 0) return null
  const label = mediaHubLabel(entries)
  return (
    <button
      type="button"
      data-zen-media-hub-button
      // The pressed fill while the popover is up is the toolbar button's own, off `aria-expanded`
      // – which the popover holds `true` on whichever control is its anchor for its life
      // (`holdExpanded`: this button, or the "⋯" it has folded into) and gives back to the rest
      // value written here, so one writer says what the anchor has open.
      className="zen-toolbar-button relative"
      title="Control your music, videos and more"
      aria-label={label}
      aria-expanded={false}
      aria-haspopup="dialog"
      onClick={() => toggleMediaHub({ fromKeyboard: openedFromKeyboard() })}
    >
      <SquarePlay className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      <MediaLiveDot state={state} />
    </button>
  )
}
