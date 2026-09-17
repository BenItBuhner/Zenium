import type { Rect } from '@shared/types'

/** The rect of the control that received an event, in window coordinates: a menu's anchor. */
export function anchorOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}
