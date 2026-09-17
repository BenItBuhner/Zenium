import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { PhoneBarItemId, Rect } from '@shared/types'
import { run } from '@renderer/lib/api'

/** Movement (px) that turns a hold into a swipe or a drag – no longer a hold. */
const SLOP = 8
/** Same hold as the pill's relocation and Android's own long-press. */
const HOLD_MS = 400

export interface BarHoldOptions {
  /** A hold on a button (named) or on the bar's background (null). */
  onHold: (item: PhoneBarItemId | null, rect: Rect) => void
}

export interface BarHoldHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onClickCapture: (e: React.MouseEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void
}

interface Hold {
  id: number
  x: number
  y: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * A stationary press on the phone bar – on any of its buttons or on the bar itself, never on
 * the address pill, whose hold is the relocation gesture – reports a hold after 400 ms: the
 * editor's entry point (and the Tabs button's quick menu). The press is cancelled by movement
 * or by the finger lifting first; a hold that fires swallows the click the release would have
 * produced, so the button underneath does not act as well.
 *
 * The pointer is deliberately not captured: a capture on the bar would retarget the release,
 * and with it the click, away from the button that was tapped.
 */
export function useBarHold({ onHold }: BarHoldOptions): BarHoldHandlers {
  const hold = useRef<Hold | null>(null)
  const swallowClick = useRef(false)
  const latest = useRef(onHold)
  useEffect(() => {
    latest.current = onHold
  })

  const cancel = (): void => {
    const h = hold.current
    if (!h) return
    clearTimeout(h.timer)
    hold.current = null
    window.removeEventListener('pointerup', onWindowEnd, true)
    window.removeEventListener('pointercancel', onWindowEnd, true)
  }
  // The release may land anywhere once the finger has wandered off the bar.
  const onWindowEnd = (e: PointerEvent): void => {
    if (hold.current?.id === e.pointerId) cancel()
  }
  useEffect(() => cancel, []) // eslint-disable-line react-hooks/exhaustive-deps -- unmount only

  return {
    onPointerDown: (e) => {
      if (e.button !== 0 || hold.current) return
      const target = e.target as HTMLElement
      if (target.closest('.zen-phone-pill')) return
      swallowClick.current = false
      const button = target.closest<HTMLElement>('[data-bar-item]')
      const anchor = button ?? e.currentTarget
      const id = e.pointerId
      hold.current = {
        id,
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          if (hold.current?.id !== id) return
          cancel()
          swallowClick.current = true
          run('haptic', { kind: 'lift' })
          const r = anchor.getBoundingClientRect()
          latest.current((button?.dataset.barItem as PhoneBarItemId | undefined) ?? null, {
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height
          })
        }, HOLD_MS)
      }
      window.addEventListener('pointerup', onWindowEnd, true)
      window.addEventListener('pointercancel', onWindowEnd, true)
    },
    onPointerMove: (e) => {
      const h = hold.current
      if (!h || h.id !== e.pointerId) return
      if (Math.hypot(e.clientX - h.x, e.clientY - h.y) >= SLOP) cancel()
    },
    onClickCapture: (e) => {
      if (!swallowClick.current) return
      swallowClick.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    // The hold is ours; the WebView must not open a context menu or start a selection.
    onContextMenu: (e) => e.preventDefault()
  }
}
