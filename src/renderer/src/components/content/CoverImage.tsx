import type { CSSProperties, JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { trackCover } from '@renderer/lib/cover'

interface Props {
  tabId: string
  /** A data URL of the page's last capture. */
  src: string
  /**
   * Whether this picture stands in for the live page: the layout reporter then keeps the page
   * until the picture is painted (see `lib/cover.ts`). Off for pictures that are merely shown
   * (the cards of the other tabs in the overview), which decode at their leisure.
   */
  cover?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * A page's snapshot where the page is (or was). As a cover it decodes synchronously – its first
 * frame carries its pixels – and reports the frame that has them, so the page view is not taken
 * down before them.
 */
export function CoverImage({ tabId, src, cover = false, className, style }: Props): JSX.Element {
  const ref = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    const img = ref.current
    if (!cover || !img) return
    return trackCover(tabId, img)
  }, [cover, tabId, src])
  return (
    <img
      ref={ref}
      src={src}
      alt=""
      decoding={cover ? 'sync' : 'auto'}
      draggable={false}
      className={className}
      style={style}
    />
  )
}
