import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { popOrigin, type Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { closeExtensionPopup, placementFor } from '@renderer/lib/extensions/popup'
import { ChromePortal } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'

/** The pop (design-language.md §7): the view is shown once the frame has finished scaling in. */
const POP_MS = 180

/**
 * The panel an action popup sits in (v2 draft §1–§3: the panel colour, a hairline border and
 * the panel shadow at radius 8). The document is main's WebContentsView; this draws the surface
 * around it flush under the toolbar's bar (§9.20, through the chrome layer like every popover:
 * `ChromePortal`), pops it in, and then tells main where the view goes (`extension.resizePopup`).
 * When the document asks for a new size, the frame and the view move together, at once.
 *
 * Under the frame, while the popup is up, a layer over the whole chrome is its light dismiss
 * (§9.20): a press anywhere in the chrome – the page's capture, the bar, another action's button,
 * the button that opened it – closes the popup on pointerdown and goes no further, so the
 * control under the press is not pressed. The document itself is main's view above the chrome
 * and keeps its own input. A wheel over the chrome (the frame's scroll) and a window resize,
 * which moves the button the frame hangs from, close it too. (The chrome layer supplies no
 * dismiss of its own; this one is kept until it does.)
 */
export function PopupFrame(): JSX.Element | null {
  const popup = uiStore.use((s) => s.extensionPopup)
  const open = popup !== null
  useEffect(() => {
    if (!open) return
    const close = (): void => closeExtensionPopup()
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])
  if (!popup) return null
  return (
    <ChromePortal>
      <div
        className="fixed inset-0"
        role="presentation"
        onPointerDown={(e) => {
          e.stopPropagation()
          closeExtensionPopup()
        }}
        onWheel={() => closeExtensionPopup()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {popup.shown && <Frame key={popup.id} anchor={popup.anchor} content={popup.content} />}
      </div>
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
  const { frame, inner, innerRadius } = placementFor(anchor, content)
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
      className="zen-ext-popup-frame zen-animate-pop"
      role="presentation"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        transformOrigin: popOrigin(anchor, { left: frame.x, width: frame.width })
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="zen-ext-popup-well" style={{ inset: padding, borderRadius: innerRadius }} />
    </div>
  )
}
