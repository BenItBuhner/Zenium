import { Component } from 'react'
import type { SlideMotion } from '@renderer/lib/motion/slide'

interface Props {
  motion: SlideMotion
  /**
   * What the list's `flip` runs on (its layout effect's dependencies, `motion` aside): a change
   * in them is a commit that flips, and the one read before it.
   */
  deps: readonly unknown[]
}

/**
 * The settled read before a list's commit (MOT-33's delta). `SlideMotion.flip` springs each row
 * from where the last read had it to where the commit laid it out; between commits the chrome
 * can move under the list with no commit of the list's own – the host's insets landing after the
 * first paint (`applyHostInsets`, `.zen-window`'s padding), a resize – and the last commit's read
 * is then stale by that much: the first grow after boot found every row 24 px from where it
 * stood and glided them all down. A row whose box the commit did not change must never move
 * (v2 §11.4), so the list is read again where it stands just before the commit mutates it, in
 * `getSnapshotBeforeUpdate` – the one read of the DOM as it stood before a commit, which only a
 * class component has (`PaneSlot`'s precedent; StrictMode does not replay it) – on the commits
 * that flip. The read is the flip's own measure a moment early (a rect per row); the rows' boxes
 * and the followers' places come with it. A leaf of the panel, nothing drawn.
 */
export class SlideSnapshot extends Component<Props> {
  shouldComponentUpdate(next: Props): boolean {
    return next.motion !== this.props.motion || changed(this.props.deps, next.deps)
  }

  getSnapshotBeforeUpdate(prev: Props): null {
    if (prev.motion === this.props.motion) this.props.motion.record()
    return null
  }

  componentDidUpdate(): void {
    // The read is the snapshot's whole work; React asks for the pair.
  }

  render(): null {
    return null
  }
}

function changed(before: readonly unknown[], after: readonly unknown[]): boolean {
  return before.length !== after.length || before.some((v, i) => !Object.is(v, after[i]))
}
