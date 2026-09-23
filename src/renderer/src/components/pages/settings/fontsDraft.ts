import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FONT_FAMILY_SLOTS, type PageFontSettings } from '@shared/fonts'
import type { Settings } from '@shared/types'

/**
 * The Customise fonts group's draft (CT-25): the document its rows and its preview show, and
 * the one place a change to `Settings.fonts` leaves the page from.
 *
 * The Android performance gate's ruling on ± rows (the #350 final run): a sequence of presses
 * on a step button is ONE gesture scene with the gesture budget's three long tasks for the
 * whole of it, hold-repeat included, and the row meets that by coalescing – each press steps
 * the row's own value and the preview (a state update and a label, nothing else), and the
 * commit (`settings.update`, the core's broadcast, the host's `fonts.apply` and every open
 * page's restyle) runs once per quiet sequence, {@link FONTS_COMMIT_QUIET_MS} after the last
 * step or the hold's end, and at once when the row is left – its focus goes, its sheet closes,
 * the drill-in is left – so no step is lost. The draft is that: the committed fonts with the
 * steps not yet committed over them (`fonts`), a `step` that moves it and arms the timer, a
 * `hold` that keeps the timer from running while a step button is down (the hold's repeats
 * are steps 100 ms apart, but the first of them comes 400 ms after the press), a `commit` for
 * what applies at once (a menulist's pick, a family's, Reset), a `leave` for a row's blur (its
 * own step commits; another row's keeps its window) and a `flush` for the page's leaving.
 * What was committed stays shown until the settings come back changed, so the row never falls
 * back to the old value between the write and the core's broadcast.
 */
export interface FontsDraft {
  /** The committed fonts with the pending steps over them: what every row and the preview read. */
  fonts: PageFontSettings
  /** A ± press, or one of a hold's repeats: the draft moves now; the commit follows once the sequence is quiet. */
  step(change: Partial<PageFontSettings>): void
  /** A step button goes down (`true`) or is released (`false`): no commit while it is down; the quiet window starts at the release. */
  hold(held: boolean): void
  /** A pick or a reset: committed now, with whatever steps were pending. */
  commit(change: Partial<PageFontSettings>): void
  /**
   * The row for `key` loses focus: its own pending step is committed now. Another row's step
   * is not – a finger landing on the Minimum font size row's + takes the focus off the Font
   * size row's button it left on, and that blur is no end to the sequence just begun (#350's
   * run 8 committed the first of seven presses that way). What is pending commits with the
   * whole draft once the sequence is quiet, or at the page's leaving.
   */
  leave(key: keyof PageFontSettings): void
  /** The page is left (its sheet closes, the drill-in is left): commit whatever is pending. */
  flush(): void
}

/**
 * How long a step sequence is quiet before it commits, ms: the timer restarts on every step,
 * so the commit comes this long after the last press, or after the last of a hold's repeats
 * (the hold steps every 100 ms, so a hold commits once, at its end plus the window). The
 * window is longer than a gap between taps: a person tapping a button repeatedly lands about
 * 200 to 300 ms apart, and #350's run 8 on the emulator (35827411459) saw its seven injected
 * taps 146 to 285 ms apart – past the ruling's first "about 150 ms", which split that
 * sequence into four commits. 400 ms closes over both; a longer pause is a new sequence,
 * committed on its own. (A held button suspends the timer altogether – `hold` – so a hold's
 * 400 ms delay before it repeats never commits the first step early.)
 */
export const FONTS_COMMIT_QUIET_MS = 400

/**
 * A draft that commits every change at once: the two-pane layout's menulists, which have no
 * step to coalesce, a builder run with no page around it (a test, the landing's search built
 * without the phone's draft). `flush` has nothing to do.
 */
export function immediateFontsDraft(
  fonts: PageFontSettings,
  set: (patch: Partial<Settings>) => void
): FontsDraft {
  const commit = (change: Partial<PageFontSettings>): void =>
    set({ fonts: { ...fonts, ...change } })
  return {
    fonts,
    step: commit,
    hold: () => undefined,
    commit,
    leave: () => undefined,
    flush: () => undefined
  }
}

interface Pending {
  change: Partial<PageFontSettings>
  /** `set` has run with this change: shown until the settings come back changed. */
  sent: boolean
}

/** Field by field: the documents differ in key order between the core's and a spread here. */
function sameFonts(a: PageFontSettings, b: PageFontSettings): boolean {
  return (
    a.size === b.size &&
    a.minimumSize === b.minimumSize &&
    FONT_FAMILY_SLOTS.every((slot) => a[slot] === b[slot])
  )
}

/**
 * The page's draft over `committed` (the state's `settings.fonts`), writing through `set`. A
 * change of `leaveKey` (the section shown) flushes, as does the page's unmount: the drill-in's
 * leave commits what its rows had pending even if none of them got to say so.
 */
export function useFontsDraft(
  committed: PageFontSettings,
  set: (patch: Partial<Settings>) => void,
  leaveKey: string | null
): FontsDraft {
  const [pending, setPending] = useState<Pending | null>(null)
  // The handlers read and own the latest values: a step, a flush and the timer all run outside
  // the render, and two of them may run before React shows either. The mirror is written at
  // the commit (a layout effect: before any handler can run) and by the handlers themselves.
  const latest = useRef<{ committed: PageFontSettings; pending: Pending | null; set: typeof set }>({
    committed,
    pending: null,
    set
  })
  useLayoutEffect(() => {
    latest.current.committed = committed
    latest.current.set = set
  })
  useLayoutEffect(() => {
    latest.current.pending = pending
  }, [pending])
  // The settings moved under the draft (the core's broadcast of a commit, a sync merge, a
  // reset): a change already committed is done showing; steps not yet committed stay, to be
  // committed over the new document.
  const [seen, setSeen] = useState(committed)
  if (committed !== seen) {
    setSeen(committed)
    if (pending?.sent && !sameFonts(committed, seen)) setPending(null)
  }
  const mounted = useRef(true)
  const timer = useRef<number | null>(null)
  const clearTimer = useCallback((): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])
  const show = useCallback((next: Pending | null): void => {
    latest.current.pending = next
    if (mounted.current) setPending(next)
  }, [])
  /** Write `change` over the committed document; nothing when the result is what is committed. */
  const write = useCallback(
    (change: Partial<PageFontSettings>): void => {
      clearTimer()
      const { committed: base, set: emit } = latest.current
      const fonts = { ...base, ...change }
      if (sameFonts(fonts, base)) {
        show(null)
        return
      }
      show({ change, sent: true })
      emit({ fonts })
    },
    [clearTimer, show]
  )
  const flush = useCallback((): void => {
    clearTimer()
    const current = latest.current.pending
    if (current && !current.sent) write(current.change)
  }, [clearTimer, write])
  const leave = useCallback(
    (key: keyof PageFontSettings): void => {
      const current = latest.current.pending
      if (current && !current.sent && key in current.change) flush()
    },
    [flush]
  )
  // A step button is down: the sequence is not quiet until it is released.
  const held = useRef(false)
  /** The quiet window starts over – unless a button is down, when it starts at the release. */
  const arm = useCallback((): void => {
    clearTimer()
    if (!held.current) timer.current = window.setTimeout(flush, FONTS_COMMIT_QUIET_MS)
  }, [clearTimer, flush])
  const step = useCallback(
    (change: Partial<PageFontSettings>): void => {
      show({ change: { ...latest.current.pending?.change, ...change }, sent: false })
      arm()
    },
    [show, arm]
  )
  const hold = useCallback(
    (down: boolean): void => {
      held.current = down
      if (down) clearTimer()
      else if (latest.current.pending && !latest.current.pending.sent) arm()
    },
    [clearTimer, arm]
  )
  const commit = useCallback(
    (change: Partial<PageFontSettings>): void => {
      write({ ...latest.current.pending?.change, ...change })
    },
    [write]
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      flush()
    }
  }, [flush])
  useEffect(() => () => flush(), [leaveKey, flush])
  return {
    fonts: pending ? { ...committed, ...pending.change } : committed,
    step,
    hold,
    commit,
    leave,
    flush
  }
}
