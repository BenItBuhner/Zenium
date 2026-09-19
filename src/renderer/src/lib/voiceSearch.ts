/**
 * Voice search (OMN-19) as the chrome runs it: a mic button starts a session, the listening
 * sheet (`components/voice/VoiceSearchSheet.tsx`) shows it, the host's recogniser reports through
 * `voice.event`, and the final transcript goes where typed text goes – `urlbar.submit`, which
 * navigates to an address and searches everything else through the default engine. The state
 * machine itself is `shared/voice.ts`; this module owns the one live session and its side
 * effects (the sheet, the toasts, the submit).
 */
import type { VoiceEvent, VoiceSession, VoiceStartOutcome } from '@shared/voice'
import {
  newVoiceSession,
  reduceVoice,
  voiceErrorMessage,
  voiceStartMessage
} from '@shared/voice'
import { cmd, run } from './api'
import { createStore } from './store'
import { closeVoiceSheet, openVoiceSheet, pushToast, type VoicePrompt } from './ui'

export interface VoiceSearchState {
  /** The live session the sheet draws; null while no sheet is up. */
  session: VoiceSession | null
}

export const voiceStore = createStore<VoiceSearchState>({ session: null }, 'voice')

/** What the module calls out to; the tests hand in their own. */
export interface VoiceSearchIo {
  start(): Promise<VoiceStartOutcome>
  cancel(): void
  openSettings(): void
  submit(input: string, prompt: VoicePrompt): void
  toast(message: string, kind: 'info' | 'error', action?: { label: string; onPick: () => void }): void
  openSheet(prompt: VoicePrompt): Promise<void>
  closeSheet(id: number): void
}

const DEFAULT_IO: VoiceSearchIo = {
  start: () => cmd('voice.start', undefined),
  cancel: () => run('voice.cancel', undefined),
  openSettings: () => run('voice.openSettings', undefined),
  submit: (input, prompt) =>
    run('urlbar.submit', { input, newTab: prompt.newTab, tabId: prompt.tabId }),
  toast: (message, kind, action) => pushToast(message, kind, action ? { action } : {}),
  openSheet: openVoiceSheet,
  closeSheet: closeVoiceSheet
}

let io: VoiceSearchIo = DEFAULT_IO
let seq = 0
/** The prompt whose session is live (or about to be); null between sessions. */
let current: VoicePrompt | null = null

/** Tests: route the side effects elsewhere; the return value puts them back. */
export function setVoiceSearchIo(next: VoiceSearchIo): () => void {
  io = next
  return () => {
    io = DEFAULT_IO
  }
}

/** The prompt of the live session, for the sheet and the tests. */
export function currentVoicePrompt(): VoicePrompt | null {
  return current
}

/**
 * A mic button was tapped. The sheet goes up at once, in its `starting` phase, so the microphone
 * request (a system prompt, or nothing when it was granted before) reads as part of one motion;
 * a refusal or a missing recogniser takes it down again with a toast (§9.33), a permanent
 * refusal's toast carrying Open settings. `newTab` defaults to the omnibox's rule: no tab to
 * load in means a new one.
 */
export async function startVoiceSearch(target: {
  tabId: string | null
  newTab?: boolean
}): Promise<void> {
  if (current) io.cancel()
  const prompt: VoicePrompt = {
    id: ++seq,
    tabId: target.tabId,
    newTab: target.newTab ?? target.tabId === null
  }
  current = prompt
  voiceStore.set({ session: newVoiceSession() })
  await io.openSheet(prompt)
  await listen(prompt)
}

async function listen(prompt: VoicePrompt): Promise<void> {
  let outcome: VoiceStartOutcome
  try {
    outcome = await io.start()
  } catch {
    outcome = 'unavailable'
  }
  // Cancelled (or started over) while the microphone was being asked for: nothing to do.
  if (current?.id !== prompt.id) return
  if (outcome === 'listening') return
  end(prompt.id)
  const message = voiceStartMessage(outcome)
  if (!message) return
  io.toast(
    message,
    outcome === 'unavailable' ? 'error' : 'info',
    outcome === 'denied-permanently'
      ? { label: 'Open settings', onPick: () => io.openSettings() }
      : undefined
  )
}

/**
 * A report from the host's recogniser. The session moves on (`reduceVoice`); a result is
 * submitted, an error the user cannot answer is toasted, and both take the sheet down. A
 * no-match keeps the sheet up with Try again; an abort (the app went behind) just closes it.
 */
export function voiceEvent(event: VoiceEvent): void {
  const prompt = current
  const session = voiceStore.get().session
  if (!prompt || !session) return
  const next = reduceVoice(session, event)
  if (next === session) return
  voiceStore.set({ session: next })
  switch (next.phase) {
    case 'done':
      end(prompt.id)
      io.submit(next.transcript, prompt)
      return
    case 'failed':
      end(prompt.id)
      if (next.error) io.toast(voiceErrorMessage(next.error), 'error')
      return
    case 'cancelled':
      end(prompt.id)
      return
    default:
      return
  }
}

/** Cancel (the button, the sheet dragged or backed away): the recogniser stops, nothing loads. */
export function cancelVoiceSearch(): void {
  const prompt = current
  if (!prompt) return
  const session = voiceStore.get().session
  // A session already over (no-match) has nothing left to stop.
  if (session && session.phase !== 'no-match') io.cancel()
  end(prompt.id)
}

/** Try again after a no-match: the same sheet, a fresh session. */
export function retryVoiceSearch(): void {
  const prompt = current
  if (!prompt || voiceStore.get().session?.phase !== 'no-match') return
  voiceStore.set({ session: newVoiceSession() })
  void listen(prompt)
}

function end(id: number): void {
  if (current?.id !== id) return
  current = null
  voiceStore.set({ session: null })
  io.closeSheet(id)
}
