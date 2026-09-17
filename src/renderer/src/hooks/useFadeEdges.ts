import { useCallback, type RefCallback } from 'react'

export type FadeAxis = 'x' | 'y' | 'auto'

export interface FadeEdgesOptions {
  /** Scroll axis to fade; `auto` follows whichever direction overflows. */
  axis?: FadeAxis
  /** Depth of a fade in px. */
  size?: number
}

/**
 * Fading edges for a scroll container: content dissolves into whatever is behind it at an edge
 * that has more content past it – and only there. The top fade appears once the list has been
 * scrolled, the bottom one goes away at the end (left and right for a row). The fade is a
 * `mask-image` on the container itself, so it needs no gradient overlay and works over opaque
 * and translucent backgrounds alike; the depth of each edge is a registered custom property, so
 * it eases in and out. Attach the returned ref to the element that scrolls; the styles live under
 * `[data-fade-axis]` in main.css.
 */
export function useFadeEdges<T extends HTMLElement>({
  axis = 'auto',
  size = 32
}: FadeEdgesOptions = {}): RefCallback<T> {
  return useCallback(
    (el: T | null) => {
      if (!el) return
      return attachFadeEdges(el, axis, size)
    },
    [axis, size]
  )
}

/** Keep `el`'s fade variables in step with its scroll position; returns the teardown. */
export function attachFadeEdges(el: HTMLElement, axis: FadeAxis, size: number): () => void {
  let frame: number | null = null
  const update = (): void => {
    frame = null
    const vertical = axis === 'y' || (axis === 'auto' && !onlyHorizontalOverflow(el))
    const extent = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
    const scroll = vertical ? el.scrollTop : el.scrollLeft
    const start = extent > 1 && scroll > 1 ? size : 0
    const end = extent > 1 && scroll < extent - 1 ? size : 0
    el.dataset.fadeAxis = vertical ? 'y' : 'x'
    el.style.setProperty('--zen-fade-start', `${start}px`)
    el.style.setProperty('--zen-fade-end', `${end}px`)
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
