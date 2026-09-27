import type { Rect } from '@shared/types'
import type { Anchor } from './anchor'
import { contentAreaStore } from './ui'

/*
 * The helpers of the surfaces opened over a text selection – the selection translation
 * (`components/translate/SelectionPopover.tsx`, #106) and the definition
 * (`components/selection/DefinePopover.tsx`, CT-39) – on the chassis of
 * `components/selection/SelectionSurface.tsx`: where the popover hangs, and what a failed
 * command says.
 */

/** The message of a failed command, without the host's IPC wrapping. */
export function commandErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

/** The page view's box in the window, or the window itself before the layout has said. */
function contentArea(): Rect {
  return (
    contentAreaStore.get().area ?? {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight
    }
  )
}

/**
 * Where the user asked, in window pixels, as a point anchor for the chrome layer's placement
 * (§9.20: a right-click has no control to hang from – the popover's start edge aligns with the
 * point and flips to end there when the window's edge is near). A request without a point sits
 * high in the page's middle.
 */
export function pointAnchor(point: { x: number | null; y: number | null }): Anchor {
  const area = contentArea()
  return {
    x: area.x + (point.x ?? area.width / 2),
    y: area.y + (point.y ?? area.height / 3),
    width: 0,
    height: 0
  }
}

/**
 * The selection's box as an anchor, in window pixels: the page script's rect arrives in the
 * page's CSS pixels of the view, so it is scaled by the page zoom and moved by the view's place
 * in the window, and clipped to the view (the core's `anchorInChrome`, for the chrome's side).
 * The popover hangs under it, aligned by its start, and flips above it when the room below is
 * short. Without a box (the phone's toolbar anchors nothing), `pointAnchor`'s middle.
 */
export function rectAnchor(rect: Rect | null, zoom: number): Anchor {
  if (!rect) return pointAnchor({ x: null, y: null })
  const area = contentArea()
  const scale = zoom > 0 ? zoom : 1
  const x = area.x + rect.x * scale
  const y = area.y + rect.y * scale
  const left = Math.max(area.x, Math.min(area.x + area.width, x))
  const top = Math.max(area.y, Math.min(area.y + area.height, y))
  const right = Math.max(left, Math.min(area.x + area.width, x + rect.width * scale))
  const bottom = Math.max(top, Math.min(area.y + area.height, y + rect.height * scale))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
