import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { closeExtensionPopup, placementFor } from '@renderer/lib/extensions/popup'
import { uiStore } from '@renderer/lib/ui'

/** The pop (design-language.md §7): the view is shown once the frame has finished scaling in. */
const POP_MS = 180

/**
 * The panel an action popup sits in (v2 draft §1–§3: the panel colour, a hairline border and
 * the panel shadow at radius 8). The document is main's WebContentsView; this draws the surface
 * around it flush under the toolbar's bar (§9.20), pops it in, and then tells main where the view goes
 * (`extension.resizePopup`). When the document asks for a new size, the frame and the view move
 * together, at once.
 */
export function PopupFrame(): JSX.Element | null {
  const popup = uiStore.use((s) => s.extensionPopup)
  const open = popup !== null
  // A window resize moves the button the frame hangs from; the popup closes rather than drift.
  useEffect(() => {
    if (!open) return
    const onResize = (): void => closeExtensionPopup()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])
  if (!popup || !popup.shown) return null
  return <Frame key={popup.id} anchor={popup.anchor} content={popup.content} />
}

function Frame({
  anchor,
  content
}: {
  anchor: Anchor
  content: { width: number; height: number } | null
}): JSX.Element {
  const placement = placementFor(anchor, content)
  const { frame, inner, innerRadius, side } = placement
  const padding = inner.x - frame.x
  const popped = useRef(false)
  const { x, y, width, height } = inner
  useEffect(() => {
    const show = (): void => {
      popped.current = true
      run('extension.resizePopup', { bounds: { x, y, width, height }, visible: true })
    }
    if (popped.current) {
      show()
      return
    }
    const timer = window.setTimeout(show, POP_MS)
    return () => window.clearTimeout(timer)
  }, [x, y, width, height])
  // The pop grows out of the button: the origin is where its centre meets the frame's top edge.
  const originX = Math.max(0, Math.min(frame.width, anchor.x + anchor.width / 2 - frame.x))
  return (
    <div
      className="zen-ext-popup-frame zen-animate-pop"
      role="presentation"
      data-side={side}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        transformOrigin: `${originX}px 0`
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="zen-ext-popup-well" style={{ inset: padding, borderRadius: innerRadius }} />
    </div>
  )
}
