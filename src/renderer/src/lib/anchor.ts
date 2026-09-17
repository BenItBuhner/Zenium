import type { Rect } from '@shared/types'

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
