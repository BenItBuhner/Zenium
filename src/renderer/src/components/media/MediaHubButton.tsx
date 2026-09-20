import type { JSX } from 'react'
import { SquarePlay } from 'lucide-react'
import type { UIState } from '@shared/types'
import { mediaHubEntries, mediaHubLabel, mediaHubUi, toggleMediaHub } from '@renderer/lib/mediaHub'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { cn } from '@renderer/lib/utils'

/** The button the hub's popover hangs from and returns the keyboard to (§9.22). */
export const MEDIA_HUB_BUTTON = '[data-zen-media-hub-button]'

/**
 * Chrome's global media controls button (MW-16) in the toolbar row: there while any tab has
 * media to control (playing, or paused since), gone with the last one – as Chrome's is. Its
 * press opens the hub's popover (`MediaHubPopover`) under the row, end-aligned with it, and
 * closes it again (the chrome layer's light dismiss takes a pointer press while the popover is
 * up; the keyboard's press gets here). The tooltip is Chrome's line for the button.
 */
export function MediaHubButton({ state }: { state: UIState }): JSX.Element | null {
  const open = mediaHubUi.use((s) => s.open)
  const entries = mediaHubEntries(state)
  if (entries.length === 0) return null
  const label = mediaHubLabel(entries)
  return (
    <button
      type="button"
      data-zen-media-hub-button
      className={cn('zen-toolbar-button relative', open && 'bg-[var(--zen-element-bg)]')}
      title="Control your music, videos and more"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => toggleMediaHub({ fromKeyboard: openedFromKeyboard() })}
    >
      <SquarePlay className="h-4 w-4" strokeWidth={1.5} />
      {entries.some((m) => m.playing) && <span className="zen-mhub-dot" aria-hidden />}
    </button>
  )
}
