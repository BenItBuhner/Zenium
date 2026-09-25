import { useEffect, useState } from 'react'
import type { MediaState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { extrapolatePosition } from '@renderer/lib/media'

/** How often the position display moves on while the media plays. */
const TICK_MS = 250
/** The slider's resolution: a tenth of a second, so a scrub lands where the finger or pointer is. */
export const SCRUB_STEP_S = 0.1

/** The Radix slider's props the seek row spreads: the range, the thumb, and the two handlers. */
export interface MediaSeekSlider {
  min: number
  max: number
  step: number
  value: number[]
  onValueChange: (value: number[]) => void
  onValueCommit: (value: number[]) => void
}

/**
 * The state behind a seek row (MW-16: the phone's media sheet and the desktop's media hub draw
 * the same row): `shown`, where playback stands – the position carried forward from the page's
 * report while it plays (a clock ticks every quarter second while the media plays and nothing
 * scrubs; until the first tick a stale `now` shows the reported position itself, the
 * extrapolation never running backwards), the thumb while it is dragged, or a seek just sent,
 * held until the page's next report answers it; `seekTo` sends `seekto` clamped to the range;
 * and the slider's handlers: a change is the thumb under the finger or pointer, a commit the
 * seek. The commit carries the value last reported – where the pointer let go, or a key's step,
 * reported before it – which `ui/slider.tsx` sees to over Radix.
 */
export function useMediaSeek(media: MediaState): {
  duration: number
  shown: number
  seekTo: (at: number) => void
  slider: MediaSeekSlider
} {
  const duration = media.position?.duration ?? 0
  const [now, setNow] = useState(() => Date.now())
  /** The thumb under the finger or pointer (seconds), or null while it rests. */
  const [scrub, setScrub] = useState<number | null>(null)
  /** A seek sent, with the report it was sent against; shown until the page's report moves on. */
  const [pending, setPending] = useState<{ at: number; positionAt: number | undefined } | null>(
    null
  )

  useEffect(() => {
    if (!media.playing || scrub !== null) return
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [media.playing, scrub])

  const live = extrapolatePosition(media, now)
  // A seek stands on screen while the page has not answered it (a new report answers it).
  const held = pending && pending.positionAt === media.positionAt ? pending.at : null
  const shown = scrub ?? held ?? live

  const seekTo = (at: number): void => {
    const target = Math.min(duration, Math.max(0, at))
    setPending({ at: target, positionAt: media.positionAt })
    run('media.action', { tabId: media.tabId, action: 'seekto', seekTime: target })
  }

  return {
    duration,
    shown,
    seekTo,
    slider: {
      min: 0,
      max: duration,
      step: SCRUB_STEP_S,
      value: [Math.min(duration, shown)],
      onValueChange: ([at]) => {
        if (at !== undefined) setScrub(at)
      },
      onValueCommit: ([at]) => {
        setScrub(null)
        if (at !== undefined) seekTo(at)
      }
    }
  }
}
