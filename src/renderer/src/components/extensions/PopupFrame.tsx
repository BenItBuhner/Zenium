import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { popOrigin, type Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { bindPopupFrame, placementFor } from '@renderer/lib/extensions/popup'
import { ChromePortal } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'

/** The pop (design-language.md §7): the view is shown once the frame has finished scaling in. */
const POP_MS = 180

/**
 * The panel an action popup sits in (v2 draft §1–§3: the panel colour, a hairline border and
 * the panel shadow at radius 8). The document is main's WebContentsView; this draws the surface
 * around it flush under the toolbar's bar – or above it when there is more room there – at the
 * size the manifest asked for (§9.20, through the chrome layer like every popover:
 * `ChromePortal`), pops it in, and then tells main where the view goes (`extension.resizePopup`).
 * When the document asks for a new size, the frame and the view move together, at once.
 *
 * Light dismiss is the chrome layer's (§9.20 amended): the popup is in its popover registry from
 * the button's press (`openExtensionPopup`), which closes it on a press anywhere in the chrome
 * outside this frame – consumed, so the control under the press is not pressed and the button
 * that opened it does not reopen it – and on a wheel over the chrome, a window resize or another
 * popover opening. The frame binds its root to the registry so a press on its own ring counts
 * as inside; the document is main's view above the chrome and keeps its own input.
 */
export function PopupFrame(): JSX.Element | null {
  const popup = uiStore.use((s) => s.extensionPopup)
  if (!popup?.shown) return null
  return (
    <ChromePortal>
      <Frame key={popup.id} anchor={popup.anchor} content={popup.content} />
    </ChromePortal>
  )
}

function Frame({
  anchor,
  content
}: {
  anchor: Anchor
  content: { width: number; height: number } | null
}): JSX.Element {
  const { frame, inner, innerRadius, side } = placementFor(anchor, content)
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
  return (
    <div
      ref={bindPopupFrame}
      className="zen-ext-popup-frame zen-animate-pop"
      role="presentation"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        transformOrigin: popOrigin(anchor, { left: frame.x, width: frame.width, side })
      }}
    >
      <div className="zen-ext-popup-well" style={{ inset: padding, borderRadius: innerRadius }} />
    </div>
  )
}
