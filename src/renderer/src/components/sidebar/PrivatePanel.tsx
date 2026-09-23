import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { VenetianMask } from 'lucide-react'
import type { UIState } from '@shared/types'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { listMotions } from '@renderer/lib/drag'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { privateLockStore, usePrivateMasked } from '@renderer/lib/privateLock'
import { privateTabsOf } from '@renderer/lib/privateTabs'
import { activeTab, rowKey, stripRows } from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { PrivateLockCover } from '../phone/PrivateLockCover'
import { ENTER_BATCH, ListMotionContext } from './listMotion'
import { NewTabButton, StripRowItem } from './SpacePanel'

interface Props {
  state: UIState
  compact: boolean
}

/**
 * The sidebar's PRIVATE pose (`sidebarPose`, W4-11): on while a private tab is in view on a
 * host that keeps private browsing in tabs (the tablet), the window on the private theme. In
 * place of the space's panels it lists the private session's tabs alone – across the spaces in
 * the Private pane's order (`privateTabsOf`: the session is one, a private tab opening in the
 * space it was asked for in) – under the mask's header, with New Private Tab as its row: the
 * phone's Private pane in the sidebar's rows (§9.36). The session is not a workspace: its rows
 * are neither pinned nor grouped here (the pane's rule), and nothing of the workspaces shows on
 * it – no Essentials, no space header, no spaces row at the foot (`SidebarBottom`).
 *
 * Under the lock (INC-05, #250) the pose is under the lock cover as the phone's Private pane is,
 * in the veil form (`PrivateLockCover`, `variant="veil"`): the rows read "Private tab" behind
 * the mask (`TabItem`), the list and its New Private Tab lie inert under the veil – no focus,
 * no touch, nothing for a screen reader – and the one Unlock is the content frame's cover's,
 * beside it over the tab in view; the header stays, as the overview's does. The veil lifts on
 * the cover's spring with the frame's as the lock comes off, the titles coming back under it.
 */
export function PrivatePanel({ state, compact }: Props): JSX.Element {
  const tabs = privateTabsOf(state)
  const activeTabId = activeTab(state)?.id ?? null
  const locked = privateLockStore.use((s) => s.locked)
  // Masked while the lock stands or is lifting: the rows are placeholders, out of reach.
  const masked = usePrivateMasked()
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y' })

  // The rows' motion, the space panel's (`SpacePanel`): one per list, keyed by its scroller so
  // lib/drag.ts finds it from a row.
  const [motion] = useState(() => new SlideMotion('y', { enter: true, batch: ENTER_BATCH }))
  useEffect(() => () => motion.dispose(), [motion])
  const scroller = useCallback(
    (el: HTMLDivElement | null) => {
      const teardown = fade(el)
      motion.setScroller(el)
      if (el) listMotions.set(el, motion)
      return () => {
        if (typeof teardown === 'function') teardown()
        motion.setScroller(null)
      }
    },
    [fade, motion]
  )
  const orderKey = tabs.map((t) => t.id).join('|')
  useLayoutEffect(() => {
    motion.flip(uiStore.get().drag?.tabId ?? null, true)
  }, [motion, orderKey])

  return (
    <ListMotionContext.Provider value={motion}>
      <PrivateHeader count={tabs.length} compact={compact} />
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          data-tab-scroller
          data-active="true"
          className="flex h-full flex-col overflow-y-auto overflow-x-hidden px-2 pb-1"
          // Under the veil the list is out of reach until the cover lifts (the overview's
          // Private pane's rule); the rows read the placeholder meanwhile, for a reader that
          // reaches one all the same.
          inert={masked || undefined}
          aria-hidden={masked || undefined}
        >
          {/* One tablist, vertical (a11y-07, a11y-31); New Private Tab is the strip's next
              control after it. */}
          <div
            className="flex flex-col gap-0.5"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Private tabs"
            data-tab-list="private"
          >
            {stripRows(tabs, state.splitGroups).map((row) => (
              <StripRowItem
                key={rowKey(row)}
                row={row}
                activeTabId={activeTabId}
                compact={compact}
              />
            ))}
          </div>
          <NewTabButton
            compact={compact}
            spaced={tabs.length > 0}
            dropInto={false}
            pane="private"
          />
        </div>
        <PrivateLockCover shown={locked} variant="veil" />
      </div>
    </ListMotionContext.Provider>
  )
}

/**
 * The private pose's header, where the regular pose has the space's: a row on the rows' pitch
 * (the space header's 40 on the tablet, `.zen-sidebar-private-header`) with the mask glyph in
 * the glyph slot (§9.19: 16 at the row stroke), "Private" as §4's small label in full ink –
 * the name of the mode, never deemphasised (§9.29) – and the count as a 13 tabular aside at
 * 69%, the group row's (§10.3's trailing aside). The rail shows the mask alone. A heading,
 * not a control: nothing folds here.
 */
function PrivateHeader({ count, compact }: { count: number; compact: boolean }): JSX.Element {
  const unit = count === 1 ? 'tab' : 'tabs'
  return (
    <h2
      className={cn(
        'zen-sidebar-private-header mx-2 mb-1 flex h-[var(--zen-tab-row)] shrink-0 items-center gap-2 rounded-lg px-2 text-[13px] font-semibold text-[var(--zen-fg)]',
        compact && 'justify-center px-0'
      )}
      aria-label={`Private, ${count} ${unit}`}
      title={compact ? 'Private' : undefined}
      data-testid="sidebar-private-header"
    >
      <VenetianMask className="h-4 w-4 shrink-0" aria-hidden />
      {!compact && (
        <>
          <span className="min-w-0 flex-1 truncate text-left">Private</span>
          <span className="zen-group-row-count" aria-hidden>
            {count}
          </span>
        </>
      )}
    </h2>
  )
}
