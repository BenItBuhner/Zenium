import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import type { UIState } from '@shared/types'
import {
  GROUP_STRIP_HEIGHT,
  GROUP_STRIP_VAR,
  groupStripFor,
  leavingStripFor,
  type GroupStripModel
} from '@renderer/lib/groupStrip'

/**
 * Where the strip is in its life: sliding out of the bar (`entering`), at rest (`shown`), or
 * sliding back behind it because the active tab left its group (`leaving`); `absent` has no
 * strip. The strip component runs the spring and reports the two ends.
 */
export type GroupStripPhase = 'absent' | 'entering' | 'shown' | 'leaving'

export interface GroupStripPresence {
  /** The strip's content – the group as it stands, without an active member, while leaving. */
  model: GroupStripModel
  phase: Exclude<GroupStripPhase, 'absent'>
  /** The entrance has settled. */
  onEntered: () => void
  /** The strip is behind the bar: it can go, and the band closes. */
  onLeft: () => void
}

interface Presence {
  phase: GroupStripPhase
  /** The group the strip shows (or showed, while it leaves). */
  groupId: string | null
}

/**
 * The strip's presence for the active tab. The strip is not simply mounted while the active tab
 * is grouped: it enters when the tab joins (or a grouped tab becomes active) and, when the tab
 * leaves its group, stays with the group's remaining chips until its own slide out has landed –
 * only then does it go and the band close (v2 §11.2's leaving rule, on a strip). A grouped tab
 * that becomes active while the strip is on its way out turns it round on the same spring.
 *
 * The strip's share of the bar band goes on the document root as `--zen-group-strip`, in one
 * step at each end – the band opens as the strip starts in and closes once it is out – so the
 * content column's inset (and with it the layout report to the host) changes exactly once per
 * appearance and once per departure, never per frame.
 */
export function useGroupStrip(state: UIState): GroupStripPresence | null {
  const live = useMemo(() => groupStripFor(state), [state])
  // At mount a grouped tab's strip is simply there (a restored session): nothing slides.
  const [presence, setPresence] = useState<Presence>(() => ({
    phase: live ? 'shown' : 'absent',
    groupId: live?.group.id ?? null
  }))
  // Adjusted in the render that sees the change (React's pattern for state derived from a
  // prop), so the strip never draws a frame in the wrong phase and never unmounts between two.
  let next = presence
  if (live) {
    const phase: GroupStripPhase =
      presence.phase === 'absent'
        ? 'entering'
        : presence.phase === 'leaving'
          ? 'shown'
          : presence.phase
    if (phase !== presence.phase || presence.groupId !== live.group.id)
      next = { phase, groupId: live.group.id }
  } else if (presence.phase === 'entering' || presence.phase === 'shown') {
    next = { phase: 'leaving', groupId: presence.groupId }
  }
  // A group that is gone has nothing to slide out: the strip simply goes.
  const model = live ?? (next.phase === 'leaving' ? leavingStripFor(state, next.groupId) : null)
  if (next.phase === 'leaving' && !model) next = { phase: 'absent', groupId: null }
  if (next !== presence) setPresence(next)
  const { phase } = next

  const onEntered = useCallback(
    () => setPresence((p) => (p.phase === 'entering' ? { ...p, phase: 'shown' } : p)),
    []
  )
  const onLeft = useCallback(
    () => setPresence((p) => (p.phase === 'leaving' ? { phase: 'absent', groupId: null } : p)),
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

  if (phase === 'absent' || !model) return null
  return { model, phase, onEntered, onLeft }
}
