import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Fingerprint, VenetianMask } from 'lucide-react'
import type { Tab } from '@shared/types'
import { fadeOpacity } from '@renderer/lib/motion/fade'
import {
  SPRING_SNAPPY,
  SpringAnimation,
  reducedMotion,
  type SpringConfig
} from '@renderer/lib/motion/spring'
import { liftLanded, privateLockStore, unlockPrivateTabs } from '@renderer/lib/privateLock'
import { cn } from '@renderer/lib/utils'
import { V2Button } from '../extensions/v2'
import { TabPreview } from './TabPreview'

interface Props {
  /**
   * The cover is asked for: the private tabs are locked and the tab in front is private (the
   * content frame), or the overview is on its Private pane (the pane). Off, a cover that was up
   * lifts before it goes.
   */
  shown: boolean
  /**
   * The private tab the cover stands over in the content frame: its last picture, blurred, is
   * what the veil is over, and what the page comes back in place of once the cover has lifted.
   * None over the Private pane, whose cards lie under the veil themselves.
   */
  tab?: Tab | null
  className?: string
  /**
   * The cover whole (the default): the opaque base, the picture where there is one, the veil
   * and the block with Unlock. Or the VEIL alone, over a surface whose rows are masked already
   * and whose Unlock is the frame's – the tablet sidebar's private pose (W4-11): the veil in the
   * window's tone over the rows reading "Private tab", no base under it (the rows show through,
   * masked), no second block, lifting on the same spring as the frame's cover beside it.
   */
  variant?: 'cover' | 'veil'
}

/** The picture's blur under the veil, at rest (CSS px; `--zen-lock-blur` in main.css). */
export const LOCK_BLUR_PX = 18

/**
 * `SPRING_SNAPPY` for the lift's 1 → 0 value. The shared spring rests in px and px/s
 * (`restDelta` .4, `restSpeed` 8): on a unit value it would call the lift settled around the
 * half and snap the cover away with the veil at half and the picture still blurred – a pop, not
 * a lift. A hundredth of each lets the value run to 0 as a position does (`MenuSheet`'s fill
 * and `BarPreview`'s presence take the same numbers): 22 frames at 60 Hz, no frame stepping
 * more than .13, at rest by 370 ms.
 */
const SPRING_LIFT: SpringConfig = { ...SPRING_SNAPPY, restDelta: 0.004, restSpeed: 0.08 }

/**
 * What the last render had of the lock and the ask, whether the cover is on its lift, and
 * whether the page and the rows wait on that lift (`lifting`): a lift waited on ends with the
 * wait.
 */
interface Phase {
  locked: boolean
  shown: boolean
  leaving: boolean
  waited: boolean
}

/**
 * The lock cover of "Lock private tabs when you leave Zenium" (INC-05; Chrome's locked Incognito
 * view): over a locked private tab in the content frame, and over the overview's Private pane.
 * An opaque cover in the panel tone (§9.19: nothing of the page's identity shows before the
 * unlock, so it never relies on what lies under it): over a private tab the tab's last picture
 * lies on it blurred to colour (`TabPreview`, masked) under a veil in the window's tone; with no
 * picture – the Private pane, whose cards it hides whole, the private new tab page, a tab never
 * captured – the veil lies on the panel base alone. On it, §9.17's cover form of the page
 * block: the 20 px mask naming the state, "Your private tabs are locked" at 17/600, one primary
 * button 8 below – Unlock with the fingerprint glyph (§9.11: the glyph names the means, the
 * label the outcome) – and no description, centred at 45% of the height, in the window family
 * the private theme paints (§9.29, §9.19). Unlock asks the host for the system's prompt
 * (`unlockPrivateTabs`); a pass lifts the cover on the spring (§11.6: one value, the veil and the
 * block fading, the blur dissolving into the page's picture, nothing sliding), the page view
 * coming back under it as the lift lands (`lifting`, `liftLanded`); a cancel or a failure leaves
 * it, the prompt having carried its own message. The regular tabs, Settings and the bar are not
 * covered: only private content is.
 */
export function PrivateLockCover({
  shown,
  tab = null,
  className,
  variant = 'cover'
}: Props): JSX.Element | null {
  const prompting = privateLockStore.use((s) => s.prompting)
  const locked = privateLockStore.use((s) => s.locked)
  const lifting = privateLockStore.use((s) => s.lifting)
  const ref = useRef<HTMLDivElement>(null)
  // The cover lifts once the lock has come off under it: at rest → leaving → gone. Asked away
  // while the lock stands – the gesture stage or the omnibox taking the frame over – it goes at
  // once: a cover fading behind the shrinking hero card would show around it. State derived
  // during render (the React pattern for "what did the previous render have"), as `SheetPresence`.
  const [phase, setPhase] = useState<Phase>({ locked, shown, leaving: false, waited: false })
  if (locked) {
    // At rest – or back at rest: a lock again during a lift (Home right after the pass).
    if (phase.leaving || phase.locked !== locked || phase.shown !== shown)
      setPhase({ locked, shown, leaving: false, waited: false })
  } else if (phase.locked) {
    // The lock came off since the last render: under a cover at rest it lifts – whether the
    // cover is still asked for meanwhile (the frame's, through `lifting`) or not (the pane's).
    setPhase({ locked, shown, leaving: phase.shown, waited: lifting })
  } else if (phase.leaving && phase.waited && !lifting) {
    // The wait ended before this cover landed – `LIFT_MAX_MS` ran out (the spring steps at most
    // 64 ms a frame, and on a device drawing a frame every 100 ms or more it lands after the
    // deadline), or the cover beside it (the frame's, the sidebar's veil) landed a frame first:
    // the cover goes with the wait, in the render that brings the page and the titles back, so
    // neither ever shows under a cover still up. The wait is the release's, not a surface's:
    // `lifting` is set when the release finds a private tab in view (`activeTabIsPrivate`), and
    // every cover up in that render is waited on – the frame's, the sidebar's veil, the overview
    // pane's alike. A lift nothing waited on (a release with a regular tab in view: the pane's
    // cover alone) runs its spring out.
    setPhase({ locked, shown, leaving: false, waited: false })
  } else if (phase.shown !== shown) {
    setPhase({ ...phase, shown })
  }
  const leaving = phase.leaving
  // Released with no cover up here to lift (the omnibox or the stage over the tab): nothing to
  // see, the page comes back at once.
  useLayoutEffect(() => {
    if (!locked && lifting && !leaving && !shown) liftLanded()
  }, [locked, lifting, leaving, shown])
  useEffect(() => {
    const el = ref.current
    if (!leaving || !el) return
    const done = (): void => {
      setPhase((p) => (p.leaving ? { ...p, leaving: false } : p))
      liftLanded()
    }
    // Under reduced motion the departure is §11.3's 120 ms fade in place (the program's reading
    // of §11.6's "a cut": the departure rule every surface takes).
    const stop = reducedMotion()
      ? fadeOpacity(el, 0, done)
      : (() => {
          const spring = new SpringAnimation(
            SPRING_LIFT,
            (x) => el.style.setProperty('--zen-lock-p', Math.max(0, Math.min(1, x)).toFixed(4)),
            done
          )
          spring.start(1, 0, 0)
          return () => spring.stop()
        })()
    return () => {
      stop()
      // Whatever the lift wrote goes with it: a cover locked again mid-lift is whole.
      el.style.removeProperty('--zen-lock-p')
      el.style.removeProperty('opacity')
    }
  }, [leaving])
  if (!shown && !leaving) return null
  const veil = variant === 'veil'
  return (
    <div
      ref={ref}
      className={cn('zen-private-lock absolute inset-0', className)}
      data-testid="private-lock-cover"
      data-variant={veil ? 'veil' : undefined}
      data-leaving={leaving || undefined}
      // The window family: the private theme's ink (§9.29).
      data-surface="window"
      // A leaving cover takes no press: its Unlock is done.
      inert={leaving || undefined}
      role="group"
      aria-label="Private tabs locked"
    >
      {tab && !veil && <TabPreview tab={tab} cover className="zen-private-lock-picture" />}
      <div className="zen-private-lock-veil absolute inset-0" />
      {!veil && (
        <div
          className="zen-private-lock-block absolute inset-x-0 flex flex-col items-center px-8 text-center"
          style={{ top: '45%' }}
        >
          <VenetianMask className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          <h2 className="zen-private-lock-title mt-3">Your private tabs are locked</h2>
          <V2Button
            variant="primary"
            busy={prompting}
            className="mt-2 gap-2"
            data-testid="private-lock-unlock"
            onClick={() => void unlockPrivateTabs()}
          >
            <Fingerprint className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            Unlock
          </V2Button>
        </div>
      )}
    </div>
  )
}
