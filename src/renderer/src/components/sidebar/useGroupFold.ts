import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SavedGroupTab, Tab } from '@shared/types'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { useListMotion } from './listMotion'

/**
 * What a group's block draws under its header: its live member rows (`tabs`) and, on the
 * desktop, the pages a SAVED group keeps as rows of its own (`pages`, TAB-16's desktop half –
 * `SavedPageRow`). A group has one or the other: live regular members make it open, pages
 * with none make it saved.
 */
export interface GroupRows {
  tabs: Tab[]
  pages: SavedGroupTab[]
}

const NO_ROWS: GroupRows = { tabs: [], pages: [] }

/**
 * A tab group's fold on every host (TABLET-04, tabs-15; v2 §9.36 as amended, §11.4's container
 * motion): the block of the header and its rows (`shell`) runs its height on `SPRING_GENTLE`
 * between the header (`header`) alone and the whole – a container breathing, as the overview's
 * group card folds – clipped to the shell on the way, so the rows fold up under the header and
 * unfold from it rather than cut; the rows below follow the height as it moves, so nothing
 * crosses anything. Folding shut, the rows it had stay drawn until the spring rests (React's
 * "storing information from previous renders", so they are there for the very commit that
 * folds) and go then; unfolding, the rows come back in that commit. The live rows are placed
 * for the list's FLIP (`SlideMotion.placeNext`) – their arrival is this motion's, not a row's
 * entry; a saved group's page rows have no motion of their own in the list (a page is a button
 * that opens the folder, no item that slides), so the clip is their whole arrival. Either kind
 * is kept through the fold, so the shell measures the whole block – the desktop's saved folder
 * folded shut and sprang open until its pages were kept (#360's F5). A fold caught mid-flight
 * retargets from where it is. Under reduced motion the spring jumps: the cut (§11.3). The
 * horizontal strip (v2 §9.37) runs the same fold along its `axis`, `x`: the block's width
 * between the chip alone and the chip with its members, the fold clipped the same way.
 *
 * Two things keep the rows below the block honest. The list's FLIP (`SlideMotion.flip`) springs
 * a row from where its layout stood at the last commit to where it stands now – and the fold
 * moves the layout under the rows below with no commit between its first frame and its rest, so
 * the next commit would find them a block's height from where it last saw them and spring them
 * across it (the rows under a group drawn a folder's height off as it folded again). So the
 * list's baseline follows every frame of the fold (`SlideMotion.record`): the commit after finds
 * the rows where they are. And folding shut, the rest comes on an animation frame while the kept
 * rows are still in the DOM: letting the layout hold the extent there would paint the whole
 * block open for the frame before the commit that removes them lands. So the shell holds the
 * header's extent, clipped, until that commit, and lets go in its layout effect – nothing paints
 * between.
 *
 * Returns the rows to draw: the live ones while open, the ones it had while it folds shut.
 */
export function useGroupFold(
  shell: RefObject<HTMLDivElement | null>,
  header: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  rows: GroupRows,
  axis: 'x' | 'y' = 'y'
): GroupRows {
  const motion = useListMotion()

  const [wasCollapsed, setWasCollapsed] = useState(collapsed)
  const [kept, setKept] = useState<GroupRows | null>(null)
  if (collapsed !== wasCollapsed) {
    setWasCollapsed(collapsed)
    setKept(collapsed ? rows : null)
  }
  const drawn = collapsed ? (kept ?? NO_ROWS) : rows

  const fold = useRef<GroupFold | null>(null)
  useLayoutEffect(() => {
    const f = new GroupFold(
      shell,
      header,
      axis,
      () => motion?.record(),
      () => setKept(null)
    )
    fold.current = f
    return () => {
      f.dispose()
      fold.current = null
    }
  }, [shell, header, axis, motion])

  // Runs before the panel's FLIP (a child's layout effect precedes its parent's): the shell is
  // at its start height when the rows below are measured, so they wait for the spring instead
  // of gliding, and the unfolding rows are marked placed before the FLIP meets them. The commit
  // after a fold shut rested – the kept rows gone – lets the held extent go to the layout.
  const seen = useRef(collapsed)
  useLayoutEffect(() => {
    if (seen.current === collapsed) {
      if (kept === null) fold.current?.release()
      return
    }
    seen.current = collapsed
    if (!collapsed) motion?.placeNext(rows.tabs.map((t) => t.id))
    fold.current?.run(collapsed)
  })

  return drawn
}

/**
 * The fold's motion: the shell's extent along the list's axis – its height in the sidebar, its
 * width in the strip – on the spring, the shell clipped while it runs (`data-folding`). After
 * each frame `follow` lets the list's baseline follow the layout; at rest `onRest` releases the
 * rows kept for the fold, the shell holding the shut extent until `release` (the commit that
 * removed them) where it rested shut, the layout holding it where it rested open.
 */
class GroupFold {
  private readonly spring: SpringAnimation
  private readonly property: 'height' | 'width'
  /** The run in flight folds shut (`true`) or open (`false`). */
  private shut = false
  /** Rested shut: the extent held on the shell until the kept rows' removal commits. */
  private holding = false

  constructor(
    private readonly shell: RefObject<HTMLDivElement | null>,
    private readonly header: RefObject<HTMLDivElement | null>,
    axis: 'x' | 'y',
    private readonly follow: () => void,
    onRest: () => void
  ) {
    this.property = axis === 'x' ? 'width' : 'height'
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (extent) => {
        const el = this.shell.current
        if (!el) return
        el.style[this.property] = `${Math.max(0, extent)}px`
        this.follow()
      },
      () => {
        const el = this.shell.current
        if (el) {
          if (this.shut) {
            // The kept rows are still in the DOM: the layout would hold the whole block for
            // the frame before their removal commits. Stand at the header's extent, clipped,
            // until `release`.
            el.style[this.property] = `${this.spring.destination}px`
            this.holding = true
          } else {
            // Open: the layout holds the whole.
            el.style[this.property] = ''
            delete el.dataset.folding
          }
          this.follow()
        }
        onRest()
      }
    )
  }

  /** The block has just been committed folded (`collapsed`) or unfolded: run the extent there. */
  run(collapsed: boolean): void {
    const el = this.shell.current
    const head = this.header.current
    if (!el || !head) return
    const anim = this.spring
    const flying = anim.running ? anim.current.x : null
    this.holding = false
    this.shut = collapsed
    el.style[this.property] = ''
    const measure = (node: HTMLElement): number =>
      this.property === 'width' ? node.offsetWidth : node.offsetHeight
    const whole = measure(el)
    const alone = measure(head)
    const to = collapsed ? alone : whole
    const from = flying ?? (collapsed ? whole : alone)
    el.dataset.folding = ''
    el.style[this.property] = `${from}px`
    if (flying === null) anim.start(from, 0, to)
    else anim.retarget(to)
  }

  /** The kept rows are gone from the DOM: the layout holds the header's extent from here. */
  release(): void {
    if (!this.holding) return
    this.holding = false
    const el = this.shell.current
    if (!el) return
    el.style[this.property] = ''
    delete el.dataset.folding
  }

  dispose(): void {
    this.spring.stop()
  }
}
