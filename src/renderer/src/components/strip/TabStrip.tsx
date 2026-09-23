import type { CSSProperties, JSX, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { VenetianMask } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { useCaptionOverlay } from '@renderer/hooks/useCaptionOverlay'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { dropStore, listMotions } from '@renderer/lib/drag'
import { groupsOf } from '@renderer/lib/groups'
import { isPrivateGroup, regularMembers } from '@renderer/lib/groupRows'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import {
  activeSpace,
  isPrivateWindow,
  pinnedOf,
  regularOf,
  rowKey,
  stripRows
} from '@renderer/lib/selectors'
import {
  STRIP_BAND,
  STRIP_FADE,
  STRIP_MAC_INSET,
  STRIP_TAB_MAX,
  hasStateGlyph,
  stripSlot,
  type StripSlot
} from '@renderer/lib/tabStripLayout'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ListMotionContext } from '../sidebar/listMotion'
import { FolderRow, NewTabButton, StripRowItem } from '../sidebar/SpacePanel'
import { StripAxisContext } from '../sidebar/stripAxis'
import { WindowControls } from '../WindowControls'

/** More rows than this arriving in one commit is a restore, placed without motion. */
const ENTER_BATCH = 6

interface Props {
  state: UIState
  /** Controls at the trailing end, ahead of the window controls (the fullscreen way out). */
  trailing?: ReactNode
}

/**
 * The horizontal tab strip (design language v2 §9.37): the sidebar's tab row laid along the
 * caption band. It sits on the window family – theme ink on the space gradient, no surface of
 * its own, no hairline under it – in the 38 band (6 inset + the 32 row), and every tab is the
 * sidebar's `.zen-tab` with its axis turned (`StripAxisContext`): 32 tall at radius 8, the
 * favicon, the title, the one trailing slot. Pinned tabs are 32 × 32 favicon-only ahead of the
 * space's tabs; the regular region scrolls once it overflows (24 px edge fades, no arrows); the
 * + is a 28 toolbar button 4 after the last tab; a drag spring of at least 24 keeps it off the
 * window controls, which sit inline at the trailing end (Linux's three §9.3 boxes inset 8;
 * Windows' caption buttons drawn over the band, the strip keeping their footprint clear; the
 * macOS lights leading, the strip inset 84). The strip is the tab strip pane of the F6 rotation
 * (`data-pane="tabs"`); the rail beside the frame is the same pane's other root.
 */
export function TabStrip({ state, trailing }: Props): JSX.Element {
  const space = activeSpace(state)
  const drag = uiStore.use((s) => s.drag)
  const dropKey = dropStore.use((s) => s.key)
  const zones = dropStore.use((s) => s.zones)
  const pinned = pinnedOf(state, space)
  const regular = regularOf(state, space)
  // The rows are the space panel's (SpacePanel.tsx): a regular surface lists no private group
  // and no private member among a group's rows; a private window lists its own groups whole.
  const regularSurface = !isPrivateWindow(state)
  const liveOf = (folderId: string): Tab[] => regular.filter((t) => t.folderId === folderId)
  const membersOf = (folderId: string): Tab[] =>
    regularSurface ? regularMembers(liveOf(folderId)) : liveOf(folderId)
  const folders = groupsOf(state, space.id).filter(
    (f) => !regularSurface || !isPrivateGroup(f, liveOf(f.id))
  )
  const listed = new Set(folders.map((f) => f.id))
  const loose = regular.filter(
    (t) => !t.folderId || !listed.has(t.folderId) || (regularSurface && isPrivateTab(t))
  )
  const activeTabId = space.activeTabId
  const isMac = state.platform === 'darwin'
  const isPrivate = isPrivateWindow(state)
  const overlay = useCaptionOverlay()

  // Every regular tab's width, and from it each tab's trailing slot (`lib/tabStripLayout.ts`).
  const width = STRIP_TAB_MAX
  const slot = useCallback(
    (tab: Tab, active: boolean): StripSlot => stripSlot(width, active, hasStateGlyph(tab)),
    [width]
  )

  // The rows' motion (§11.4), along the strip's axis: one list for the pinned tabs, one for the
  // regular region, each keyed by its scroller so lib/drag.ts finds it from a row.
  const [pinnedMotion] = useState(() => new SlideMotion('x'))
  const [motion] = useState(() => new SlideMotion('x', { enter: true, batch: ENTER_BATCH }))
  useEffect(
    () => () => {
      pinnedMotion.dispose()
      motion.dispose()
    },
    [pinnedMotion, motion]
  )
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'x', size: STRIP_FADE })
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
  const pinnedScroller = useCallback(
    (el: HTMLDivElement | null) => {
      pinnedMotion.setScroller(el)
      if (el) listMotions.set(el, pinnedMotion)
      return () => pinnedMotion.setScroller(null)
    },
    [pinnedMotion]
  )
  const orderKey = [
    ...pinned.map((t) => t.id),
    ...folders.map((f) => `${f.id}${f.collapsed ? '-' : '+'}`),
    ...regular.map((t) => `${t.id}${t.folderId ?? ''}`)
  ].join('|')
  useLayoutEffect(() => {
    const lifted = uiStore.get().drag?.tabId ?? null
    pinnedMotion.flip(lifted, true)
    motion.flip(lifted, true)
  }, [pinnedMotion, motion, orderKey, zones])

  // The strip's own menu on its empty room (the sidebar scroller's rule): a row that opened its
  // own menu has claimed the event by now.
  const onEmptyContextMenu = (e: React.MouseEvent): void => {
    if (e.isDefaultPrevented()) return
    e.preventDefault()
    run('newtab.contextMenu', contextMenuAnchor(e))
  }

  return (
    <StripAxisContext.Provider value="x">
      <div
        className="zen-tab-strip zen-drag relative flex shrink-0 items-stretch"
        style={{ height: STRIP_BAND, paddingLeft: isMac ? STRIP_MAC_INSET : 0 }}
        data-tab-strip
        data-surface="window"
        data-pane="tabs"
        data-strip-axis="x"
        data-testid="tab-strip"
      >
        {isPrivate && (
          <VenetianMask
            className="ml-2 mt-[6px] h-8 w-4 shrink-0 self-start opacity-70"
            aria-label="Private window"
          />
        )}
        {/* The tab list (a11y-07, a11y-31): the pinned rows, the group chips and their rows, the
            loose rows – one tablist, horizontal; the + is the strip's next control after it. */}
        <div
          role="tablist"
          aria-orientation="horizontal"
          aria-label={`${space.name} tabs`}
          className="zen-no-drag flex min-w-0 items-stretch gap-1"
          style={{ flex: '0 1 auto' }}
        >
          {pinned.length > 0 && (
            <ListMotionContext.Provider value={pinnedMotion}>
              <div
                ref={pinnedScroller}
                className="flex h-full shrink-0 items-end gap-1"
                data-strip-pinned
                data-tab-scroller
                data-active="true"
                data-tab-list="pinned"
              >
                {stripRows(pinned, state.splitGroups).map((row) => (
                  <StripRowItem key={rowKey(row)} row={row} activeTabId={activeTabId} compact />
                ))}
              </div>
            </ListMotionContext.Provider>
          )}
          <ListMotionContext.Provider value={motion}>
            <div
              ref={scroller}
              className="zen-strip-scroller flex h-full min-w-0 items-end overflow-x-auto overflow-y-hidden"
              style={{ flex: '0 1 auto' }}
              data-strip-scroller
              data-tab-scroller
              data-active="true"
              onContextMenu={onEmptyContextMenu}
            >
              <div
                className="flex h-full items-end gap-1"
                data-tab-list="regular"
                style={{ '--zen-strip-tab-width': `${width}px` } as CSSProperties}
              >
                {folders.map((folder) => (
                  <FolderRow
                    key={folder.id}
                    folder={folder}
                    tabs={membersOf(folder.id)}
                    activeTabId={activeTabId}
                    compact={false}
                    dropKey={dropKey}
                    dragging={Boolean(drag)}
                    live={Boolean(state.liveFolders[folder.id])}
                    liveError={state.liveFolders[folder.id]?.lastError ?? null}
                    splitGroups={state.splitGroups}
                    slot={slot}
                  />
                ))}
                {stripRows(loose, state.splitGroups).map((row) => (
                  <StripRowItem
                    key={rowKey(row)}
                    row={row}
                    activeTabId={activeTabId}
                    compact={false}
                    slot={slot}
                  />
                ))}
              </div>
            </div>
          </ListMotionContext.Provider>
        </div>
        <div className="zen-no-drag flex shrink-0 items-end pb-[2px] pl-1">
          <NewTabButton
            compact={false}
            spaced={false}
            dropInto={dropKey === `newtab:${space.id}`}
            button
          />
        </div>
        {/* The drag spring: at least 24 of caption between the + and the window controls. */}
        <div className="zen-drag" style={{ flex: '1 0 24px' }} data-strip-spring />
        <div
          className={cn('zen-no-drag flex shrink-0 items-end gap-1 pb-[2px]')}
          style={{ paddingRight: overlay.width > 0 ? overlay.width : 8 }}
          data-strip-controls
        >
          {trailing}
          <WindowControls />
        </div>
      </div>
    </StripAxisContext.Provider>
  )
}
