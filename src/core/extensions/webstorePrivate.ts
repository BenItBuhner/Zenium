/**
 * The `chrome.webstorePrivate` vocabulary the Chrome Web Store page speaks, and the pure
 * mappings a host needs to answer it: which pages get the API, what install status an extension
 * reports, and how install failures translate into the store's result strings.
 *
 * Schema: extensions/common/api/webstore_private.json
 *   (revision 599148a4fd877e26351c56b567a4a325375bf493, 2026-07-23). Member semantics were
 *   cross-checked against electron-chrome-web-store 0.13.0 (MIT, Samuel Maddock), which drives
 *   the same page from Electron.
 */
import { InstallError } from './install'
import { StoreError, isExtensionId } from './store'

/** `Result`: what `beginInstallWithManifest3` resolves with (`''` is success: the page expects an empty string). */
export type WebstoreResult =
  | ''
  | 'success'
  | 'user_gesture_required'
  | 'unknown_error'
  | 'feature_disabled'
  | 'unsupported_extension_type'
  | 'missing_dependencies'
  | 'install_error'
  | 'user_cancelled'
  | 'invalid_id'
  | 'blacklisted'
  | 'blocked_by_policy'
  | 'install_in_progress'
  | 'launch_in_progress'
  | 'manifest_error'
  | 'icon_error'
  | 'invalid_icon_url'
  | 'already_installed'
  | 'blocked_for_child_account'

/** `ExtensionInstallStatus`: what `getExtensionStatus` reports for an id. */
export type WebstoreInstallStatus =
  | 'can_request'
  | 'request_pending'
  | 'blocked_by_policy'
  | 'installable'
  | 'enabled'
  | 'disabled'
  | 'terminated'
  | 'blacklisted'
  | 'custodian_approval_required'
  | 'custodian_approval_required_for_installation'
  | 'force_installed'
  | 'deprecated_manifest_version'
  | 'corrupted'

export type WebstoreMv2DeprecationStatus = 'inactive' | 'warning' | 'soft_disable' | 'hard_disable'

export type WebstoreWebGlStatus = 'webgl_allowed' | 'webgl_blocked'

/** Chrome's error text when `completeInstall` has no matching `beginInstallWithManifest3`. */
export const NO_PREVIOUS_BEGIN_INSTALL_ERROR =
  ' does not match a previous call to beginInstallWithManifest3'

export const USER_CANCELLED_ERROR = 'User cancelled install'

/**
 * An empty SafeBrowsing `ReferrerChain` message (field 2, one zero-valued entry), which is what
 * a profile without SafeBrowsing history yields; the page forwards it with the install request.
 */
export const EMPTY_REFERRER_CHAIN = 'EgIIAA=='

/** Origins whose frames receive `chrome.webstorePrivate`; the legacy host only on its webstore path. */
export function isWebstorePage(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.hostname === 'chromewebstore.google.com') return true
  return parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')
}

export interface BeginInstallDetails {
  id: string
  /** The manifest the page attached, parsed; null when it was not valid JSON. */
  manifest: Record<string, unknown> | null
  localizedName: string | null
  iconUrl: string | null
}

/** Validates the `details` argument of `beginInstallWithManifest3`; null when it is not usable. */
export function parseBeginInstallDetails(input: unknown): BeginInstallDetails | null {
  if (!input || typeof input !== 'object') return null
  const details = input as Record<string, unknown>
  if (typeof details.id !== 'string' || !isExtensionId(details.id)) return null
  let manifest: Record<string, unknown> | null = null
  if (typeof details.manifest === 'string') {
    try {
      const parsed: unknown = JSON.parse(details.manifest)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        manifest = parsed as Record<string, unknown>
    } catch {
      manifest = null
    }
  }
  return {
    id: details.id,
    manifest,
    localizedName: typeof details.localizedName === 'string' ? details.localizedName : null,
    iconUrl: typeof details.iconUrl === 'string' ? details.iconUrl : null
  }
}

/** Install status for the page: enabled/disabled when installed, installable otherwise. */
export function installStatusFor(
  installed: { enabled: boolean } | null | undefined
): WebstoreInstallStatus {
  if (!installed) return 'installable'
  return installed.enabled ? 'enabled' : 'disabled'
}

export interface WebstoreFailure {
  result: WebstoreResult
  message: string
}

/** Maps an install failure to the result string and `chrome.runtime.lastError` text the page gets. */
export function webstoreFailure(error: unknown): WebstoreFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof StoreError && error.code === 'bad-id')
    return { result: 'invalid_id', message }
  if (error instanceof InstallError) {
    const manifestError =
      error.code === 'manifest-missing' ||
      error.code === 'manifest-invalid' ||
      error.code === 'locale-missing'
    return { result: manifestError ? 'manifest_error' : 'install_error', message }
  }
  return { result: 'install_error', message }
}
