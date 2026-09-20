import type { HostEventPayloads } from './platform'

/*
 * A toast the host raises itself (`toast` host event, `Host.kt`): the file chooser's camera
 * refused (OS-22) – a message the core has no part in, so it does not go through
 * `Browser.toast` (which carries no action). It lands on the chrome's message cards (v2 §9.33)
 * like every other; a refusal for good gets Open settings, Android's details page for the app,
 * as the QR sheet's refusal does (#211's copy).
 */

export type HostToast = HostEventPayloads['toast']

export interface HostToastIo {
  toast(
    message: string,
    kind: 'info' | 'error',
    action?: { label: string; onPick: () => void }
  ): void
  /** Android's details page for Zenium (`app.openSettings`). */
  openSettings(): void
}

/** The action's label, the QR sheet's word for the same way on. */
export const OPEN_SETTINGS_LABEL = 'Open settings'

/** Show the host's toast; false for a payload without a message (nothing shown). */
export function showHostToast(payload: unknown, io: HostToastIo): boolean {
  const toast = payload as Partial<HostToast> | null | undefined
  if (!toast || typeof toast.message !== 'string' || toast.message === '') return false
  io.toast(
    toast.message,
    toast.kind === 'error' ? 'error' : 'info',
    toast.action === 'settings'
      ? { label: OPEN_SETTINGS_LABEL, onPick: () => io.openSettings() }
      : undefined
  )
  return true
}
