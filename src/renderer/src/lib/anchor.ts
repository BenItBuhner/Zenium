import type { Rect } from '@shared/types'
import {
  placePopover,
  viewportSize,
  type PopoverAlignment,
  type PopoverBox,
  type PopoverExtent,
  type Size
} from './portals'

/**
 * The control a popover hangs from (v2 draft §9.20): its own box, and the bar or pill it sits in
 * when it sits in one, so the popover's top can sit flush with the bar's bottom edge and its
 * alignment can follow which half of the bar the control is in. `element` is the control
 * itself, for the chrome layer's light dismiss (`useLightDismiss`'s `anchor`, lib/portals.tsx):
 * its own press closes the popover without reopening it and takes the focus back (§9.20
 * amended, §9.22). An anchor that is only a point (a right-click) has none.
 */
export interface Anchor extends Rect {
  bar?: Rect
  element?: Element
}

/** The rect of the control that received an event, in window coordinates: a menu's anchor. */
export function anchorOf(el: Element): Anchor {
  const rect = boxOf(el)
  const bar = el.closest('[data-bar]')
  return bar && bar !== el ? { ...rect, bar: boxOf(bar), element: el } : { ...rect, element: el }
}

function boxOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/**
 * Where a surface hanging from `anchor` goes: `placePopover` (lib/portals.tsx, §9.20) under the
 * bar the anchor sits in, or under the anchor's own box when it stands alone.
 *
 * `width` is one of `POPOVER_WIDTH`'s three for Zenium's own popovers, or `{ measured }` for
 * the two surfaces §9.20 exempts from them: a menu at §5's intrinsic 232–332 and an extension's
 * popup at the size its manifest asks for. Those two also know their `height` (the menu's rows,
 * the popup's document) and pass it, so the surface is that tall – capped by the window minus
 * 16 rather than the 60% a chassis popover's body scrolls under.
 *
 * `alignment` is the one a surface this one replaces on the same anchor resolved to (§9.20's
 * continuity clause: the popup opened from the puzzle panel takes the panel's); the box says
 * which the surface got.
 */
export function placeUnder(
  anchor: Anchor,
  width: PopoverExtent,
  height?: number,
  viewport: Size = viewportSize(),
  alignment?: PopoverAlignment
): PopoverBox & { alignment: PopoverAlignment } {
  return placePopover(anchor, anchor.bar ?? anchor, viewport, width, height, alignment)
}

/**
 * The pop's origin (design-language.md §7): a surface grows out of its anchor, from where the
 * anchor's centre meets the surface's edge on the bar – its top edge hanging below the bar, its
 * bottom edge flipped above it.
 */
export function popOrigin(anchor: Rect, box: Pick<PopoverBox, 'left' | 'width' | 'side'>): string {
  const x = Math.max(0, Math.min(box.width, anchor.x + anchor.width / 2 - box.left))
  return `${x}px ${box.side === 'above' ? '100%' : '0'}`
}
