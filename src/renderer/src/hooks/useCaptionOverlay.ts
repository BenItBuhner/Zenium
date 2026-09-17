import { useEffect, useState } from 'react'

/**
 * Footprint of the native caption buttons the OS draws over the chrome's top trailing corner
 * (Windows 11's Window Controls Overlay), in CSS px. Both are 0 when nothing is drawn: hosts
 * without the overlay, and fullscreen windows, where the buttons disappear.
 */
export interface CaptionOverlay {
  width: number
  height: number
}

interface WindowControlsOverlayApi extends EventTarget {
  visible: boolean
  getTitlebarAreaRect(): DOMRect
}

const NONE: CaptionOverlay = { width: 0, height: 0 }

function overlayApi(): WindowControlsOverlayApi | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayApi })
    .windowControlsOverlay
}

/** The title bar area is what is left of the top row beside the buttons. */
function readOverlay(): CaptionOverlay {
  const api = overlayApi()
  if (!api?.visible) return NONE
  const area = api.getTitlebarAreaRect()
  if (area.height <= 0) return NONE
  return {
    width: Math.max(0, Math.round(window.innerWidth - area.width - area.x)),
    height: Math.round(area.height)
  }
}

export function useCaptionOverlay(): CaptionOverlay {
  const [overlay, setOverlay] = useState(readOverlay)
  useEffect(() => {
    const api = overlayApi()
    if (!api) return
    const update = (): void =>
      setOverlay((prev) => {
        const next = readOverlay()
        return prev.width === next.width && prev.height === next.height ? prev : next
      })
    api.addEventListener('geometrychange', update)
    window.addEventListener('resize', update)
    update()
    return () => {
      api.removeEventListener('geometrychange', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return overlay
}
