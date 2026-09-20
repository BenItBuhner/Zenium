import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Fingerprint, VenetianMask } from 'lucide-react'
import type { Tab } from '@shared/types'
import { fadeOpacity } from '@renderer/lib/motion/fade'
import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from '@renderer/lib/motion/spring'
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
}

/** The picture's blur under the veil, at rest (CSS px; `--zen-lock-blur` in main.css). */
export const LOCK_BLUR_PX = 18

/** What the last render had of the lock and the ask, and whether the cover is on its lift. */
interface Phase {
  locked: boolean
  shown: boolean
  leaving: boolean
}

/**
 * The lock cover of "Lock private tabs when you leave Zenium" (INC-05; Chrome's locked Incognito
 * view): over a locked private tab in the content frame, and over the overview's Private pane.
 * The private content stays under it, blurred to colour – the tab's last picture (`TabPreview`,
 * masked), the pane's cards under the veil's backdrop blur – behind a veil in the panel tone; a
 * tab with no picture (never captured) has the bare placeholder under the veil, which then
 * reads as the opaque panel-toned cover. On it, §9.17's empty-state
 * block: the mask, "Your private tabs are locked" and one primary button, Unlock with the
 * fingerprint glyph, in the window family – which the private theme paints, the tab in view
 * being private (§9.19). Unlock asks the host for the system's prompt (`unlockPrivateTabs`); a
 * pass lifts the cover on the spring – the veil fading and the blur dissolving into the page's
 * picture, the page view coming back under it as the lift lands (`lifting`, `liftLanded`) – and a
 * cancel or a failure leaves it, the prompt having carried its own message. The regular tabs,
 * Settings and the bar are not covered: only private content is.
 */
export function PrivateLockCover({ shown, tab = null, className }: Props): JSX.Element | null {
  const prompting = privateLockStore.use((s) => s.prompting)
  const locked = privateLockStore.use((s) => s.locked)
  const lifting = privateLockStore.use((s) => s.lifting)
  const ref = useRef<HTMLDivElement>(null)
  // The cover lifts once the lock has come off under it: at rest → leaving → gone. Asked away
  // while the lock stands – the gesture stage or the omnibox taking the frame over – it goes at
  // once: a cover fading behind the shrinking hero card would show around it. State derived
  // during render (the React pattern for "what did the previous render have"), as `SheetPresence`.
  const [phase, setPhase] = useState<Phase>({ locked, shown, leaving: false })
  if (locked) {
    // At rest – or back at rest: a lock again during a lift (Home right after the pass).
    if (phase.leaving || phase.locked !== locked || phase.shown !== shown)
      setPhase({ locked, shown, leaving: false })
  } else if (phase.locked) {
    // The lock came off since the last render: under a cover at rest it lifts – whether the
    // cover is still asked for meanwhile (the frame's, through `lifting`) or not (the pane's).
    setPhase({ locked, shown, leaving: phase.shown })
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
    // Under reduced motion the departure is the 120 ms fade in place (§11.3).
    const stop = reducedMotion()
      ? fadeOpacity(el, 0, done)
      : (() => {
          const spring = new SpringAnimation(
            SPRING_SNAPPY,
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
  return (
    <div
      ref={ref}
      className={cn('zen-private-lock absolute inset-0', className)}
      data-testid="private-lock-cover"
      data-leaving={leaving || undefined}
      // No picture of its own (the Private pane, the private new tab page): the veil's backdrop
      // blur covers what lies under it, on no base.
      data-backdrop={tab ? undefined : ''}
      // The window family: the private theme's ink (§9.29).
      data-surface="window"
      // A leaving cover takes no press: its Unlock is done.
      inert={leaving || undefined}
      role="group"
      aria-label="Private tabs locked"
    >
      {tab && <TabPreview tab={tab} cover className="zen-private-lock-picture" />}
      <div className="zen-private-lock-veil absolute inset-0" />
      <div
        className="zen-private-lock-block absolute inset-x-0 flex flex-col items-center px-8 text-center"
        style={{ top: '45%' }}
      >
        <VenetianMask className="h-12 w-12" strokeWidth={1.5} aria-hidden />
        <h2 className="mt-4 text-[22px] font-semibold leading-7 tracking-[-0.012em]">
          Your private tabs are locked
        </h2>
        <V2Button
          variant="primary"
          busy={prompting}
          className="mt-5 gap-2"
          data-testid="private-lock-unlock"
          onClick={() => void unlockPrivateTabs()}
        >
          <Fingerprint className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          Unlock
        </V2Button>
      </div>
    </div>
  )
}
