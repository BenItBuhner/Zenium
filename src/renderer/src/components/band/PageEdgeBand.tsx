import type { CSSProperties, JSX, KeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  bandHeightOf,
  bandStore,
  chooseBand,
  dismissBand,
  holdBand,
  pickBandAction,
  type BandEntry
} from '@renderer/lib/band'
import type { DismissDirections } from '@renderer/lib/gestures/dismiss'
import { BandMotion } from '@renderer/lib/motion/band'
import { MOTION_STATE_MS } from '@renderer/lib/motion/tokens'
import { useSwipeDismiss } from '../messages/useSwipeDismiss'

/**
 * What the host does with the page while the band moves (`BandSeam` less the content's paint,
 * which is the band's own): the desktop translates the content view's bounds by `offset` per
 * frame, seats the band at `depart` and lays the page out once at `rest` (§3.4); Android moves
 * its WebView by the pull channel and needs neither of the other two.
 */
export interface BandHost {
  translate(offset: number): void
  rest(height: number): void
  depart?(to: number): void
}

/** A swipe up on the band dismisses it; nothing else moves it. */
const BAND_DIRS: DismissDirections = { x: [], y: [-1] }

interface Props {
  host: BandHost
}

const sceneOf = (s: { scene: string | null }): string | null => s.scene

/**
 * The page-edge band (motion spec §3): one prompt about the page, between the content frame's
 * top edge and the page's top edge, in the frame's own surface. `[glyph] Title · detail [Action]
 * [×]` – the glyph in the status ink for a state, the accent for an offer; one action at most;
 * the × refuses, named "Dismiss" on every band (the Design Lead's ruling on #740). The page
 * travels down to make room (`BandMotion` on the one animation clock,
 * through the host's seam) and the content fades in over the last 120 ms; a swipe up takes the
 * page with the finger 1:1; Escape with focus in the band dismisses it; `role="status"` reads the
 * title once. A new tenant on an open band cross-fades its content 120 ms at the current height
 * while the height re-targets. Everything per frame is written straight to the DOM (§6).
 *
 * What it shows is the model's choice (`chooseBand`), read with the frame's scene from the one
 * snapshot the host wrote (`setBandFrame`): a standing that changes with the scene – the tab
 * leaving the front, a page's fullscreen – is a cut, not a travel. A band goes with its page at
 * once and stands again at once when the page comes back; the page of the next tab never
 * travels for the last tab's prompt, and a prompt the page never showed travels in as on any
 * page. The root names its tenant (`data-key`) for the drives that look for one band in
 * particular; nothing of the chrome reads it.
 */
export function PageEdgeBand({ host }: Props): JSX.Element | null {
  const entry = bandStore.use(chooseBand)
  const scene = bandStore.use(sceneOf)
  /** What is drawn: the prompt, or the last one while the band leaves. */
  const [showing, setShowing] = useState<BandEntry | null>(null)
  /** The tenant before a swap, fading out over the new one. */
  const [leaving, setLeaving] = useState<BandEntry | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef(host)
  const showingRef = useRef(showing)
  const sceneRef = useRef(scene)
  /** Prompts the band cut away with their page, to stand again at once when it comes back. */
  const cutAway = useRef(new Set<number>())
  const motion = useRef<BandMotion | null>(null)

  useLayoutEffect(() => {
    hostRef.current = host
    showingRef.current = showing
  })

  const ensure = (): BandMotion => {
    motion.current ??= new BandMotion({
      translate: (offset) => hostRef.current.translate(offset),
      depart: (to) => hostRef.current.depart?.(to),
      rest: (height) => {
        hostRef.current.rest(height)
        if (height === 0) setShowing(null)
      },
      paint: (opacity) => {
        const el = contentRef.current
        if (el) el.style.opacity = opacity.toFixed(3)
      }
    })
    return motion.current
  }

  // The prompt arrived, changed or went: open, re-target (with a content swap) or leave – or,
  // where the scene changed with it, cut. The choice and the scene come from one snapshot of the
  // model, so a change of standing that is the scene's never reads as the page's own (a
  // window-wide band stays through a tab switch: the same prompt, nothing to do).
  useLayoutEffect(() => {
    const m = ensure()
    const sceneChanged = sceneRef.current !== scene
    sceneRef.current = scene
    const was = showingRef.current
    if (entry) {
      // The same prompt again is nothing – unless the band is on its way out with it (it went
      // and came back within the leave): then the leave reverses.
      const same = was?.id === entry.id
      if (same && m.phase !== 'closing') return
      if (sceneChanged) {
        // The page in the frame is another document: what stood goes at once, and what this
        // page had – a prompt cut away with it before – stands again at once. A prompt the page
        // never showed (one that arrived while it was not in front, or the host's first word)
        // travels in as on any page.
        const returning = cutAway.current.has(entry.id)
        if (was && !same) {
          cutAway.current.add(was.id)
          if (!returning) m.jump(0)
        }
        if (returning) {
          cutAway.current.delete(entry.id)
          setLeaving(null)
          setShowing(entry)
          m.jump(bandHeightOf(entry))
          return
        }
      }
      if (was && !same && m.phase !== 'closed') setLeaving(was)
      setShowing(entry)
      m.open(bandHeightOf(entry))
      return
    }
    if (!was) return
    if (sceneChanged) {
      cutAway.current.add(was.id)
      m.jump(0)
    } else m.close()
  }, [entry, scene])

  // A swapped-out tenant's content is gone once its fade has run.
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setLeaving(null), MOTION_STATE_MS)
    return () => clearTimeout(timer)
  }, [leaving])

  useEffect(() => () => motion.current?.dispose(), [])

  const handlers = useSwipeDismiss({
    dirs: BAND_DIRS,
    onHold: (held) => holdBand(held),
    onDragStart: () => motion.current?.dragStart(),
    onDrag: (_axis, delta) => motion.current?.drag(delta),
    onRelease: (_axis, _delta, velocity) => {
      const m = motion.current
      if (!m) return
      m.release(velocity)
      if (m.phase === 'closing' && showingRef.current) dismissBand(showingRef.current.id, 'swipe')
    }
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || !showing) return
    e.preventDefault()
    e.stopPropagation()
    dismissBand(showing.id, 'escape')
  }

  if (!showing) return null
  const height = bandHeightOf(showing)
  return (
    <div
      className="zen-band"
      role="status"
      data-surface="page"
      data-key={showing.key}
      data-form={showing.form}
      data-tone={showing.form === 'state' ? showing.tone : undefined}
      data-detail={showing.detail ? '' : undefined}
      style={{ '--zen-band-height': `${height}px` } as CSSProperties}
      onKeyDown={onKeyDown}
      {...handlers}
    >
      {leaving && (
        <div className="zen-band-content" data-leaving="" aria-hidden>
          <BandContent entry={leaving} inert />
        </div>
      )}
      <div
        key={showing.id}
        ref={(el) => {
          contentRef.current = el
          if (el) el.style.opacity = (motion.current?.opacity ?? 0).toFixed(3)
        }}
        className="zen-band-content"
        data-swap={leaving ? '' : undefined}
      >
        <BandContent entry={showing} />
      </div>
    </div>
  )
}

function BandContent({ entry, inert }: { entry: BandEntry; inert?: boolean }): JSX.Element {
  const Icon = entry.icon
  return (
    <>
      <Icon className="zen-band-glyph" aria-hidden />
      <div className="zen-band-text">
        <div className="zen-band-title">{entry.title}</div>
        {entry.detail && <div className="zen-band-detail">{entry.detail}</div>}
      </div>
      <div className="zen-band-trailing">
        {entry.action && (
          <button
            type="button"
            className="zen-band-button"
            tabIndex={inert ? -1 : undefined}
            onClick={() => pickBandAction(entry.id)}
          >
            {entry.action.label}
          </button>
        )}
        {/* The × is "Dismiss" on every band, a prompt's included (the lead's ruling on #740): the
            message close's name, never a tenant's. On a prompt it is the one refusal remembered. */}
        <button
          type="button"
          className="zen-band-close"
          aria-label="Dismiss"
          tabIndex={inert ? -1 : undefined}
          onClick={() => dismissBand(entry.id, 'close')}
        >
          <X aria-hidden />
        </button>
      </div>
    </>
  )
}
