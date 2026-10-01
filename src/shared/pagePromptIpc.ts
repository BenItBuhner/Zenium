/**
 * The IPC contract between a page's preload (`src/preload/pagePrompts.ts`) and Electron's main
 * process for the system UI a page asks for itself – `window.print()` and the File System Access
 * pickers – which an AI agent's tab keeps from the user (`TabViewEvents.onPagePrompt`). Shared so
 * neither side imports the other.
 */

/** The renderer → main channel the page's call asks on (synchronously). */
export const PAGE_PROMPT_CHANNEL = 'zen:page-prompt'

export type PagePromptCall =
  { kind: 'print' } | { kind: 'file-system-access'; picker: 'open' | 'save' | 'directory' }

/** `agent`: the tab's agent has it, show nothing; `user`: go on as the page would have. */
export type PagePromptAnswer = 'agent' | 'user'

const PICKERS: ReadonlySet<string> = new Set(['open', 'save', 'directory'])

/** Validate what arrived over IPC; null for anything a page (or a bug) sent that is not a call. */
export function sanitizePromptCall(raw: unknown): PagePromptCall | null {
  if (!raw || typeof raw !== 'object') return null
  const call = raw as Record<string, unknown>
  if (call.kind === 'print') return { kind: 'print' }
  if (
    call.kind === 'file-system-access' &&
    typeof call.picker === 'string' &&
    PICKERS.has(call.picker)
  )
    return { kind: 'file-system-access', picker: call.picker as 'open' | 'save' | 'directory' }
  return null
}
