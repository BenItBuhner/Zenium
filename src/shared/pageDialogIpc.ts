/**
 * The IPC contract between a page's preload (`src/preload/pageDialogs.ts`) and Electron's main
 * process for the dialogs pages open and the "Leave site?" flow. Shared so neither side imports
 * the other.
 */

/** The renderer → main channel `alert` / `confirm` / `prompt` ask on (synchronously). */
export const PAGE_DIALOG_CHANNEL = 'zen:page-dialog'
/** Main → page: the user chose to leave; replay the navigation the page had started. */
export const LEAVE_SITE_CHANNEL = 'zen:leave-site'

export type PageDialogCallKind = 'alert' | 'confirm' | 'prompt'

/** What a page's dialog call sends. */
export interface PageDialogCall {
  kind: PageDialogCallKind
  message: string
  defaultValue: string
}

/** What comes back once the user answered (or the dialog was dismissed for the page). */
export interface PageDialogAnswer {
  accepted: boolean
  value: string | null
}

export const DISMISSED_ANSWER: PageDialogAnswer = { accepted: false, value: null }

/** Longer messages are cut: Chrome caps its dialogs too, and the text travels with every state broadcast. */
export const MAX_DIALOG_TEXT = 10_000

const KINDS: ReadonlySet<string> = new Set<PageDialogCallKind>(['alert', 'confirm', 'prompt'])

/** Validate what arrived over IPC; null for anything a page (or a bug) sent that is not a call. */
export function sanitizeDialogCall(raw: unknown): PageDialogCall | null {
  if (!raw || typeof raw !== 'object') return null
  const call = raw as Partial<Record<keyof PageDialogCall, unknown>>
  if (typeof call.kind !== 'string' || !KINDS.has(call.kind)) return null
  return {
    kind: call.kind as PageDialogCallKind,
    message: clip(typeof call.message === 'string' ? call.message : ''),
    defaultValue: clip(typeof call.defaultValue === 'string' ? call.defaultValue : '')
  }
}

function clip(text: string): string {
  return text.length > MAX_DIALOG_TEXT ? text.slice(0, MAX_DIALOG_TEXT) : text
}
