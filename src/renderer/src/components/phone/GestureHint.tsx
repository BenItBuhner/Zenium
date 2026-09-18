import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PhoneBarPosition, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'

/** The hint waits this long after the page first shows, and stays this long unless touched. */
const SHOW_AFTER_MS = 1200
const STAY_MS = 6000
/** How far (px) the panel travels, in from the pill's side, while fading. */
const TRAVEL = 10

/**
 * One-time gesture education (FRE-07): a small panel beside the address pill – "swipe to switch
 * tabs, pull for all of them" – the first time the phone chrome shows a page after the first
 * run. It is a sibling of the content frame on the bar's side, not part of the bar: the page
 * gets a little shorter while it is up, the way it does under the default-browser banner. (On
 * Android the page is a native view above the chrome, so a hint floating over the page would
 * never be seen.) The slot opens in one step and one `SPRING_GENTLE` spring carries the panel
 * in and out (opacity and a short slide, nothing that reflows); it leaves after its moment or at
 * the first touch on the chrome, and once it has fully arrived it is not shown again (the
 * `gestureHintDone` setting).
 */
export function GestureHint({
  state,
  edge,
  /** Whether the chrome is calm enough for a hint (no overlay, drag or prompt in the way). */
  calm
}: {
  state: UIState
  edge: PhoneBarPosition
  calm: boolean
}): JSX.Element | null {
  const eligible = state.settings.onboardingDone && !state.settings.gestureHintDone && calm
  const [phase, setPhase] = useState<'waiting' | 'shown' | 'gone'>('waiting')

  // The wait starts over whenever the chrome stops being calm.
  useEffect(() => {
    if (!eligible || phase !== 'waiting') return
    const timer = setTimeout(() => setPhase('shown'), SHOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [eligible, phase])
  // Once up it stays up while the chrome is calm, even as its arrival marks it done; the chrome
  // getting busy takes it down for good.
  if (phase === 'shown' && !calm) setPhase('gone')

  if (phase !== 'shown' || !calm) return null
  return <HintSlot edge={edge} onDone={() => setPhase('gone')} />
}

function HintSlot({ edge, onDone }: { edge: PhoneBarPosition; onDone: () => void }): JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  const el = useRef<HTMLDivElement>(null)

  // The slot takes its full height in one step – a height that moved per frame would reflow the
  // content frame and re-bound the page's native view on every frame (v1 §7.4) – and closes the
  // same way when the panel has gone. One spring over "how present" the panel is carries its
  // opacity and a short slide in from the pill's side; `will-change` is on only while it runs.
  useEffect(() => {
    const box = slot.current
    const node = el.current
    if (!box || !node) return
    const gap = parseFloat(getComputedStyle(box).getPropertyValue('--zen-padding')) || 8
    box.style.height = `${node.offsetHeight + gap}px`
    const from = edge === 'bottom' ? 1 : -1
    const paint = (p: number): void => {
      const v = Math.min(1, Math.max(0, p))
      node.style.opacity = v.toFixed(3)
      node.style.transform = `translateY(${((1 - v) * TRAVEL * from).toFixed(2)}px)`
    }
    const moving = (on: boolean): void => {
      if (on) node.dataset.moving = ''
      else delete node.dataset.moving
    }
    // Once the hint has fully arrived it has had its one showing, whatever takes it down later
    // (its time, a touch, or the chrome getting busy and unmounting it mid-flight).
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      run('settings.update', { gestureHintDone: true })
    }
    const spring = new SpringAnimation(SPRING_GENTLE, paint, (rest) => {
      paint(rest)
      moving(false)
      if (rest === 1) finish()
      if (rest === 0) {
        finish()
        onDone()
      }
    })
    paint(0)
    moving(true)
    spring.start(0, 0, 1)
    const leave = (): void => {
      const { x, v } = spring.stop()
      moving(true)
      spring.start(x, Math.min(v, 0), 0)
    }
    const stay = setTimeout(leave, STAY_MS)
    // The first touch anywhere is the user getting on with it.
    const onTouch = (): void => {
      clearTimeout(stay)
      leave()
    }
    window.addEventListener('pointerdown', onTouch, { capture: true, passive: true })
    return () => {
      clearTimeout(stay)
      window.removeEventListener('pointerdown', onTouch, { capture: true })
      spring.stop()
      moving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per showing
  }, [edge])

  return (
    <div ref={slot} className="zen-hint-slot" data-edge={edge} style={{ height: 0 }}>
      <div ref={el} role="status" className="zen-hint" style={{ opacity: 0 }}>
        Swipe the address bar to switch tabs, pull it {edge === 'bottom' ? 'up' : 'down'} to see
        them all.
      </div>
    </div>
  )
}
