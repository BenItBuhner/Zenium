import { useCallback, type RefCallback } from 'react'
import { MOTION_POP_MS } from '../lib/motion/tokens'

export type FadeAxis = 'x' | 'y' | 'auto'
/** Which edges fade: both, or the end alone (a header marks the start with a hairline instead). */
export type FadeEdges = 'both' | 'end'

export interface FadeEdgesOptions {
  /** Scroll axis to fade; `auto` follows whichever direction overflows. */
  axis?: FadeAxis
  /** Depth of a fade in px. */
  size?: number
  /** The edges that fade (both by default). */
  edges?: FadeEdges
}

/**
 * Fading edges for a scroll container: content dissolves into whatever is behind it at an edge
 * that has more content past it – and only there. The top fade appears once the list has been
 * scrolled, the bottom one goes away at the end (left and right for a row). The fade is a
 * `mask-image` on the container itself, so it needs no gradient overlay and works over opaque
 * and translucent backgrounds alike; the depth of each edge is a registered custom property, so
 * it eases in and out. A container under a sticky header that marks scrolled-under content with
 * a hairline (v2 §9.7) fades its end edge only (`edges: 'end'`). Attach the returned ref to the
 * element that scrolls; the styles live under `[data-fade-axis]` in main.css.
 *
 * The mask is there only while an edge fades. A container with nothing past either edge – a
 * menu whose rows fit, a list scrolled to its only end – carries no `data-fade-axis` and so no
 * mask at all: a mask that draws nothing still costs the compositor a render surface and a mask
 * layer, and a lost mask layer blanks the content under it (the selection menu's rows, which fit,
 * went empty when its sheet was flung – W6-S26-e). The mask arrives with the first fade and
 * leaves once the last has eased out (`MOTION_POP_MS`, the transition under `[data-fade-axis]`).
 */
export function useFadeEdges<T extends HTMLElement>({
  axis = 'auto',
  size = 16,
  edges = 'both'
}: FadeEdgesOptions = {}): RefCallback<T> {
  return useCallback(
    (el: T | null) => {
      if (!el) return
      return attachFadeEdges(el, axis, size, edges)
    },
    [axis, size, edges]
  )
}

/** Keep `el`'s fade variables in step with its scroll position; returns the teardown. */
export function attachFadeEdges(
  el: HTMLElement,
  axis: FadeAxis,
  size: number,
  edges: FadeEdges = 'both'
): () => void {
  let frame: number | null = null
  let unmask: ReturnType<typeof setTimeout> | null = null
  const update = (): void => {
    frame = null
    const vertical = axis === 'y' || (axis === 'auto' && !onlyHorizontalOverflow(el))
    const extent = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
    const raw = vertical ? el.scrollTop : el.scrollLeft
    // A reversed scroller (`column-reverse`, an RTL row) counts from its far end: 0 is the end
    // and positions run negative, so measure from the start like every other container.
    const scroll = isReversed(el, vertical) ? extent + raw : raw
    const start = edges === 'both' && extent > 1 && scroll > 1 ? size : 0
    const end = extent > 1 && scroll < extent - 1 ? size : 0
    el.style.setProperty('--zen-fade-start', `${start}px`)
    el.style.setProperty('--zen-fade-end', `${end}px`)
    if (start > 0 || end > 0) {
      // An edge fades: the mask is on, its depth easing in from 0 under `[data-fade-axis]`'s
      // transition (a transition starts on the after-change style's `transition`).
      if (unmask !== null) {
        clearTimeout(unmask)
        unmask = null
      }
      el.dataset.fadeAxis = vertical ? 'y' : 'x'
    } else if (el.dataset.fadeAxis !== undefined && unmask === null) {
      // Nothing fades any more: the depths ease out to 0 under the mask, then the mask goes.
      unmask = setTimeout(() => {
        unmask = null
        delete el.dataset.fadeAxis
      }, MOTION_POP_MS)
    }
  }
  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(update)
  }
  update()
  el.addEventListener('scroll', schedule, { passive: true })
  // Both the box and its content change size (a list grows, the keyboard shrinks a panel).
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
  resize?.observe(el)
  const mutations = new MutationObserver(schedule)
  mutations.observe(el, { childList: true, subtree: true, characterData: true })
  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
    if (unmask !== null) clearTimeout(unmask)
    el.removeEventListener('scroll', schedule)
    resize?.disconnect()
    mutations.disconnect()
    delete el.dataset.fadeAxis
    el.style.removeProperty('--zen-fade-start')
    el.style.removeProperty('--zen-fade-end')
  }
}

function onlyHorizontalOverflow(el: HTMLElement): boolean {
  return el.scrollWidth - el.clientWidth > 1 && el.scrollHeight - el.clientHeight <= 1
}

function isReversed(el: HTMLElement, vertical: boolean): boolean {
  const style = getComputedStyle(el)
  return vertical ? style.flexDirection === 'column-reverse' : style.direction === 'rtl'
}
