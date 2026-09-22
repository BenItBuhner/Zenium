import type { JSX } from 'react'
import { Fragment, useCallback } from 'react'
import type { SplitGroup, Tab } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { useListMotion } from './listMotion'
import { TabItem } from './TabItem'

interface Props {
  group: SplitGroup
  /** The list's first pane of the split, in list order: the row stands in its slot. */
  anchor: Tab
  /** The list's panes of the split, in the split's order – the panes as they are on screen. */
  tabs: Tab[]
  activeTabId: string | null
  compact: boolean
  indent?: boolean
  /** The strip header that folds this row away (`folder:<id>`, `header:<spaceId>`), if any. */
  parent?: string
}

/**
 * A split group's row in the sidebar (design language v2 §9.35; Zen's `zen-split-view.css`):
 * the split is one row, not stacked rows – its tabs side by side in one container at the tab
 * row's height, each a `flex: 1` segment (`TabItem` in its segment form) with its favicon and
 * title – the title truncating from the end while it has 56 px of room after the favicon and
 * dropped for the favicon alone, centred, below that (Zen's rail form for the segment; the
 * stylesheet's container query on the segment's 80 px content box) – and the close on hover
 * only: out of the layout at rest, as Zen's, so the title has the room, and gone with the title
 * in the rail form; a 1 × 16 `--zen-border` hairline centred on each shared
 * edge. The container takes the hover fill
 * as one shape and, when the group holds the active tab, the selected fill as one shape with the
 * segments at 60 % over it and no hairlines: the rim reads as the group and the segments as its
 * tabs. No frame in the expanded sidebar, no layout glyph, no chip in the pill – the layout is on
 * screen in the panes, and the active pane's 2 px accent outline in the content marks the pane.
 * In the 56 px icon rail the group stacks in a column with 16 × 1 hairlines and a 2 px inset
 * outline. The row is the list's slot: `lib/drag.ts` reorders it as one item under the anchor's
 * id, and a segment dragged out of it leaves the split (the core, `dropTab`).
 */
export function SplitGroupRow({
  group,
  anchor,
  tabs,
  activeTabId,
  compact,
  indent,
  parent
}: Props): JSX.Element {
  const motion = useListMotion()
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      motion?.attach(anchor.id, el)
      return () => motion?.attach(anchor.id, null)
    },
    [motion, anchor.id]
  )
  const active = tabs.some((t) => t.id === activeTabId)
  return (
    <div
      ref={attach}
      className={cn('zen-split-row', compact && 'zen-split-row-column', indent && 'ml-5')}
      role="presentation"
      data-split-row={group.id}
      data-split-layout={group.layout}
      data-tab-id={anchor.id}
      data-active={active}
      data-testid="split-row"
    >
      {tabs.map((tab, i) => (
        <Fragment key={tab.id}>
          {i > 0 && <span className="zen-split-hairline" aria-hidden />}
          <TabItem
            tab={tab}
            active={tab.id === activeTabId}
            compact={compact}
            parent={parent}
            segment={{ index: i, count: tabs.length }}
          />
        </Fragment>
      ))}
    </div>
  )
}
