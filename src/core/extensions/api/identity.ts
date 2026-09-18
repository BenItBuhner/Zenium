/**
 * `chrome.identity`, the pure part: the redirect URL Chrome gives every extension
 * (`https://<id>.chromiumapp.org/<path>`), the checks on `launchWebAuthFlow`'s details and the
 * match that ends the flow once the provider sends the user back there.
 *
 * Only the web-auth flow is bridged. `getAuthToken` needs Chrome's Google account plumbing (the
 * signed-in profile and its OAuth client) and has nothing to stand on here; `getProfileUserInfo`
 * answers empty, the way Chrome does for a profile without a signed-in account.
 */

export interface WebAuthFlowDetails {
  url: string
  interactive: boolean
  abortOnLoadForNonInteractive: boolean
  timeoutMsForNonInteractive: number
}

export interface ProfileUserInfo {
  email: string
  id: string
}

export interface RedirectUrlDetails {
  path: string
}

export const ERROR_INVALID_DETAILS = 'Invalid details'
export const ERROR_INVALID_URL = 'Invalid URL'
export const ERROR_USER_CANCELLED = 'The user did not approve access.'
export const ERROR_INTERACTION_REQUIRED = 'User interaction required.'
export const ERROR_PAGE_LOAD_FAILED = 'Authorization page could not be loaded.'
export const ERROR_TIMEOUT = 'The flow timed out.'
export const ERROR_FLOW_IN_PROGRESS = 'A web auth flow is already running for this extension.'
export const ERROR_GET_AUTH_TOKEN =
  'identity.getAuthToken is not available in Zenium: there is no signed-in browser account. Use launchWebAuthFlow.'

/** Chrome's ceiling on `timeoutMsForNonInteractive`; the default is a minute. */
export const NON_INTERACTIVE_TIMEOUT_DEFAULT = 60_000
export const NON_INTERACTIVE_TIMEOUT_MAX = 60_000

export class IdentityError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The host every extension's redirects land on: `https://<id>.chromiumapp.org`. */
export function redirectOrigin(extensionId: string): string {
  return `https://${extensionId}.chromiumapp.org`
}

export function redirectUrl(extensionId: string, details: unknown): string {
  let path = ''
  if (typeof details === 'string') path = details
  else if (isRecord(details) && typeof details.path === 'string') path = details.path
  else if (details !== undefined && details !== null && !isRecord(details)) {
    throw new IdentityError(ERROR_INVALID_DETAILS)
  }
  return `${redirectOrigin(extensionId)}/${path.replace(/^\/+/, '')}`
}

export function normalizeWebAuthFlowDetails(raw: unknown): WebAuthFlowDetails {
  if (!isRecord(raw) || typeof raw.url !== 'string') throw new IdentityError(ERROR_INVALID_DETAILS)
  let url: URL
  try {
    url = new URL(raw.url)
  } catch {
    throw new IdentityError(ERROR_INVALID_URL)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new IdentityError(ERROR_INVALID_URL)
  }
  if (raw.interactive !== undefined && typeof raw.interactive !== 'boolean') {
    throw new IdentityError(ERROR_INVALID_DETAILS)
  }
  if (
    raw.abortOnLoadForNonInteractive !== undefined &&
    typeof raw.abortOnLoadForNonInteractive !== 'boolean'
  ) {
    throw new IdentityError(ERROR_INVALID_DETAILS)
  }
  let timeout = NON_INTERACTIVE_TIMEOUT_DEFAULT
  if (raw.timeoutMsForNonInteractive !== undefined) {
    const t = raw.timeoutMsForNonInteractive
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      throw new IdentityError(ERROR_INVALID_DETAILS)
    }
    timeout = Math.min(t, NON_INTERACTIVE_TIMEOUT_MAX)
  }
  return {
    url: url.toString(),
    interactive: raw.interactive === true,
    abortOnLoadForNonInteractive: raw.abortOnLoadForNonInteractive !== false,
    timeoutMsForNonInteractive: timeout
  }
}

/**
 * Whether a navigation ends the flow: the provider sent the user back to the extension's
 * redirect origin. Chrome matches the origin, not the path (`getRedirectURL(path)` is a hint
 * for the provider); the whole URL, fragment included, is what the extension receives.
 */
export function isRedirectBack(extensionId: string, url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.host === `${extensionId}.chromiumapp.org`
  } catch {
    return false
  }
}

/** `getProfileUserInfo`: no signed-in account. */
export function emptyProfileUserInfo(): ProfileUserInfo {
  return { email: '', id: '' }
}
