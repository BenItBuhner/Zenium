import type { MenuPopupOptions } from '../../core/platform'
import type { Point } from '../../shared/types'

/**
 * Where a native menu opens, in Electron's `Menu.popup` terms – `x`,`y` in DIP relative to the
 * window's content bounds, which at zoom 1 are the chrome document's CSS pixels: no scale
 * conversion (shortcuts-menus-167, §9.23).
 *
 * A menu that belongs to an element – the focused sidebar tab under Shift+F10, the omnibox
 * under the Menu key, a "⋯" button pressed with Enter – hangs from that element's bottom-left
 * corner, as a menu bar's menus hang from their titles, so it never covers what it is about and
 * the eye finds it under the thing it acts on. Chromium's `MenuController` does the flipping:
 * above the point when the screen runs out below, to the left when it runs out on the right.
 * The core's point (`x`,`y`) stands when it names no element; neither, and the menu opens at
 * the pointer, which Electron does by itself when `popup` gets no position.
 *
 * `content` is the window's content size: an element scrolled or clipped out of the window
 * (a sidebar row under the strip's shadow, a bookmark under the bar's overflow) anchors the
 * menu at the nearest edge of the window rather than off it, where Chromium would clamp it to
 * the screen and lose the link to the element altogether.
 */
export function popupPoint(
  anchor: Pick<MenuPopupOptions, 'x' | 'y' | 'rect'>,
  content?: { width: number; height: number }
): Point | undefined {
  const point = anchor.rect
    ? { x: anchor.rect.x, y: anchor.rect.y + anchor.rect.height }
    : anchor.x !== undefined && anchor.y !== undefined
      ? { x: anchor.x, y: anchor.y }
      : undefined
  if (!point) return undefined
  const clamp = (v: number, max: number | undefined): number =>
    max === undefined ? v : Math.min(Math.max(v, 0), Math.max(0, max))
  return {
    x: Math.round(clamp(point.x, content?.width)),
    y: Math.round(clamp(point.y, content?.height))
  }
}
