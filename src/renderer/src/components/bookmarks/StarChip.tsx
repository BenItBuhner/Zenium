import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Star } from 'lucide-react'
import type { Tab } from '@shared/types'
import { run } from '@renderer/lib/api'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { closeBookmarkChrome, uiStore } from '@renderer/lib/ui'

/**
 * The star at the trailing end of the address pill: an outline until the page is bookmarked,
 * filled (in accent ink) once it is. Pressing it stars the page and opens the bubble; pressing
 * it again puts the bubble away. When a page becomes bookmarked while it is on screen the fill
 * comes in over 120ms and the glyph pops once it is full.
 */
export function StarChip({ tab, filled }: { tab: Tab; filled: boolean }): JSX.Element {
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
  // A 28px icon button (v2 draft §9.3) that keeps its pressed fill while its bubble is open
  // (§9.20). Its tab stop is the pill's business: every chip in the pill is `tabIndex -1` today
  // and §9.22 makes them real buttons in one pass over the pill.
  return (
    <span
      role="button"
      tabIndex={-1}
      data-bm-star
      data-filled={filled}
      data-open={open}
      aria-label={filled ? 'Edit bookmark' : 'Bookmark this tab'}
      aria-pressed={filled}
      aria-haspopup="dialog"
      aria-expanded={open}
      className="zen-bm-star -mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]"
      title={filled ? 'Edit bookmark (Ctrl+D)' : 'Bookmark this tab (Ctrl+D)'}
      onClick={(e) => {
        e.stopPropagation()
        // The bubble commits its pending name as it goes.
        if (open) closeBookmarkChrome({ starDialog: null })
        else run('bookmark.star', { tabId: tab.id })
      }}
    >
      <span ref={glyph} className="flex">
        <Star className="h-4 w-4" />
      </span>
    </span>
  )
}
