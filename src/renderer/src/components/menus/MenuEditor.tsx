import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'
import type { MenuItemDescriptor } from '@shared/types'
import { accessibilityStore, useMenuAsList } from '@renderer/lib/accessibilityState'
import {
  countedItems,
  movedSentence,
  nudgeMenuItem,
  positionOf,
  type MenuNudge,
  type MenuSections
} from '@renderer/lib/menuEdit'
import { cn } from '@renderer/lib/utils'
import { useLongPress } from '../phone/useLongPress'
import { MenuItemGlyph } from './MenuGlyphView'
import { useMenuFlip, useMenuReorder, type MenuReorder } from './menuReorder'

/**
 * The phone app menu's edit mode (Edge's Change menu, TB-22; MOT-23): the sheet's root drawn
 * in its edit pose, where the icon row's buttons and the list's rows are the same items with
 * the same glyphs and labels, and a hold lifts one for the finger to carry over its section's
 * slots (`menuReorder.ts`: the lift, the neighbours' glide, the drop's settle; a cut under
 * reduced motion). Nothing here runs an item, opens a submenu or shows a check: the pose is
 * about where the items stand, and only that changes – never which items there are. The two
 * sections keep to themselves (§9.13: the row's six stay the row's); the list's hairlines are
 * slots like its rows, so a row carried past one changes groups, and a hairline the draft leaves
 * beside another or at an end draws collapsed (`data-collapsed`) – the core tidies the same
 * hairlines away when it composes the saved order.
 *
 * Without the gesture (A11Y-10, §10.3; `GroupCardControls`' route): under touch exploration every
 * item is followed in the reading order by three out-of-sight controls – Move up, Move down,
 * Move to start, each naming its item – and the item's own name carries its place ("Forward, 2
 * of 6"); a move is read back through the live region. The Reset row puts the build's default
 * order back into the draft; Done, in the sheet's header, saves whatever the draft says.
 */
export function MenuEditor({
  sections,
  onChange,
  onReset,
  canReset
}: {
  sections: MenuSections
  onChange: (next: MenuSections) => void
  onReset: () => void
  canReset: boolean
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const tracker = useMenuFlip(root)
  const reorder = useMenuReorder(sections, onChange, tracker)
  const iconsAsList = useMenuAsList()
  const touchExploring = accessibilityStore.use((s) => s.touchExploration)
  const [announced, setAnnounced] = useState('')

  const nudge = (item: MenuItemDescriptor, step: MenuNudge): void => {
    if (!item.key) return
    const next = nudgeMenuItem(sections, item.key, step)
    if (next === sections) return
    onChange(next)
    setAnnounced(movedSentence(sections, next, item, step))
  }

  const rowCount = countedItems(sections.row).length
  const listCount = countedItems(sections.list).length
  const rows = sections.list
  // A hairline at the list's head or foot is a collapsed slot no nudge is offered over: the
  // controls' ends are the first and last rows.
  const firstRow = rows.findIndex((item) => item.type !== 'separator')
  const lastRow =
    rows.length - 1 - [...rows].reverse().findIndex((item) => item.type !== 'separator')
  return (
    <div ref={root} className="zen-menu-edit flex flex-col pb-2" data-menu-edit>
      {sections.row.length > 0 && (
        <ul
          className={iconsAsList ? 'zen-menu-icon-list' : 'zen-menu-icon-row'}
          aria-label="Page actions"
        >
          {sections.row.map((item, i) => (
            <EditItem
              key={item.key ?? item.id}
              item={item}
              pose={iconsAsList ? 'list' : 'row'}
              position={positionOf(sections.row, item.key ?? '')}
              count={rowCount}
              first={i === 0}
              last={i === sections.row.length - 1}
              reorder={reorder}
              controls={touchExploring}
              onNudge={nudge}
            />
          ))}
        </ul>
      )}
      {sections.rowEnd && <div aria-hidden className="zen-sheet-sep" />}
      <ul className="flex flex-col" aria-label="Menu">
        {rows.map((item, i) =>
          item.type === 'separator' ? (
            <li
              key={item.key ?? item.id}
              aria-hidden
              className="zen-sheet-sep"
              data-cell={item.key}
              data-collapsed={
                i === 0 || i === rows.length - 1 || rows[i - 1]?.type === 'separator' || undefined
              }
            />
          ) : (
            <EditItem
              key={item.key ?? item.id}
              item={item}
              pose="list"
              position={positionOf(rows, item.key ?? '')}
              count={listCount}
              first={i <= firstRow}
              last={i >= lastRow}
              reorder={reorder}
              controls={touchExploring}
              onNudge={nudge}
            />
          )
        )}
      </ul>
      <ul className="flex flex-col">
        <li aria-hidden className="zen-sheet-sep" />
        <li>
          <button
            type="button"
            className="zen-sheet-item"
            disabled={!canReset}
            data-menu-reset
            onClick={() => {
              onReset()
              setAnnounced('Menu order reset to the default.')
            }}
          >
            <span className="min-w-0 flex-1 truncate">Reset to Default</span>
          </button>
        </li>
      </ul>
      <div className="sr-only" aria-live="polite" data-menu-edit-announcement>
        {announced}
      </div>
    </div>
  )
}

/**
 * One item of the pose: the icon row's button (`row`) or a §10.3 row (`list`; the icon row's
 * items too in their list pose, A11Y-04, glyph leading), enabled whatever the item's own state,
 * since a disabled control is nothing a finger can hold, and named with its place among its
 * section's rows. A hold lifts it and a move drags it; a tap does nothing. Its `li` is its cell
 * for the FLIP set, except while it is the one in the hand: the hand's cell is the hole the
 * others glide around, and it carries `data-held` for the lifted look.
 */
function EditItem({
  item,
  pose,
  position,
  count,
  first,
  last,
  reorder,
  controls,
  onNudge
}: {
  item: MenuItemDescriptor
  pose: 'row' | 'list'
  position: number
  count: number
  first: boolean
  last: boolean
  reorder: MenuReorder
  controls: boolean
  onNudge: (item: MenuItemDescriptor, step: MenuNudge) => void
}): JSX.Element {
  const key = item.key ?? item.id
  const el = useRef<HTMLButtonElement>(null)
  const press = useLongPress(() => undefined, {
    onHold: () => {
      if (el.current) reorder.hold(key, el.current)
    },
    onDrag: (e) => (el.current ? reorder.drag(key, el.current, e) : null),
    onHoldEnd: () => reorder.unhold()
  })
  const held = reorder.held === key
  const name = `${item.label}, ${position} of ${count}`
  const glyph = <MenuItemGlyph glyph={item.glyph} filled={item.checked} />
  return (
    <li
      className={cn(pose === 'row' && 'flex', held && 'zen-menu-edit-held')}
      data-cell={held ? undefined : key}
      data-held={held || undefined}
    >
      {pose === 'row' ? (
        <button
          ref={el}
          type="button"
          className="zen-v2-icon-button zen-menu-edit-item"
          aria-label={name}
          data-glyph={item.glyph}
          data-menu-key={key}
          {...press.handlers}
          onClick={() => press.swallowsClick()}
        >
          {glyph}
        </button>
      ) : (
        <button
          ref={el}
          type="button"
          className="zen-sheet-item zen-menu-edit-item"
          aria-label={name}
          data-glyph={item.glyph}
          data-menu-key={key}
          {...press.handlers}
          onClick={() => press.swallowsClick()}
        >
          {item.glyph && (
            <span className="zen-sheet-item-glyph" aria-hidden>
              {glyph}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <GripVertical className="zen-menu-edit-grip h-5 w-5 shrink-0" aria-hidden />
        </button>
      )}
      {controls && (
        <span className="relative" data-menu-move-controls>
          <button
            type="button"
            className="sr-only"
            data-menu-move="up"
            disabled={first}
            onClick={() => onNudge(item, -1)}
          >
            Move {item.label} up
          </button>
          <button
            type="button"
            className="sr-only"
            data-menu-move="down"
            disabled={last}
            onClick={() => onNudge(item, 1)}
          >
            Move {item.label} down
          </button>
          <button
            type="button"
            className="sr-only"
            data-menu-move="start"
            disabled={first}
            onClick={() => onNudge(item, 'start')}
          >
            Move {item.label} to start
          </button>
        </span>
      )}
    </li>
  )
}
