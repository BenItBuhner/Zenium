import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Tab } from '@shared/types'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { useListMotion } from './listMotion'

/**
 * A tab group's fold on the tablet sidebar (TABLET-04; v2 §11.4's container motion): the block
 * of the header and its rows (`shell`) runs its height on `SPRING_GENTLE` between the header
 * (`header`) alone and the whole – a container breathing, as the overview's group card folds –
 * clipped to the shell on the way, so the rows fold up under the header and unfold from it
 * rather than cut; the rows below follow the height as it moves, so nothing crosses anything.
 * Folding shut, the rows it had stay drawn until the spring rests (React's "storing information
 * from previous renders", so they are there for the very commit that folds) and go then;
 * unfolding, the rows come back in that commit and are placed for the list's FLIP
 * (`SlideMotion.placeNext`) – their arrival is this motion's, not a row's entry. A fold caught
 * mid-flight retargets from where it is. Under reduced motion the spring jumps (§11.3). Off
 * (`enabled` false, the desktop) the block is as it was: the rows come and go with the state.
 * Returns the member rows to draw: the live ones while open, the ones it had while it folds shut.
 */
export function useGroupFold(
  shell: RefObject<HTMLDivElement | null>,
  header: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  tabs: Tab[],
  enabled: boolean
): Tab[] {
  const motion = useListMotion()

  const [wasCollapsed, setWasCollapsed] = useState(collapsed)
  const [kept, setKept] = useState<Tab[] | null>(null)
  if (collapsed !== wasCollapsed) {
    setWasCollapsed(collapsed)
    setKept(enabled && collapsed ? tabs : null)
  }
  const drawn = collapsed ? (kept ?? []) : tabs

  const fold = useRef<GroupFold | null>(null)
  useLayoutEffect(() => {
    const f = new GroupFold(shell, header, () => setKept(null))
    fold.current = f
    return () => {
      f.dispose()
      fold.current = null
    }
  }, [shell, header])

  // Runs before the panel's FLIP (a child's layout effect precedes its parent's): the shell is
  // at its start height when the rows below are measured, so they wait for the spring instead
  // of gliding, and the unfolding rows are marked placed before the FLIP meets them.
  const seen = useRef(collapsed)
  useLayoutEffect(() => {
    if (seen.current === collapsed) return
    seen.current = collapsed
    if (!enabled) return
    if (!collapsed) motion?.placeNext(tabs.map((t) => t.id))
    fold.current?.run(collapsed)
  })

  return drawn
}

/** The fold's motion: the shell's height on the spring, the shell clipped while it runs. */
class GroupFold {
  private readonly spring: SpringAnimation

  constructor(
    private readonly shell: RefObject<HTMLDivElement | null>,
    private readonly header: RefObject<HTMLDivElement | null>,
    onRest: () => void
  ) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (h) => {
        const el = this.shell.current
        if (el) el.style.height = `${Math.max(0, h)}px`
      },
      () => {
        // At rest the layout holds the height: the header's alone once the kept rows go.
        const el = this.shell.current
        if (el) {
          el.style.height = ''
          delete el.dataset.folding
        }
        onRest()
      }
    )
  }

  /** The block has just been committed folded (`collapsed`) or unfolded: run the height there. */
  run(collapsed: boolean): void {
    const el = this.shell.current
    const head = this.header.current
    if (!el || !head) return
    const anim = this.spring
    const flying = anim.running ? anim.current.x : null
    el.style.height = ''
    const whole = el.offsetHeight
    const alone = head.offsetHeight
    const to = collapsed ? alone : whole
    const from = flying ?? (collapsed ? whole : alone)
    el.dataset.folding = ''
    el.style.height = `${from}px`
    if (flying === null) anim.start(from, 0, to)
    else anim.retarget(to)
  }

  dispose(): void {
    this.spring.stop()
  }
}
