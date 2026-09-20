import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import type { ReadAloudState, ReadAloudVoicesResult } from '@shared/readAloud'
import { cmd, run } from '@renderer/lib/api'
import { useBackDismissal } from '@renderer/lib/back'
import {
  errorText,
  formatProgress,
  describeRate,
  formatRate,
  nextRate,
  READ_ALOUD_RATE_SIZER,
  voiceRow
} from '@renderer/lib/readAloud'
import { uiStore } from '@renderer/lib/ui'
import { OptionsSheet } from '../pages/settings/sheets'
import { DockedPanelMotion } from './dockedMotion'

/** How long the Voice control waits for the host's list before the picker opens without it. */
const VOICES_WAIT_MS = 2500

/**
 * Read aloud's player (A11Y-06 / EDGE-11), docked under the live page the way the find bar and
 * the zoom sheet are (v2 §9.32: the one docked slot, one panel at a time, the frame shortening
 * through the layout reporter while the page stays live so the highlight the core paints in it
 * can be followed). Two rows – a bar header (§9.16, §9.23) with the text's title start-aligned
 * at 15/600 and the sentence progress trailing in tabular numerals, then the transport: previous
 * sentence, play / pause as one control whose glyph cross-fades (§11.4's in-place change), next
 * sentence, the speed chip (§9.34: the plain `.zen-v2-button` cycling `READ_ALOUD_RATE_STEPS`,
 * the value painted in `tabular-nums`, its `aria-label` the setting and the value as said –
 * "Speed, 1.2 times"), the voice picker (a §9.13 sheet of the host's voices) and close – as §9.3
 * icon buttons. Its shape follows its host (§9.32): the frame's radius on the top corners, a
 * second card under the frame on the phone. While the
 * engine prepares (`loading`) the play control is busy, not disabled (§9.30: the spinner in the
 * glyph's place, `aria-busy`). A page surface (§9.29): `data-surface="page"`, the page family,
 * no tooltips (§9.31). Predictive back and Escape close it like a page; closing is
 * `readAloud.stop` – the session ends, the highlight goes.
 *
 * It renders `UIState.readAloud` and drives the `readAloud.*` commands; the model behind them –
 * the text, the sentence walker, the voices per language, the media session that keeps it
 * playing behind other apps – is the core's (services'). The panel shows for the session's tab
 * while that tab is on screen; the session itself outlives the panel (a tab switch hides it,
 * the OS controls still carry it).
 */
export function ReadAloudPanel({ session }: { session: ReadAloudState }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const motion = useRef<DockedPanelMotion | null>(null)
  const [voices, setVoices] = useState<ReadAloudVoicesResult | null>(null)
  const [fetchingVoices, setFetchingVoices] = useState(false)
  const [pickingVoice, setPickingVoice] = useState(false)
  // Escape's handler is bound once and reads the picker's state through this.
  const picking = useRef(false)
  useEffect(() => {
    picking.current = pickingVoice
  }, [pickingVoice])

  // In on a spring from under the frame's edge and out the same way (MOT-35, v1 §7); with
  // motion reduced, a 120 ms fade in place both ways (§11.3). The back gesture slides it with the finger.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const m = new DockedPanelMotion(el)
    motion.current = m
    m.enter()
    return () => {
      m.dispose()
      motion.current = null
    }
  }, [])

  const stop = useCallback((): void => {
    run('readAloud.stop', undefined)
  }, [])
  const leave = useCallback((): void => {
    if (motion.current) motion.current.leave(stop)
    else stop()
  }, [stop])

  useBackDismissal('read-aloud', {
    render: (value) => {
      const el = ref.current
      if (!el) return
      el.style.transform = `translateY(${value * el.offsetHeight}px)`
      if (value > 0) el.dataset.moving = ''
      else delete el.dataset.moving
    },
    dismissed: stop,
    travel: 160
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const ui = uiStore.get()
      // Escape closes the topmost piece of chrome; those are handled by their own layers (the
      // voice picker's sheet takes its own Escape).
      if (ui.urlbar.open || ui.menu || ui.overlay !== 'none' || picking.current) return
      leave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leave])

  const loading = session.status === 'loading'
  const playing = session.status === 'playing'
  const failed = session.status === 'error'
  const first = session.sentenceIndex <= 0
  const last = session.sentenceCount > 0 && session.sentenceIndex >= session.sentenceCount - 1
  const progress = failed ? errorText(session.error) : formatProgress(session)

  // The picker's sheet takes its height from its rows when it opens (a chassis sheet's detent),
  // so the voices are fetched first – the Voice control busy meanwhile (§9.30) – and the sheet
  // opens on the list; a host slow to answer (the engine initialising) gets the sheet anyway
  // after a moment, saying the list is on its way.
  const openVoices = (): void => {
    if (fetchingVoices || pickingVoice) return
    setFetchingVoices(true)
    let opened = false
    const open = (result: ReadAloudVoicesResult | null): void => {
      if (opened) return
      opened = true
      window.clearTimeout(timer)
      setVoices(result)
      setFetchingVoices(false)
      setPickingVoice(true)
    }
    const timer = window.setTimeout(() => open(null), VOICES_WAIT_MS)
    void cmd('readAloud.voices', undefined)
      .then((result) => {
        setVoices(result)
        open(result)
      })
      .catch(() => open({ voices: [], byLanguage: {} }))
  }

  return (
    <div
      ref={ref}
      className="zen-read-aloud shrink-0 pb-2"
      role="region"
      aria-label="Read aloud"
      data-surface="page"
      data-status={session.status}
    >
      {/*
       * A bar header (§9.23): the title at the 16 gutter, the progress trailing at 16 (§9.16).
       * The counter is not a live region: it changes with every sentence, and announcing "5 / 25"
       * over the speech would talk over what a screen reader's user is listening to – the
       * highlight and the OS controls carry the progress. The error line is announced once, when
       * the counter gives way to it.
       */}
      <div className="zen-read-aloud-header flex items-center gap-3 px-4">
        <span className="zen-read-aloud-title min-w-0 flex-1 truncate">{session.title}</span>
        {progress && (
          <span
            className="zen-read-aloud-progress shrink-0"
            data-tone={failed ? 'danger' : undefined}
            aria-live={failed ? 'polite' : 'off'}
          >
            {progress}
          </span>
        )}
      </div>
      {/* The transport: icon buttons at 2 so their glyph boxes fall on the gutter's line; the chip hugs. */}
      <div className="zen-read-aloud-controls flex items-center px-0.5">
        <button
          type="button"
          className="zen-v2-icon-button"
          aria-label="Previous sentence"
          disabled={loading || failed || first}
          onClick={() => run('readAloud.previous', undefined)}
        >
          <SkipBack />
        </button>
        <button
          type="button"
          className="zen-v2-icon-button zen-read-aloud-toggle"
          aria-label={playing ? 'Pause' : 'Play'}
          aria-busy={loading || undefined}
          disabled={failed}
          data-playing={playing || undefined}
          onClick={() => {
            if (!loading) run('readAloud.toggle', undefined)
          }}
        >
          <Play className="zen-read-aloud-glyph-play" aria-hidden />
          <Pause className="zen-read-aloud-glyph-pause" aria-hidden />
          {loading && <span className="zen-v2-spinner" aria-hidden />}
        </button>
        <button
          type="button"
          className="zen-v2-icon-button"
          aria-label="Next sentence"
          disabled={loading || failed || last}
          onClick={() => run('readAloud.next', undefined)}
        >
          <SkipForward />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="zen-v2-button zen-read-aloud-chip shrink-0"
          aria-label={describeRate(session.rate)}
          onClick={() => run('readAloud.setRate', { rate: nextRate(session.rate) })}
        >
          {/* The widest label, unpainted, under the live one: one chip width across the ladder. */}
          <span className="zen-read-aloud-chip-sizer" aria-hidden="true">
            {READ_ALOUD_RATE_SIZER}
          </span>
          <span>{formatRate(session.rate)}</span>
        </button>
        <button
          type="button"
          className="zen-v2-icon-button zen-read-aloud-voice"
          aria-label="Voice"
          aria-haspopup="dialog"
          aria-expanded={pickingVoice}
          aria-busy={fetchingVoices || undefined}
          onClick={openVoices}
        >
          <AudioLines aria-hidden />
          {fetchingVoices && <span className="zen-v2-spinner" aria-hidden />}
        </button>
        <button type="button" className="zen-v2-icon-button" aria-label="Close" onClick={leave}>
          <X />
        </button>
      </div>
      {pickingVoice && (
        <OptionsSheet
          row={voiceRow(session, voices)}
          under={false}
          close={() => setPickingVoice(false)}
        />
      )}
    </div>
  )
}
