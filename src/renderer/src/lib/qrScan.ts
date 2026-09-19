/**
 * QR scanning (OMN-22, NTP-03) as the chrome runs it: a camera button starts a session, the scan
 * sheet (`components/qr/QrScanSheet.tsx`) shows it with the host's preview laid over its slot,
 * the host's camera reports through `qr.event`, and the decoded payload goes where typed text
 * goes – `urlbar.submit`, which navigates to an address and searches everything else through
 * the default engine (`qrSubmitInput` decides what is submitted: the address as scanned, a
 * Wi-Fi payload's network name, a contact's name, the text). The state machine itself is
 * `shared/qrScan.ts`; this module owns the one live session and its side effects (the sheet,
 * the toasts, the haptic, the submit).
 */
import type { QrEvent, QrSession, QrStartOutcome } from '@shared/qrScan'
import {
  newQrSession,
  qrErrorMessage,
  qrStartMessage,
  qrSubmitInput,
  reduceQr
} from '@shared/qrScan'
import type { Rect } from '@shared/types'
import { cmd, run } from './api'
import { createStore } from './store'
import { closeQrSheet, openQrSheet, pushToast, type QrPrompt } from './ui'

export interface QrScanState {
  /** The live session the sheet draws; null while no sheet is up. */
  session: QrSession | null
}

export const qrStore = createStore<QrScanState>({ session: null }, 'qr')

/** What the module calls out to; the tests hand in their own. */
export interface QrScanIo {
  start(): Promise<QrStartOutcome>
  cancel(): void
  layout(slot: { rect: Rect; radius: number; visible: boolean }): void
  setTorch(on: boolean): void
  openSettings(): void
  submit(input: string, prompt: QrPrompt): void
  haptic(): void
  toast(
    message: string,
    kind: 'info' | 'error',
    action?: { label: string; onPick: () => void }
  ): void
  openSheet(prompt: QrPrompt): Promise<void>
  closeSheet(id: number): void
}

const DEFAULT_IO: QrScanIo = {
  start: () => cmd('qr.start', undefined),
  cancel: () => run('qr.cancel', undefined),
  layout: (slot) => run('qr.layout', slot),
  setTorch: (on) => run('qr.setTorch', { on }),
  openSettings: () => run('qr.openSettings', undefined),
  submit: (input, prompt) =>
    run('urlbar.submit', { input, newTab: prompt.newTab, tabId: prompt.tabId }),
  // The click of a decode: the same short confirm as the address bar docking.
  haptic: () => run('haptic', { kind: 'dock' }),
  toast: (message, kind, action) => pushToast(message, kind, action ? { action } : {}),
  openSheet: openQrSheet,
  closeSheet: closeQrSheet
}

let io: QrScanIo = DEFAULT_IO
let seq = 0
/** The prompt whose session is live (or about to be); null between sessions. */
let current: QrPrompt | null = null

/** Tests: route the side effects elsewhere; the return value puts them back. */
export function setQrScanIo(next: QrScanIo): () => void {
  io = next
  return () => {
    io = DEFAULT_IO
  }
}

/** The prompt of the live session, for the sheet and the tests. */
export function currentQrPrompt(): QrPrompt | null {
  return current
}

/**
 * A camera button was tapped. The sheet goes up at once, in its `starting` phase, so the camera
 * request (a system prompt, or nothing when it was granted before) reads as part of one motion;
 * a refusal or a missing camera takes it down again with a toast (§9.33), a permanent refusal's
 * toast carrying Open settings. `newTab` defaults to the omnibox's rule: no tab to load in means
 * a new one.
 */
export async function startQrScan(target: {
  tabId: string | null
  newTab?: boolean
}): Promise<void> {
  if (current) io.cancel()
  const prompt: QrPrompt = {
    id: ++seq,
    tabId: target.tabId,
    newTab: target.newTab ?? target.tabId === null
  }
  current = prompt
  qrStore.set({ session: newQrSession() })
  await io.openSheet(prompt)
  let outcome: QrStartOutcome
  try {
    outcome = await io.start()
  } catch {
    outcome = 'unavailable'
  }
  // Cancelled (or started over) while the camera was being asked for: nothing to do.
  if (current?.id !== prompt.id) return
  if (outcome === 'scanning') return
  end(prompt.id)
  const message = qrStartMessage(outcome)
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
 * A report from the host's camera. The session moves on (`reduceQr`); a decode is submitted
 * with a short haptic, an error is toasted, and both take the sheet down; an abort (the app went
 * behind) just closes it. A decode with nothing to submit keeps scanning.
 */
export function qrEvent(event: QrEvent): void {
  const prompt = current
  const session = qrStore.get().session
  if (!prompt || !session) return
  const next = reduceQr(session, event)
  if (next === session) return
  switch (next.phase) {
    case 'done': {
      const input = qrSubmitInput(next.text)
      if (!input) return
      qrStore.set({ session: next })
      io.haptic()
      // The host stops after one decode; the cancel releases the camera without waiting for the
      // sheet's leave (#187: no camera left open).
      io.cancel()
      end(prompt.id)
      io.submit(input, prompt)
      return
    }
    case 'failed':
      qrStore.set({ session: next })
      end(prompt.id)
      if (next.error) io.toast(qrErrorMessage(next.error), 'error')
      return
    case 'cancelled':
      qrStore.set({ session: next })
      end(prompt.id)
      return
    default:
      qrStore.set({ session: next })
      return
  }
}

/** Cancel (the button, the sheet dragged or backed away): the camera closes, nothing loads. */
export function cancelQrScan(): void {
  const prompt = current
  if (!prompt) return
  io.cancel()
  end(prompt.id)
}

/** The torch toggle: the host answers with a `torch` event once the camera has switched. */
export function toggleQrTorch(): void {
  const session = qrStore.get().session
  if (!current || !session || session.phase !== 'scanning' || !session.torch) return
  io.setTorch(!session.torchOn)
}

/**
 * The sheet's slot moved or settled: where the native preview goes and whether it shows there.
 * `visible: false` (the sheet in motion, or the slot off the screen) hides it, the slot showing
 * the last still until it comes back.
 */
export function layoutQrPreview(slot: { rect: Rect; radius: number; visible: boolean }): void {
  if (!current) return
  io.layout(slot)
}

/**
 * The session is over: nothing further reaches it and the sheet goes. Its terminal session stays
 * in the store for the sheet's leave (the window keeps the last still, the phase its state, as the
 * sheet falls); the next start replaces it.
 */
function end(id: number): void {
  if (current?.id !== id) return
  current = null
  io.closeSheet(id)
}
