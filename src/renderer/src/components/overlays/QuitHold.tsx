import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { QuitHoldState } from '@shared/types'
import {
  QUIT_HOLD_PANEL,
  QUIT_HOLD_TITLE,
  quitHoldProgress,
  quitHoldRing,
  quitHoldTitle
} from '@shared/quitHoldPanel'

/**
 * The chrome's own "Hold ⌘Q to quit" (session-08): the §9.23 title block the page script paints
 * over a live page (`shared/quitHoldPanel`, the same numbers), drawn here by the chrome in the
 * content frame's box where no live page is in it – a chrome page (Settings, History), the
 * empty frame, a page under the URL bar's palette, a menu or a chrome overlay, which hold the
 * keyboard then, or a page whose renderer is gone or hung and cannot paint (`ContentArea`'s
 * `pageLive`). Centred, no scrim, no pointer, no focus (`role="status"`): the hold is a key
 * held, not a question. Pops in on §11's 180 ms, fades out in 120 ms as the hold ends
 * (`data-leaving` keeps the panel for its fade), the 120 ms fade both ways under reduced motion
 * (§11.3); the ring is stepped per frame from the hold's clock under either motion setting – a
 * readout of the key held, not an animation.
 */
export function QuitHoldNotice({
  hold,
  show
}: {
  hold: QuitHoldState | null
  /** Whether the chrome is the one to draw it (no live page view in the frame). */
  show: boolean
}): JSX.Element | null {
  const active = show ? hold : null
  // State derived during render (the React pattern for "what did the previous render have"):
  // the hold that just went is kept as `leaving` for its fade out, and a hold arriving cuts a
  // fade short. Holds are told apart by their start (the state's object is new on every commit).
  const [prev, setPrev] = useState<QuitHoldState | null>(active)
  const [leaving, setLeaving] = useState<QuitHoldState | null>(null)
  if ((prev?.startedAt ?? null) !== (active?.startedAt ?? null)) {
    setPrev(active)
    setLeaving(active ? null : prev)
  }
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setLeaving(null), QUIT_HOLD_PANEL.fadeMs)
    return () => clearTimeout(timer)
  }, [leaving])

  const root = useRef<HTMLDivElement>(null)
  const sweep = useRef<SVGCircleElement>(null)
  const { radius, circumference } = quitHoldRing()
  // The ring follows the hold's own clock while it runs (its progress on `data-progress` too,
  // as the page-drawn one has it); a panel on its way out keeps its last sweep.
  useEffect(() => {
    if (!active) return
    let frame = 0
    const tick = (): void => {
      const p = quitHoldProgress(active, Date.now())
      sweep.current?.setAttribute('stroke-dashoffset', `${circumference * (1 - p)}`)
      root.current?.setAttribute('data-progress', p.toFixed(3))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [active, circumference])

  const shown = active ?? leaving
  if (!shown) return null
  const size = QUIT_HOLD_PANEL.glyphPx
  const centre = size / 2
  return (
    <div
      ref={root}
      className="zen-quit-hold"
      role="status"
      aria-live="polite"
      aria-label={quitHoldTitle(shown.chord)}
      data-quit-hold=""
      data-chord={shown.chord}
    >
      <div className="zen-quit-hold-panel" data-leaving={leaving && !active ? '' : undefined}>
        <svg
          className="zen-quit-hold-ring"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
          data-ring=""
        >
          <circle
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={QUIT_HOLD_PANEL.ringStrokePx}
            data-track=""
          />
          <circle
            ref={sweep}
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={QUIT_HOLD_PANEL.ringStrokePx}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference}
            data-sweep=""
          />
        </svg>
        <div className="zen-quit-hold-title">
          <span>{QUIT_HOLD_TITLE.before.trimEnd()}</span>
          <kbd className="zen-quit-hold-key">{shown.chord}</kbd>
          <span>{QUIT_HOLD_TITLE.after.trimStart()}</span>
        </div>
      </div>
    </div>
  )
}
