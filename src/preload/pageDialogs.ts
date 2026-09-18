import { contextBridge, ipcRenderer } from 'electron'
import type { PageMessage } from '../core/platform'
import {
  DISMISSED_ANSWER,
  LEAVE_SITE_CHANNEL,
  PAGE_DIALOG_CHANNEL,
  type PageDialogAnswer,
  type PageDialogCall,
  type PageDialogCallKind
} from '../shared/pageDialogIpc'

/** A recorded navigation the page started is replayed only this soon after; older ones are stale. */
const INTENT_TTL_MS = 30_000

type Bridge = (kind: PageDialogCallKind, message: string, defaultValue: string) => PageDialogAnswer

/**
 * `alert`, `confirm` and `prompt` for the page's main world. Electron's sandboxed renderer serves
 * `alert` and `confirm` with the engine's own message boxes (window-modal, native, unparented
 * for a `WebContentsView`) and replaces `prompt` with a function that throws. Zenium draws all
 * three in the chrome, tab-modal, the way Chrome does: the replacements call a bridge into this
 * isolated world, which asks the browser synchronously, so the page stays paused until the user
 * answers – exactly what the engine's dialogs do. Installed in every frame, like Chrome's.
 */
export function installPageDialogs(): void {
  const bridge: Bridge = (kind, message, defaultValue) => {
    try {
      const call: PageDialogCall = { kind, message, defaultValue }
      const answer = ipcRenderer.sendSync(PAGE_DIALOG_CHANNEL, call) as PageDialogAnswer | undefined
      return answer && typeof answer === 'object' ? answer : DISMISSED_ANSWER
    } catch {
      return DISMISSED_ANSWER
    }
  }
  try {
    contextBridge.executeInMainWorld({ func: defineDialogs, args: [bridge] })
  } catch (error) {
    console.warn('[zen] page dialogs unavailable:', (error as Error).message)
  }
}

/**
 * Runs in the page's main world (serialised, so it closes over nothing). The functions follow
 * the HTML conversions: an omitted message is '', `null` reads "null", a prompt's omitted default
 * is ''. Own data properties of `window`, as the natives are, so pages that replace them keep
 * working.
 */
function defineDialogs(bridge: Bridge): void {
  const define = (name: string, fn: (...args: unknown[]) => unknown): void => {
    Object.defineProperty(window, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: true
    })
  }
  const text = (value: unknown): string => (value === undefined ? '' : String(value))
  define('alert', function alert(message?: unknown): void {
    bridge('alert', text(message), '')
  })
  define('confirm', function confirm(message?: unknown): boolean {
    return Boolean(bridge('confirm', text(message), '').accepted)
  })
  define('prompt', function prompt(message?: unknown, defaultValue?: unknown): string | null {
    const answer = bridge('prompt', text(message), text(defaultValue))
    if (!answer.accepted) return null
    return typeof answer.value === 'string' ? answer.value : ''
  })
}

/** The parts of the Navigation API this module reads (not in the DOM typings yet). */
interface NavigationEntryLike {
  index: number
}
interface NavigateEventLike extends Event {
  navigationType: 'push' | 'replace' | 'reload' | 'traverse'
  destination: { url: string; index: number; sameDocument: boolean }
  downloadRequest: string | null
  formData: FormData | null
  sourceElement?: Element | null
}
interface NavigationLike extends EventTarget {
  currentEntry: NavigationEntryLike | null
}

interface RecordedIntent {
  at: number
  replay: () => void
}

/**
 * "Leave site?" for navigations the page starts itself. The engine answers a `beforeunload`
 * objection the moment it is raised (Electron's `will-prevent-unload` is synchronous), so the
 * browser keeps the page and asks the user afterwards – and then knows nothing about the link
 * click or `location` assignment it should carry out. The Navigation API's `navigate` event fires
 * before `beforeunload` for every navigation the page initiates; the last cross-document one is
 * remembered here, reported to the browser (for the dialog's wording) and replayed from this
 * world when the browser says the user chose to leave. The browser lets the second `beforeunload`
 * pass. Navigations the browser starts (address bar, back, reload) are its own to replay.
 */
export function installLeaveSite(send: (message: PageMessage) => void): void {
  const navigation = (window as Window & { navigation?: NavigationLike }).navigation
  if (!navigation) return
  let intent: RecordedIntent | null = null
  navigation.addEventListener('navigate', (event) => {
    const e = event as NavigateEventLike
    // Same-document navigations and downloads never unload the page.
    if (e.destination.sameDocument || e.downloadRequest !== null) return
    const replay = replayFor(e, navigation)
    if (!replay) return
    intent = { at: Date.now(), replay }
    send({
      type: 'navigate-intent',
      intent: {
        url: e.destination.url,
        navigationType: e.navigationType,
        post: e.formData !== null
      }
    })
  })
  ipcRenderer.on(LEAVE_SITE_CHANNEL, () => {
    const recorded = intent
    intent = null
    if (recorded && Date.now() - recorded.at < INTENT_TTL_MS) recorded.replay()
  })
}

/**
 * How to start `e`'s navigation again. A form submission is submitted again (its body cannot be
 * rebuilt from here); a traversal moves by the same number of entries; anything else loads the
 * destination, replacing the entry when the original would have. Null when it cannot be redone
 * (a traversal to an entry of another site, which the API does not index).
 */
function replayFor(e: NavigateEventLike, navigation: NavigationLike): (() => void) | null {
  const url = e.destination.url
  switch (e.navigationType) {
    case 'reload':
      return () => location.reload()
    case 'traverse': {
      const from = navigation.currentEntry?.index ?? -1
      const to = e.destination.index
      if (from < 0 || to < 0 || from === to) return null
      return () => history.go(to - from)
    }
    case 'push':
    case 'replace': {
      if (e.formData !== null) {
        const submit = formSubmission(e.sourceElement ?? null)
        return submit ? () => submit.form.requestSubmit(submit.submitter) : null
      }
      return e.navigationType === 'replace'
        ? () => location.replace(url)
        : () => location.assign(url)
    }
  }
}

/** The form (and the button that submitted it, if one did) behind a submission's source element. */
function formSubmission(
  source: Element | null
): { form: HTMLFormElement; submitter: HTMLElement | undefined } | null {
  if (source instanceof HTMLFormElement) return { form: source, submitter: undefined }
  if ((source instanceof HTMLButtonElement || source instanceof HTMLInputElement) && source.form) {
    // `requestSubmit` accepts only a submit button as the submitter.
    const submits = source.type === 'submit' || source.type === 'image'
    return { form: source.form, submitter: submits ? source : undefined }
  }
  return null
}
