import type { MenuDescriptor, Rect } from '@shared/types'
import {
  POPOVER_MARGIN,
  placePopover,
  toRect,
  viewportSize,
  type PopoverBox,
  type Size
} from '@renderer/lib/portals'
import { lastPointer, menuAnchor } from '@renderer/lib/ui'

/**
 * The tablet menu's geometry (`TabletMenu.tsx` draws it; v2 §9.36, §9.20): where a `menu.show`
 * descriptor hangs from, where its root panel and its cascades stand. Kept apart from the
 * component so the placement is plain functions under test and the component file exports
 * components alone.
 */

/** Zen's app menu width (§9.20: Firefox's `--menu-panel-width` at the Linux menu font). */
export const TABLET_MENU_WIDTH = 332

/**
 * Where a tablet menu hangs from (v2 §9.36): the chrome control that opened it – the toolbar's
 * ⋯ – with the bar it sits in, or the finger's point for a context menu.
 */
export type TabletMenuAnchor =
  | { kind: 'control'; box: Rect; bar: Rect; element: HTMLElement }
  | { kind: 'point'; x: number; y: number }

/**
 * The anchor a `menu.show` descriptor resolves to. The core echoes a point alone – for the app
 * menu the button's bottom start corner (`showAppMenu`), for a context menu the pointer or the
 * finger (`contextMenuAnchor`, `useTabTouch`) – so the control's box comes from the opener
 * (`menuAnchor`, set by `openAppMenu`), taken when its box still meets the point: the bar it
 * sits in is the tablet toolbar row, whose bottom edge the popover's top sits flush with, or
 * the nearest `[data-bar]`, or the control's own box. A point with no control is the point;
 * a descriptor with no point at all opens at the last press.
 */
export function resolveMenuAnchor(
  menu: Pick<MenuDescriptor, 'x' | 'y'>,
  control: HTMLElement | null = menuAnchor.element,
  pointer: { x: number; y: number } = lastPointer
): TabletMenuAnchor {
  const x = menu.x ?? pointer.x
  const y = menu.y ?? pointer.y
  if (control && control.isConnected) {
    const r = control.getBoundingClientRect()
    const meets = x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1
    if (r.width > 0 && meets) {
      const barEl = control.closest('.zen-tablet-toolbar') ?? control.closest('[data-bar]')
      const box = toRect(r)
      const bar = barEl ? toRect(barEl.getBoundingClientRect()) : box
      return { kind: 'control', box, bar, element: control }
    }
  }
  return { kind: 'point', x, y }
}

/**
 * The root panel's box for `anchor` (§9.20's order – flip, slide, shrink – against the window
 * at the 8 margin): under the control's bar, aligned by the control's half of it, or at the
 * finger – start edges at the point, end edges when the finger is in the window's trailing
 * half, below the point when the menu fits there and above it otherwise. `height` is the
 * panel's own, once measured; the 60% cap and the window minus 16 hold either way.
 */
export function placeRootMenu(
  anchor: TabletMenuAnchor,
  height: number | undefined,
  viewport: Size = viewportSize()
): PopoverBox {
  if (anchor.kind === 'control') {
    return placePopover(anchor.box, anchor.bar, viewport, { measured: TABLET_MENU_WIDTH }, height)
  }
  const point: Rect = { x: anchor.x, y: anchor.y, width: 0, height: 0 }
  const column: Rect = { x: 0, y: 0, ...viewport }
  return placePopover(point, point, viewport, { measured: TABLET_MENU_WIDTH }, height, undefined, {
    column
  })
}

/**
 * A submenu's panel, the §9.20 cascade: flush beside its parent (gap 0) on the side with the
 * room – the parent's end side first, its start side when the end would cross the window's
 * margin – its first row level with the parent row that opened it (`rowTop`), slid up when it
 * would cross the bottom margin, and never taller than the window minus 16.
 */
export function placeCascade(
  parent: { left: number; width: number },
  rowTop: number,
  height: number,
  viewport: Size = viewportSize()
): { left: number; top: number; maxHeight: number } {
  const w = Math.min(TABLET_MENU_WIDTH, viewport.width - 2 * POPOVER_MARGIN)
  const end = parent.left + parent.width
  const start = parent.left - w
  let left: number
  if (end + w <= viewport.width - POPOVER_MARGIN) left = end
  else if (start >= POPOVER_MARGIN) left = start
  else left = Math.max(POPOVER_MARGIN, Math.min(end, viewport.width - POPOVER_MARGIN - w))
  const maxHeight = Math.max(0, viewport.height - 2 * POPOVER_MARGIN)
  const h = Math.min(height, maxHeight)
  const top = Math.max(POPOVER_MARGIN, Math.min(rowTop, viewport.height - POPOVER_MARGIN - h))
  return { left, top, maxHeight }
}
