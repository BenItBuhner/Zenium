/**
 * `chrome.debugger`, the pure part: Chrome's `Debuggee` shape and the checks its binding and
 * `DebuggerFunction` make before a DevTools session touches a tab (the protocol versions Chrome
 * speaks, the pages an extension may never attach to, the error strings extensions match on).
 *
 * The host module (`main/platform/extensionApi/debugger.ts`) runs the sessions over the engine's
 * per-page debugger.
 */

/** Chrome's `Debuggee`, plus the `sessionId` of a flattened child target (Chrome 125). */
export interface Debuggee {
  tabId?: number
  extensionId?: string
  targetId?: string
  sessionId?: string
}

/** Chrome's `TargetInfo`. */
export interface DebuggerTargetInfo {
  type: 'page' | 'background_page' | 'worker' | 'other'
  id: string
  tabId?: number
  extensionId?: string
  attached: boolean
  title: string
  url: string
  faviconUrl?: string
}

export type DetachReason = 'target_closed' | 'canceled_by_user'

export const DETACH_REASONS: readonly DetachReason[] = ['target_closed', 'canceled_by_user']

/** The protocol versions `DevToolsAgentHost::IsSupportedProtocolVersion` accepts. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['1.0', '1.1', '1.2', '1.3']

/** The target id `getTargets` reports for a tab, and `attach({ targetId })` accepts back. */
export function tabTargetId(tabId: number): string {
  return `tab-${tabId}`
}

/** The tab a `getTargets` id names, or null for an id of another shape. */
export function tabIdOfTarget(targetId: string): number | null {
  const match = /^tab-(\d+)$/.exec(targetId)
  return match ? Number(match[1]) : null
}

// Chrome's `debugger_api.cc` strings, verbatim where an extension could compare on them.
export const ERROR_NO_TAB = (tabId: number): string => `No tab with given id ${tabId}.`
export const ERROR_ALREADY_ATTACHED = (tabId: number): string =>
  `Another debugger is already attached to the tab with id: ${tabId}.`
export const ERROR_NOT_ATTACHED = (tabId: number): string =>
  `Debugger is not attached to the tab with id: ${tabId}.`
export const ERROR_PROTOCOL_VERSION = (version: string): string =>
  `Requested protocol version is not supported: ${version}.`
export const ERROR_INVALID_TARGET = 'Debuggee is not specified.'
export const ERROR_TARGET_NOT_FOUND = 'No target with given id.'
export const ERROR_RESTRICTED_CHROME_URL = 'Cannot access a chrome:// URL'
export const ERROR_RESTRICTED_EXTENSION_URL =
  'Cannot access a chrome-extension:// URL of different extension'
export const ERROR_CANNOT_ATTACH = 'Cannot attach to this target.'
export const ERROR_PERMISSION = "The 'debugger' permission is required."

/**
 * The `Debuggee` an extension passed, checked the way Chrome's binding checks it: an object with
 * exactly one of `tabId` (a non-negative integer), `extensionId` or `targetId` (strings), and an
 * optional `sessionId`. Throws a TypeError with Chrome's wording.
 */
export function normalizeDebuggee(raw: unknown): Debuggee {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError("Error at parameter 'target': Value must be an object.")
  }
  const source = raw as Record<string, unknown>
  const out: Debuggee = {}
  if (source.tabId !== undefined) {
    if (!Number.isInteger(source.tabId) || (source.tabId as number) < 0) {
      throw new TypeError(
        "Error at parameter 'target': Error at property 'tabId': Value must be a non-negative integer."
      )
    }
    out.tabId = source.tabId as number
  }
  for (const key of ['extensionId', 'targetId', 'sessionId'] as const) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'string') {
      throw new TypeError(
        `Error at parameter 'target': Error at property '${key}': Value must be a string.`
      )
    }
    out[key] = source[key] as string
  }
  const named = [out.tabId, out.extensionId, out.targetId].filter((v) => v !== undefined).length
  if (named !== 1) throw new Error(ERROR_INVALID_TARGET)
  return out
}

/**
 * Whether Chrome would let an extension attach to a page at `url`: never its chrome (`chrome://`,
 * `devtools://`; Zenium's `zen://` pages are that chrome), never another extension's pages, and
 * nothing that is not a web page or one of the extension's own pages. Returns the error, or
 * null when attaching is fine.
 */
export function attachRefusal(url: string, extensionId: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  switch (parsed.protocol) {
    case 'chrome:':
    case 'zen:':
    case 'devtools:':
    case 'zen-extension:':
      return ERROR_RESTRICTED_CHROME_URL
    case 'chrome-extension:':
      return parsed.hostname === extensionId ? null : ERROR_RESTRICTED_EXTENSION_URL
    case 'http:':
    case 'https:':
    case 'file:':
    case 'about:':
    case 'data:':
    case 'blob:':
    case 'ftp:':
      return null
    default:
      return ERROR_CANNOT_ATTACH
  }
}

/** Chrome's `requiredVersion` check. */
export function protocolVersionRefusal(version: string): string | null {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version) ? null : ERROR_PROTOCOL_VERSION(version)
}

/**
 * The `runtime.lastError` Chrome sets when a command fails: the protocol's error object as JSON
 * (`{"code":-32601,"message":"..."}`), which client libraries parse. The engine hands back only
 * the message, so the code is the protocol's generic server error.
 */
export function commandErrorMessage(message: string, code = -32000): string {
  return JSON.stringify({ code, message })
}
