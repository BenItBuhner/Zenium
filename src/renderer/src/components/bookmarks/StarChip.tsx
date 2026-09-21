import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Star } from 'lucide-react'
import type { Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { closeBookmarkChrome, uiStore } from '@renderer/lib/ui'
import { PillChip } from '../urlbar/PillChip'
import { TOOLBAR_STROKE } from '../v2/controls'

/**
 * The star at the trailing end of the address pill: an outline until the page is bookmarked,
 * filled (in accent ink) once it is. Pressing it stars the page and opens the bubble; pressing
 * it again puts the bubble away. When a page becomes bookmarked while it is on screen the fill
 * comes in over 120ms and the glyph pops once it is full. `title` is the tooltip: the label
 * with the bookmark chord from the active key table, which the pill knows.
 */
export function StarChip({
  tab,
  filled,
  title,
  collapsed = false
}: {
  tab: Tab
  filled: boolean
  title: string
  /**
   * The pill cannot hold the star beside its address (`pillChipTiers.ts`, §9.29): it stays
   * away – Bookmark This Tab is in the app menu, the tab's menu and on Ctrl+D – unless its
   * bubble is up, which keeps its anchor (§9.20).
   */
  collapsed?: boolean
}): JSX.Element | null {
  const glyph = useRef<HTMLSpanElement>(null)
  const shown = useRef({ tabId: tab.id, filled })
  useEffect(() => {
    const was = shown.current
    shown.current = { tabId: tab.id, filled }
    if (!filled || was.filled || was.tabId !== tab.id || reducedMotion()) return
    glyph.current?.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.25)', offset: 0.5 },
        { transform: 'scale(1)' }
      ],
      { duration: 180, delay: 120, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    )
  }, [filled, tab.id])

  const open = uiStore.use((s) => s.starDialog?.tabId === tab.id)
  if (collapsed && !open) return null
  // One of the pill's chips (`PillChip`, v2 draft §9.22): a real button in the tab order after
  // the address, whose popup is the bubble. A 28px icon button (§9.3) that keeps its pressed
  // fill and `aria-expanded` while the bubble is open (§9.20). Whether the page is bookmarked is
  // in its name and `data-filled`, not `aria-pressed`: a chip opens something or toggles, never
  // both.
  return (
    <PillChip
      label={filled ? 'Edit bookmark' : 'Bookmark this tab'}
      title={title}
      popup="dialog"
      expanded={open}
      data-bm-star=""
      data-filled={filled}
      data-open={open}
      className="zen-bm-star -mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]"
      onActivate={() => {
        // The bubble commits its pending name as it goes; the chip that put it away keeps the
        // keyboard, as the anchor does after Escape (§9.22).
        if (open) closeBookmarkChrome({ starDialog: null }, { keepFocus: true })
        else run('bookmark.star', { tabId: tab.id })
      }}
    >
      <span ref={glyph} className="flex">
        <Star className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
      </span>
    </PillChip>
  )
}
