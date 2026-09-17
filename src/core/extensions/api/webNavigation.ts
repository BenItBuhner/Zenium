/**
 * `chrome.webNavigation`, the host-neutral part: the event payload shapes, Chrome's transition
 * vocabulary and the best-effort derivation of a transition from what an embedding engine
 * reports about a navigation. The host attaches to its frames and fills these in.
 */

export type TransitionType =
  | 'link'
  | 'typed'
  | 'auto_bookmark'
  | 'auto_subframe'
  | 'manual_subframe'
  | 'generated'
  | 'start_page'
  | 'form_submit'
  | 'reload'
  | 'keyword'
  | 'keyword_generated'

export type TransitionQualifier =
  'client_redirect' | 'server_redirect' | 'forward_back' | 'from_address_bar'

export type FrameType = 'outermost_frame' | 'fenced_frame' | 'sub_frame'

export type DocumentLifecycle = 'prerender' | 'active' | 'cached' | 'pending_deletion'

/** The frame fields every navigation event and `getFrame` result share. */
export interface FrameDetails {
  tabId: number
  frameId: number
  parentFrameId: number
  processId: number
  url: string
  documentId: string
  parentDocumentId?: string
  frameType: FrameType
  documentLifecycle: DocumentLifecycle
}

export interface NavigationEventDetails extends FrameDetails {
  timeStamp: number
}

export interface CommittedDetails extends NavigationEventDetails {
  transitionType: TransitionType
  transitionQualifiers: TransitionQualifier[]
}

export interface ErrorDetails extends NavigationEventDetails {
  error: string
}

export interface CreatedNavigationTargetDetails {
  sourceTabId: number
  sourceProcessId: number
  sourceFrameId: number
  url: string
  tabId: number
  timeStamp: number
}

export interface TabReplacedDetails {
  replacedTabId: number
  tabId: number
  timeStamp: number
}

export interface GetFrameResult {
  errorOccurred: boolean
  url: string
  parentFrameId: number
  documentId: string
  parentDocumentId?: string
  frameType: FrameType
  documentLifecycle: DocumentLifecycle
}

export interface GetAllFramesEntry extends GetFrameResult {
  processId: number
  frameId: number
}

export const WEB_NAVIGATION_EVENTS = [
  'onBeforeNavigate',
  'onCommitted',
  'onDOMContentLoaded',
  'onCompleted',
  'onErrorOccurred',
  'onHistoryStateUpdated',
  'onReferenceFragmentUpdated',
  'onCreatedNavigationTarget',
  'onTabReplaced'
] as const

export type WebNavigationEvent = (typeof WEB_NAVIGATION_EVENTS)[number]

/** How the host started (or observed) a navigation; everything an engine can cheaply tell. */
export interface NavigationHint {
  isMainFrame: boolean
  /** The host's own reload action triggered it. */
  reload?: boolean
  /** The host's back / forward action triggered it. */
  history?: boolean
  /** The host loaded a URL the user typed (address bar). */
  typed?: boolean
  /** The engine reported a server redirect along the way. */
  serverRedirect?: boolean
  /** Renderer initiated (script, link click) rather than browser initiated. */
  rendererInitiated?: boolean
  /** A form submission (POST) navigation. */
  formSubmit?: boolean
}

/**
 * Chrome's `PageTransition` from an engine hint: reloads and history moves are reported as such,
 * sub-frame loads are `auto_subframe` (renderer started) or `manual_subframe` (user started),
 * typed URLs are `typed` with `from_address_bar`, everything else is `link`.
 */
export function transitionFor(hint: NavigationHint): {
  transitionType: TransitionType
  transitionQualifiers: TransitionQualifier[]
} {
  const qualifiers: TransitionQualifier[] = []
  if (hint.serverRedirect) qualifiers.push('server_redirect')
  if (hint.history) qualifiers.push('forward_back')
  let type: TransitionType
  if (hint.reload) type = 'reload'
  else if (!hint.isMainFrame)
    type = hint.rendererInitiated === false ? 'manual_subframe' : 'auto_subframe'
  else if (hint.formSubmit) type = 'form_submit'
  else if (hint.typed) {
    type = 'typed'
    qualifiers.push('from_address_bar')
  } else type = 'link'
  return { transitionType: type, transitionQualifiers: qualifiers }
}

/** Chrome's net error names for `onErrorOccurred.error` from Chromium's numeric codes. */
export function netErrorName(code: number, description: string): string {
  if (description) return description.startsWith('net::') ? description : `net::${description}`
  return `net::ERR_${code}`
}

/** Whether two URLs differ only in their fragment (a reference-fragment navigation). */
export function isFragmentNavigation(from: string, to: string): boolean {
  const strip = (url: string): string => url.split('#')[0]
  if (strip(from) !== strip(to)) return false
  return from !== to || to.includes('#')
}
