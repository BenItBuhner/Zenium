import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import type { UIState } from '@shared/types'
import {
  GROUP_STRIP_HEIGHT,
  GROUP_STRIP_VAR,
  groupStripFor,
  leavingStripFor,
  stripKey,
  type GroupStripModel
} from '@renderer/lib/groupStrip'

/**
 * Where the strip is in its life: sliding out of the bar (`entering`), at rest (`shown`), or
 * sliding back behind it because the active tab left its group (`leaving`); `absent` has no
 * strip. The strip component runs the spring and reports the two ends.
 */
export type GroupStripPhase = 'absent' | 'entering' | 'shown' | 'leaving'

export interface GroupStripPresence {
  /**
   * The strip's content – the group as it stands, without an active member, while leaving. The
   * same object from one browser state to the next while nothing the strip draws has changed.
   */
  model: GroupStripModel
  phase: Exclude<GroupStripPhase, 'absent'>
  /** The entrance has settled. */
  onEntered: () => void
  /** The strip is behind the bar: it can go, and the band closes. */
  onLeft: () => void
}

interface Presence {
  phase: GroupStripPhase
  /**
   * What the strip shows – or showed last, while it leaves: the model a group that is gone
   * slides out with. Null only while absent.
   */
  model: GroupStripModel | null
  /** `stripKey` of `model`: the model is kept while its key holds. */
  key: string | null
}

/**
 * The strip's presence for the active tab. The strip is not simply mounted while the active tab
 * is grouped: it enters when the tab joins (or a grouped tab becomes active) and, when the tab
 * leaves its group, stays with the group's remaining chips until its own slide out has landed –
 * only then does it go and the band close (v2 §11.2's leaving rule, on a strip). A group that
 * is dissolved, or left behind by a switch of space, takes the strip out the same way, as it
 * last stood. A grouped tab that becomes active while the strip is on its way out turns it
 * round on the same spring.
 *
 * The strip's share of the bar band goes on the document root as `--zen-group-strip`, in one
 * step at each end – the band opens as the strip starts in and closes once it is out – so the
 * content column's inset (and with it the layout report to the host) changes exactly once per
 * appearance and once per departure, never per frame.
 */
export function useGroupStrip(state: UIState): GroupStripPresence | null {
  const live = groupStripFor(state)
  // At mount a grouped tab's strip is simply there (a restored session): nothing slides.
  const [presence, setPresence] = useState<Presence>(() => ({
    phase: live ? 'shown' : 'absent',
    model: live,
    key: live && stripKey(live)
  }))
  // Adjusted in the render that sees the change (React's pattern for state derived from a
  // prop), so the strip never draws a frame in the wrong phase and never unmounts between two.
  const next = advance(presence, live, state)
  if (next !== presence) setPresence(next)
  const { phase, model } = next

  const onEntered = useCallback(
    () => setPresence((p) => (p.phase === 'entering' ? { ...p, phase: 'shown' } : p)),
    []
  )
  const onLeft = useCallback(
    () =>
      setPresence((p) => (p.phase === 'leaving' ? { phase: 'absent', model: null, key: null } : p)),
    []
  )

  const present = phase !== 'absent'
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty(GROUP_STRIP_VAR, present ? `${GROUP_STRIP_HEIGHT}px` : '0px')
  }, [present])
  useLayoutEffect(
    () => () => {
      document.documentElement.style.removeProperty(GROUP_STRIP_VAR)
    },
    []
  )

  // One object per model and phase, so the strip (a `memo`) sits out the browser states that
  // change nothing of it.
  return useMemo(
    () => (model && phase !== 'absent' ? { model, phase, onEntered, onLeft } : null),
    [model, phase, onEntered, onLeft]
  )
}

/**
 * The presence after a browser state: the phase it moves to and the model it shows. A strip
 * that is live shows the live model; one whose tab has left shows the group as `leavingStripFor`
 * has it, until its slide out lands. The model the strip drew last stays its model while it
 * shows the same (`stripKey`), so the strip re-renders, and measures its chips, only when
 * something it draws has changed; `presence` itself comes back when nothing moved.
 */
function advance(presence: Presence, live: GroupStripModel | null, state: UIState): Presence {
  let phase = presence.phase
  let model: GroupStripModel | null = null
  if (live) {
    phase = phase === 'absent' ? 'entering' : phase === 'leaving' ? 'shown' : phase
    model = live
  } else if (phase !== 'absent') {
    model = presence.model && leavingStripFor(state, presence.model)
    phase = model ? 'leaving' : 'absent'
  }
  const key = model && stripKey(model)
  if (key !== presence.key) return { phase, model, key }
  return phase === presence.phase ? presence : { ...presence, phase }
}
