import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { Tab } from '@shared/types'
import { progressTarget } from '@renderer/lib/motion/progress'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'

interface Props {
  tab: Tab | null
  /** Chrome covers the frame (URL bar, stage, overlays): the bar keeps its place but not its ink. */
  hidden: boolean
}

/** The fade at the end, matching `.zen-load-progress`'s opacity transition. */
const FADE_MS = 200
/** How often the creep re-aims the spring while a report stands still. */
const CREEP_TICK_MS = 250

/**
 * The 2 px load bar along the top edge of the content frame: `--zen-accent-fill`, a light sweep
 * running through the filled part, a spring (`SPRING_SNAPPY`, in percent) towards the page's
 * progress or the creep, then filled to the end and faded out in 200 ms. Everything per frame is
 * a `scaleX` on the fill; the bar's own opacity only ever transitions. Switching tabs shows the
 * new tab's bar where it stands – no motion from where the old one was.
 */
export function LoadProgress({ tab, hidden }: Props): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  const shown = useRef(false)
  const shownTabId = useRef<string | null>(null)
  const startedAt = useRef(0)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tabId = tab?.id ?? null
  const loading = tab?.loading ?? false
  const progress = tab?.progress ?? 0

  useEffect(() => {
    const bar = barRef.current
    const fill = fillRef.current
    if (!bar || !fill) return
    const draw = (x: number): void => {
      fill.style.transform = `scaleX(${Math.min(1, Math.max(0, x / 100))})`
    }
    const cancelFade = (): void => {
      if (fadeTimer.current !== null) clearTimeout(fadeTimer.current)
      fadeTimer.current = null
    }
    const hide = (): void => {
      shown.current = false
      delete bar.dataset.shown
    }
    const finished = (): void => {
      // Filled: let the opacity transition run, then put the fill away for the next load.
      hide()
      cancelFade()
      fadeTimer.current = setTimeout(() => {
        fadeTimer.current = null
        if (!shown.current) draw(0)
      }, FADE_MS)
    }
    spring.current ??= new SpringAnimation(SPRING_SNAPPY, draw, (x) => {
      if (x >= 100) finished()
    })
    const anim = spring.current
    const target = (): number =>
      progressTarget(progress, true, performance.now() - startedAt.current) * 100

    const switched = tabId !== shownTabId.current
    if (switched) {
      // Another tab (or none): whatever the old one showed goes without a trace.
      anim.stop()
      cancelFade()
      hide()
      shownTabId.current = tabId
      draw(0)
    }
    if (tabId === null) return undefined

    if (loading) {
      if (!shown.current) {
        cancelFade()
        shown.current = true
        bar.dataset.shown = 'true'
        startedAt.current = performance.now()
        // A tab switched to mid-load shows its bar where it stands; a load seen from the start
        // grows from nothing.
        anim.start(switched ? target() : 0, 0, target())
      } else {
        anim.retarget(target())
      }
      const tick = setInterval(() => anim.retarget(target()), CREEP_TICK_MS)
      return () => clearInterval(tick)
    }

    // The page finished (or failed): fill to the end; the spring's rest hands over to the fade.
    if (shown.current) anim.retarget(100)
    return undefined
  }, [tabId, loading, progress])

  useEffect(
    () => () => {
      spring.current?.stop()
      if (fadeTimer.current !== null) clearTimeout(fadeTimer.current)
    },
    []
  )

  return (
    // The layer is the frame's box, so it recedes with the frame under a phone sheet.
    <div className="zen-load-progress-layer pointer-events-none absolute inset-0" aria-hidden>
      <div ref={barRef} className="zen-load-progress" data-hidden={hidden || undefined}>
        <div ref={fillRef} className="zen-load-progress-fill" />
      </div>
    </div>
  )
}
