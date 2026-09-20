/**
 * Voice search (OMN-19): the model behind the mic buttons in the phone's omnibox, on the new tab
 * page's field and in the bar. The host (Android's `SpeechRecognizer` behind `Voice.kt`) does the
 * listening and reports through `voice.event`; this module owns what is pure about the feature –
 * the listening sheet's state machine, the levels the mic glyph pulses on, and what becomes of
 * the final transcript – so the chrome can be tested without a recogniser.
 */
import type { HostCapabilities } from './types'

/** What `voice.start` answers once the microphone has been asked for. */
export type VoiceStartOutcome =
  /** The recogniser is listening; `voice.event`s follow. */
  | 'listening'
  /** The microphone was refused this once; asking again brings the system prompt back. */
  | 'denied'
  /** Refused for good (twice, or "Don't ask again"): only the app's settings screen turns it on. */
  | 'denied-permanently'
  /** No recogniser on the device, or it would not start. */
  | 'unavailable'

/** Why the recogniser gave up: `SpeechRecognizer`'s error codes by name (`VoiceLogic.kt`). */
export type VoiceError =
  | 'no-match'
  | 'speech-timeout'
  | 'network'
  | 'busy'
  | 'audio'
  | 'client'
  | 'server'
  | 'permissions'
  | 'language'
  | 'unknown'

/** What the host's recogniser reports while a session runs (`voice.event`). */
export type VoiceEvent =
  | { kind: 'ready' }
  | { kind: 'begin' }
  /** The sound level, 0 (silence) to 1, from `onRmsChanged`. */
  | { kind: 'rms'; level: number }
  | { kind: 'partial'; text: string }
  /** The user stopped speaking; the final result is being worked out. */
  | { kind: 'end' }
  | { kind: 'result'; text: string }
  | { kind: 'error'; error: VoiceError }
  /** The host ended the session without a result (the app went to the background): nothing to say. */
  | { kind: 'aborted' }

/**
 * The listening sheet's phases. `starting` is the wait for the microphone (the permission
 * prompt may be up); `listening` and `heard` are the sheet's live states, the second with a
 * partial transcript as its body; `finishing` runs from the end of speech to the result;
 * `done`, `no-match`, `failed` and `cancelled` are terminal – the surface submits, offers Try
 * again, toasts the error and goes, or just goes.
 */
export type VoicePhase =
  'starting' | 'listening' | 'heard' | 'finishing' | 'done' | 'no-match' | 'failed' | 'cancelled'

export interface VoiceSession {
  phase: VoicePhase
  /** The partial transcript while listening, the final one once `done`. */
  transcript: string
  /** The latest sound level, 0..1 (0 while nothing is being heard). */
  level: number
  /** Why the session `failed`; null otherwise. */
  error: VoiceError | null
}

export function newVoiceSession(): VoiceSession {
  return { phase: 'starting', transcript: '', level: 0, error: null }
}

const TERMINAL: ReadonlySet<VoicePhase> = new Set(['done', 'no-match', 'failed', 'cancelled'])

/** A session that has reached its end: the surface acts on it and nothing changes it further. */
export function voiceSessionOver(session: VoiceSession): boolean {
  return TERMINAL.has(session.phase)
}

/** A recogniser error the user can answer with Try again rather than one to report. */
export function isNoMatch(error: VoiceError): boolean {
  return error === 'no-match' || error === 'speech-timeout'
}

/**
 * The sheet's state machine: one recogniser event applied to the session. Events after the
 * session is over are ignored (a late `rms` after the result, an error after a cancel). A partial
 * with no words keeps the last one heard; a result with no words is a no-match, not an empty
 * search.
 */
export function reduceVoice(session: VoiceSession, event: VoiceEvent): VoiceSession {
  if (voiceSessionOver(session)) return session
  switch (event.kind) {
    case 'ready':
    case 'begin':
      return session.phase === 'starting' ? { ...session, phase: 'listening' } : session
    case 'rms':
      if (session.phase === 'finishing') return session
      return { ...session, level: clampLevel(event.level) }
    case 'partial': {
      const text = voiceInput(event.text)
      if (!text) return session.phase === 'starting' ? { ...session, phase: 'listening' } : session
      return { ...session, phase: 'heard', transcript: text }
    }
    case 'end':
      return { ...session, phase: 'finishing', level: 0 }
    case 'result': {
      const text = voiceInput(event.text)
      if (!text) return { ...session, phase: 'no-match', level: 0 }
      return { ...session, phase: 'done', transcript: text, level: 0 }
    }
    case 'error':
      if (isNoMatch(event.error)) return { ...session, phase: 'no-match', level: 0 }
      return { ...session, phase: 'failed', error: event.error, level: 0 }
    case 'aborted':
      return { ...session, phase: 'cancelled', level: 0 }
  }
}

function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
}

/**
 * The mic glyph's halo, by its diameter in px: at rest it is the glyph's own 20 px – and unseen
 * (`voiceHaloOpacity`), so silence shows a plain glyph with no fill box behind it (§9.23) – and at
 * full level a 36 px disc, 8 px past the glyph on every side, as much as the title block has room
 * for: the 16 px padding above and to the left, the 12 px the sheet keeps between the glyph and
 * the title, the 4 px to the description below. The spring runs on the diameter, in px, because
 * that is the unit the shared spring's rest window is tuned for (Δ .4 px, 8 px/s, §11): in scale
 * units the same window is half the halo's whole range and the spring would snap within a few
 * frames rather than swell. The transform and the opacity are derived from the diameter per frame.
 */
export const VOICE_HALO_REST = 20
export const VOICE_HALO_FULL = 36

/** The diameter the halo heads for at a level, 0 (silence) to 1. */
export function voiceHaloDiameter(level: number): number {
  return VOICE_HALO_REST + (VOICE_HALO_FULL - VOICE_HALO_REST) * clampLevel(level)
}

/** The `scale()` that draws a diameter: the halo's box is the glyph's 20 px. */
export function voiceHaloScale(diameter: number): number {
  return diameter / VOICE_HALO_REST
}

/** How much of the halo shows at a diameter: none at rest, the whole disc at full level. */
export function voiceHaloOpacity(diameter: number): number {
  return clampLevel((diameter - VOICE_HALO_REST) / (VOICE_HALO_FULL - VOICE_HALO_REST))
}

/**
 * A transcript as the address bar would take it: trimmed, one space between words. Where it then
 * goes is `urlbar.submit`'s decision, the same one typed text gets (`inputToUrl`, else the
 * default engine); voice search has no parser of its own.
 */
export function voiceInput(transcript: string): string {
  return transcript.replace(/\s+/g, ' ').trim()
}

/** The mic buttons show only where the host has a recogniser (`SpeechRecognizer.isRecognitionAvailable`). */
export function voiceSearchAvailable(capabilities: Pick<HostCapabilities, 'voiceSearch'>): boolean {
  return capabilities.voiceSearch
}

/** The message a refused or failed start leaves (§9.33 toast); null when the sheet says it. */
export function voiceStartMessage(outcome: VoiceStartOutcome): string | null {
  switch (outcome) {
    case 'listening':
      return null
    case 'denied':
      return 'Microphone access is needed to search by voice'
    case 'denied-permanently':
      return 'Microphone access is turned off for Zenium'
    case 'unavailable':
      return 'Voice search is not available on this device'
  }
}

/** The toast for an error the sheet cannot answer with Try again. */
export function voiceErrorMessage(error: VoiceError): string {
  switch (error) {
    case 'network':
      return 'Voice search needs an internet connection'
    case 'busy':
      return 'The microphone is in use by another app'
    case 'permissions':
      return 'Microphone access is needed to search by voice'
    case 'language':
      return 'Voice search does not support this language'
    default:
      return 'Voice search did not work. Try again'
  }
}
