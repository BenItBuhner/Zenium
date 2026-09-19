import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Mic, MicOff } from 'lucide-react'
import type { VoiceSession } from '@shared/voice'
import { voiceHaloScale } from '@shared/voice'
import { useBackSurface } from '@renderer/lib/back'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { SheetPresence, useSheetLeave } from '@renderer/lib/motion/presence'
import { uiStore } from '@renderer/lib/ui'
import { cancelVoiceSearch, retryVoiceSearch, voiceStore } from '@renderer/lib/voiceSearch'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * Voice search's listening overlay (OMN-19): a prompt sheet on the chassis (design language v2
 * draft §9.23) that goes up as the mic is tapped and stays while the device's recogniser
 * listens. The title block reads "Listening" with the mic glyph before it, a halo behind the
 * glyph pulsing with the sound level the recogniser reports (`onRmsChanged`, on the shared
 * spring); the transcript comes into the body as it is heard; Cancel is the one action. The
 * final transcript is submitted by `lib/voiceSearch.ts` the moment it arrives – the sheet does
 * not wait for a tap – and a recogniser that heard no words turns the sheet into "Didn't catch
 * that" with Try again. Errors the user cannot answer here are toasts (§9.33), not sheet states.
 *
 * Mounted once, above whichever shell is up. The leave outlives the request (`SheetPresence`,
 * §11.1): the store's `null` – a result submitted, an error toasted – runs the sheet down; a
 * new start meanwhile is a new sheet above it.
 */
export function VoiceSearchLayer(): JSX.Element | null {
  const prompt = uiStore.use((s) => s.voice)
  return <SheetPresence>{prompt ? <VoiceSheet key={prompt.id} /> : null}</SheetPresence>
}

function VoiceSheet(): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const session = voiceStore.use((s) => s.session)
  const leaving = useSheetLeave()?.leaving === true
  // The system back gesture pulls the sheet down like a drag; commit or the back button slides
  // it away, which is Cancel (`onDismissed`).
  useBackSurface({
    name: 'voice-search',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss(), leaving)

  const noMatch = session?.phase === 'no-match'
  const state: VoiceSheetState = noMatch ? 'no-match' : 'listening'
  return (
    <BottomSheet
      ref={sheet}
      onDismissed={cancelVoiceSearch}
      contentKey={state}
      handleLabel="Dismiss"
      labelledBy="zen-voice-title"
      // The chassis lays the footer out (§9.11): one button takes the width, two peers split it
      // with the primary trailing.
      footer={
        <>
          <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
            Cancel
          </button>
          {noMatch && (
            <button type="button" className="zen-v2-button" data-primary onClick={retryVoiceSearch}>
              Try again
            </button>
          )}
        </>
      }
    >
      <div data-testid="voice-sheet" data-voice-state={state} data-voice-phase={session?.phase}>
        <TitleBlock session={session} noMatch={noMatch} />
        {!noMatch && <Transcript session={session} />}
      </div>
    </BottomSheet>
  )
}

type VoiceSheetState = 'listening' | 'no-match'

/**
 * The title block (§9.23): the mic glyph with its level halo, "Listening" – or, after a no-match,
 * the mic struck through and "Didn't catch that" with a line on what to do.
 */
function TitleBlock({
  session,
  noMatch
}: {
  session: VoiceSession | null
  noMatch: boolean
}): JSX.Element {
  const live = session !== null && (session.phase === 'listening' || session.phase === 'heard')
  return (
    <div className="zen-sheet-title-block">
      <h2 id="zen-voice-title">
        <MicGlyph level={session?.level ?? 0} live={live} off={noMatch} />
        <span className="min-w-0 truncate">{noMatch ? "Didn't catch that" : 'Listening'}</span>
      </h2>
      {noMatch ? (
        <p>Speak again, a little closer to the microphone</p>
      ) : (
        <p>{session?.phase === 'finishing' ? 'Working out what you said' : 'Speak now'}</p>
      )}
    </div>
  )
}

/**
 * The mic at 20 px (§9.3) over a halo whose scale follows the level on the shared snappy spring:
 * each `rms` retargets the spring, so the halo swells and settles rather than stepping, and a
 * level that stops coming (the end of speech) lets it come to rest on the glyph.
 */
function MicGlyph({
  level,
  live,
  off
}: {
  level: number
  live: boolean
  off: boolean
}): JSX.Element {
  const halo = useRef<HTMLSpanElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  useEffect(() => {
    const el = halo.current
    if (!el) return
    const apply = (x: number): void => {
      el.style.transform = `scale(${x.toFixed(3)})`
    }
    const s = new SpringAnimation(SPRING_SNAPPY, apply, apply)
    s.start(voiceHaloScale(0), 0, voiceHaloScale(0))
    spring.current = s
    return () => {
      s.stop()
      spring.current = null
    }
  }, [])
  useEffect(() => {
    spring.current?.retarget(voiceHaloScale(live ? level : 0))
  }, [level, live])
  const Icon = off ? MicOff : Mic
  return (
    <span className="zen-voice-glyph" data-live={live} aria-hidden>
      <span ref={halo} className="zen-voice-halo" data-testid="voice-halo" />
      <Icon className="h-5 w-5" strokeWidth={1.75} />
    </span>
  )
}

/** The words as they come (body copy, §9.25's gutter), or where they will go until then. */
function Transcript({ session }: { session: VoiceSession | null }): JSX.Element {
  const text = session?.transcript ?? ''
  return (
    <p
      className="zen-voice-transcript"
      data-hint={text ? undefined : 'true'}
      data-testid="voice-transcript"
      aria-live="polite"
    >
      {text || 'Say a search or an address'}
    </p>
  )
}

/** Escape cancels (hardware keyboards exist on tablets and DeX); a sheet on its way out lets the key by. */
function useEscape(close: () => void, leaving: boolean): void {
  const latest = useRef({ close, leaving })
  useEffect(() => {
    latest.current = { close, leaving }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || latest.current.leaving) return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
