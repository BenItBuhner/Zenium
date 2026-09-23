/**
 * Keep the panel told how wide the scroller's vertical scrollbar is (`--zen-list-gutter` on the
 * panel: 0 while the rows fit, the chassis' 8 while they overflow – §9.20's bar takes its room
 * from the rows, Chromium drawing no true overlay bar for a mouse), so the foot outside the
 * scroller can hold the rows' width. Read again whenever the scroller's box changes.
 */
export function watchGutter(scroller: HTMLElement): () => void {
  const panel = scroller.parentElement
  if (!panel) return () => undefined
  const measure = (): void => {
    panel.style.setProperty(
      '--zen-list-gutter',
      `${Math.max(0, scroller.offsetWidth - scroller.clientWidth)}px`
    )
  }
  measure()
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
  resize?.observe(scroller)
  return () => {
    resize?.disconnect()
    panel.style.removeProperty('--zen-list-gutter')
  }
}
