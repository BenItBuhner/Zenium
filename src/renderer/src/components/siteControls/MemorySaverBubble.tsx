import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Leaf } from 'lucide-react'
import type { UIState } from '@shared/types'
import { getDomain } from '@shared/url'
import { announce } from '@renderer/lib/announce'
import { run } from '@renderer/lib/api'
import { POPOVER_WIDTH } from '@renderer/lib/portals'
import { activeTab, isPrivateWindow } from '@renderer/lib/selectors'
import { memorySaverLabel } from '@renderer/lib/siteChips'
import { siteChip, siteChipRects } from '@renderer/lib/surfaces'
import { closeMemorySaverBubble, type UiState } from '@renderer/lib/ui'
import { V2_GLYPH } from '../v2/controls'
import { DesktopPopover, ListRow, Separator, TitleBlock } from './primitives'

type Bubble = NonNullable<UiState['memorySaverBubble']>

/** The bubble's sentence under its title: Chrome's, in Zenium's name (§9.1). */
export const MEMORY_SAVER_DETAIL = 'This tab was inactive, so Zenium unloaded it to free memory.'

/**
 * Chrome's Memory Saver bubble (omnibox-40): a 320 notice under the pill's site-information
 * slot, opened by a click on the leaf the slot shows for ten seconds after a tab wakes from
 * sleep (`Tab.memorySaver`, `lib/siteChips.ts`). A title block (§9.23) – the leaf on the
 * title's start, "Memory Saver freed up N MB" with the number the core recorded at the
 * discard, the one sentence on why – and, below a hairline, the Never unload this site row: a
 * menu-style row (§9.20's list-panel footer) that puts the site's registrable domain on the
 * never-sleep list (`settings.unloadExcludedDomains`, the form Settings' Add current site
 * writes; the core matches a page by host or by that domain) and closes the bubble. No row in
 * a private window (its sites are nothing to remember) or for a site already on the list. A
 * desktop popover (§9.20) through the chrome layer: light dismiss, Escape back to the slot,
 * the leaf held in the slot while it is up; another tab coming forward, the tab going, or the
 * tab sleeping again put it away.
 */
export function MemorySaverBubble({
  state,
  bubble
}: {
  state: UIState
  bubble: Bubble
}): JSX.Element | null {
  const tab = state.tabs[bubble.tabId]
  const saver = tab?.memorySaver ?? null
  const active = activeTab(state)
  const gone = !tab || active?.id !== bubble.tabId || !saver
  // Hangs from the slot, measured again on a window resize; the slot never leaves the pill
  // while the bubble is up (the leaf is held for it), so the anchor is always there.
  const [rects, setRects] = useState(siteChipRects)
  useEffect(() => {
    const measure = (): void => setRects(siteChipRects())
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const [savedMb] = useState(() => saver?.savedMb ?? 0)
  const titleId = 'zen-memory-saver-title'
  const domain = tab && !isPrivateWindow(state) ? getDomain(tab.url) : ''
  const listed =
    domain !== '' && state.settings.unloadExcludedDomains.some((d) => d.toLowerCase() === domain)
  const neverUnload = (close: () => void): void => {
    if (!domain || listed) return
    run('settings.update', {
      unloadExcludedDomains: [...state.settings.unloadExcludedDomains, domain]
    })
    announce(`${domain} will not be unloaded`)
    close()
  }
  return (
    <DesktopPopover
      anchor={rects.anchor}
      bar={rects.bar}
      width={POPOVER_WIDTH.list}
      labelledBy={titleId}
      closing={gone}
      onClosed={(byKey) => closeMemorySaverBubble({ keepFocus: byKey })}
      focus="first"
      anchorElement={siteChip}
      data-testid="memory-saver-bubble"
      data-saved-mb={String(savedMb)}
    >
      {({ close }) => (
        <>
          <TitleBlock
            id={titleId}
            glyph={<Leaf className={V2_GLYPH} aria-hidden />}
            title={memorySaverLabel(savedMb)}
            description={MEMORY_SAVER_DETAIL}
          />
          {domain !== '' && !listed && (
            <div className="pb-1">
              <Separator />
              <ListRow
                label="Never unload this site"
                onClick={() => neverUnload(close)}
                aria-label={`Never unload ${domain}`}
                data-never-unload={domain}
              />
            </div>
          )}
        </>
      )}
    </DesktopPopover>
  )
}
