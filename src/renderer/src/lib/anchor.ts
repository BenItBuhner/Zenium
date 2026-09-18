import type { Rect } from '@shared/types'
import {
  placePopover,
  viewportSize,
  type PopoverBox,
  type PopoverWidth,
  type Size
} from './portals'

/**
 * The control a popover hangs from (v2 draft §9.20): its own box, and the bar or pill it sits in
 * when it sits in one, so the popover's top can sit flush with the bar's bottom edge and its
 * alignment can follow which half of the bar the control is in.
 */
export interface Anchor extends Rect {
  bar?: Rect
}

/** The rect of the control that received an event, in window coordinates: a menu's anchor. */
export function anchorOf(el: Element): Anchor {
  const rect = boxOf(el)
  const bar = el.closest('[data-bar]')
  return bar && bar !== el ? { ...rect, bar: boxOf(bar) } : rect
}

function boxOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/**
 * Where a surface hanging from `anchor` goes: `placePopover` (lib/portals.tsx, §9.20) under the
 * bar the anchor sits in, or under the anchor's own box when it stands alone.
 *
 * `width` is one of `POPOVER_WIDTH`'s three for Zenium's own popovers. Two surfaces are exempt
 * from the three and pass a measured width: an extension's popup document keeps the size its
 * manifest asks for, and a menu keeps §5's intrinsic 232–332. `placePopover` types its width
 * to the three; until the shared layer takes a number for those two cases, the measured width
 * goes through here as one.
 */
export function placeUnder(
  anchor: Anchor,
  width: number,
  viewport: Size = viewportSize()
): PopoverBox {
  return placePopover(anchor, anchor.bar ?? anchor, viewport, width as PopoverWidth)
}

/**
 * The pop's origin (design-language.md §7): a surface grows out of its anchor, from where the
 * anchor's centre meets the surface's top edge.
 */
export function popOrigin(anchor: Rect, box: { left: number; width: number }): string {
  const x = Math.max(0, Math.min(box.width, anchor.x + anchor.width / 2 - box.left))
  return `${x}px 0`
}
