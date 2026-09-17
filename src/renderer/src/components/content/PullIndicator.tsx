import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { onPullFrame, PULL_REST, pullProgress, pullStore } from '@renderer/lib/pull'

/** The disc's diameter and the gap it keeps above the page's edge, CSS px. */
const DISC = 40
const GAP = 8
/** How far the glyph has turned when the pull reaches the threshold. */
const TURN_AT_THRESHOLD = 270

/**
 * The pull-to-refresh disc, drawn under the top edge of the content frame where the page WebView
 * lives above the chrome: the host moves the page down by the pull's offset and the disc shows in
 * the band that opens up, riding 8 px above the page's edge. Its glyph turns with the pull and
 * spins while the reload runs; on the way home it shrinks and fades along the same spring the
 * page comes back on. Everything per frame goes straight to the DOM (see `lib/pull.ts`).
 */
export function PullIndicator(): JSX.Element | null {
  const phase = pullStore.use((s) => s.phase)
  const armed = pullStore.use((s) => s.armed)
  const discRef = useRef<HTMLDivElement>(null)
  const glyphRef = useRef<HTMLDivElement>(null)
  const active = phase !== 'idle'

  useEffect(() => {
    if (!active) return
    return onPullFrame((offset) => {
      const disc = discRef.current
      const glyph = glyphRef.current
      if (!disc || !glyph) return
      const progress = pullProgress(offset)
      // Glued to the page's edge: hidden under the frame's top at rest, in the open at the threshold.
      const top = offset - DISC - GAP
      let scale = 0.85 + 0.15 * Math.min(1, progress)
      let opacity = 1
      if (phase === 'finishing') {
        // The page springs home from where it waited; the disc goes with it, shrinking away.
        const t = Math.min(1, offset / PULL_REST)
        scale = 0.4 + 0.6 * t
        opacity = t
      }
      disc.style.transform = `translate3d(0, ${top}px, 0) scale(${scale})`
      disc.style.opacity = String(opacity)
      glyph.style.setProperty('--zen-ptr-turn', `${progress * TURN_AT_THRESHOLD}deg`)
    })
  }, [active, phase])

  if (!active) return null
  const spinning = phase === 'refreshing' || phase === 'finishing'
  return (
    <div className="zen-ptr pointer-events-none absolute inset-x-0 top-0 z-[5]" aria-hidden>
      <div
        ref={discRef}
        className="zen-ptr-disc absolute left-1/2 top-0 flex items-center justify-center"
        data-armed={armed || undefined}
        style={{
          width: DISC,
          height: DISC,
          marginLeft: -DISC / 2,
          transform: `translate3d(0, ${-DISC - GAP}px, 0)`
        }}
      >
        <div ref={glyphRef} className="zen-ptr-glyph flex" data-spinning={spinning || undefined}>
          <RefreshCw className="h-5 w-5" strokeWidth={1.75} />
        </div>
      </div>
    </div>
  )
}
