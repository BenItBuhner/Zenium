/**
 * The `chrome.webstorePrivate` vocabulary the Chrome Web Store and Edge Add-ons pages speak, and
 * the pure mappings a host needs to answer it: which pages get the API, what install status an
 * extension reports, and the `chrome.management.ExtensionInfo` shape the page reads installed
 * items in.
 *
 * Schema: extensions/common/api/webstore_private.json
 *   (revision 599148a4fd877e26351c56b567a4a325375bf493, 2026-07-23). Member semantics were
 *   cross-checked against electron-chrome-web-store 0.13.0 (MIT, Samuel Maddock), which drives
 *   the same page from Electron.
 * Edge's additions (`completeInstallWithCV`, `getPreferences`, the extra `getBrowserLogin`
 *   fields, `showFeedbackDialog`) have no public schema; their shapes were read off the Edge
 *   Add-ons page bundle (`build-cb307c21d8525bbdd1e7.js` and `Build-ExtensionInstallHelper-
 *   2fd1d7b83638e2c8f34f.js`, 2026-09-17), which also gates its install button on
 *   `navigator.userAgentData.brands` naming `Microsoft Edge`.
 */
import type { ExtensionRecord } from './registry'
import { isExtensionId, type StoreId } from './store'

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

export type WebstorePromotionType =
  'CHROME_ENTERPRISE_CORE' | 'CHROME_ENTERPRISE_PREMIUM' | 'PROMOTION_TYPE_UNSPECIFIED'

/**
 * The members of `chrome.webstorePrivate` the host answers; the page gets a function for each
 * and nothing else, so a member the schema adds later shows up as a missing function.
 * `completeInstallWithCV` and `getPreferences` are Edge's; the Edge Add-ons page prefers the
 * first over `completeInstall` when it exists.
 */
export const WEBSTORE_PRIVATE_MEMBERS = [
  'beginInstallWithManifest3',
  'completeInstall',
  'completeInstallWithCV',
  'install',
  'enableAppLauncher',
  'getBrowserLogin',
  'getStoreLogin',
  'setStoreLogin',
  'getPreferences',
  'getWebGLStatus',
  'getIsLauncherEnabled',
  'isInIncognitoMode',
  'isPendingCustodianApproval',
  'getReferrerChain',
  'getExtensionStatus',
  'getFullChromeVersion',
  'getMV2DeprecationStatus',
  'shouldShowEnterprisePromotionBanner',
  'logEnterprisePromoShown',
  'onEnterprisePromoClick'
] as const

export type WebstorePrivateMember = (typeof WEBSTORE_PRIVATE_MEMBERS)[number]

/**
 * Edge members the page probes (`if (chrome.webstorePrivate.x)`) and has a web fallback for, so
 * the host leaves them undefined on purpose and the page must not be warned about them:
 * `showFeedbackDialog` opens Edge's own feedback UI; without it the store's footer link opens the
 * page's feedback form instead, which is the useful outcome in a browser that has no such UI.
 */
export const WEBSTORE_PRIVATE_OPTIONAL_MEMBERS = ['showFeedbackDialog'] as const

/** The `chrome.management` members the store page uses to list and toggle installed items. */
export const MANAGEMENT_MEMBERS = ['getAll', 'get', 'setEnabled', 'uninstall'] as const

export type ManagementMember = (typeof MANAGEMENT_MEMBERS)[number]

/** `chrome.management` events the host forwards to the page. */
export type ManagementEvent = 'onInstalled' | 'onUninstalled' | 'onEnabled' | 'onDisabled'

/** IPC: the page's frame asks the host to run a member (`'webstorePrivate.<m>'` or `'management.<m>'`). */
export const WEBSTORE_CHANNEL = 'zen:webstore'
/** IPC: the host tells the page's frame about a `chrome.management` event. */
export const WEBSTORE_EVENT_CHANNEL = 'zen:webstore-event'

/**
 * What a member call comes back with. `error` becomes `chrome.runtime.lastError` while the
 * page's callback runs; `value` is passed to the callback (Chrome passes both for
 * `beginInstallWithManifest3`, whose result string doubles as the error code).
 */
export interface WebstoreReply {
  value?: unknown
  error?: string
}

/** Chrome's error text when `completeInstall` has no matching `beginInstallWithManifest3`. */
export const NO_PREVIOUS_BEGIN_INSTALL_ERROR =
  ' does not match a previous call to beginInstallWithManifest3'

export const USER_CANCELLED_ERROR = 'User cancelled install'

/**
 * An empty SafeBrowsing `ReferrerChain` message (field 2, one zero-valued entry), which is what
 * a profile without SafeBrowsing history yields; the page forwards it with the install request.
 */
export const EMPTY_REFERRER_CHAIN = 'EgIIAA=='

/** Requests the Chrome Web Store's servers answer, as URL patterns for a host's request filter. */
export const WEBSTORE_URL_PATTERNS = [
  'https://chromewebstore.google.com/*',
  'https://chrome.google.com/webstore/*'
]

/** Requests the Edge Add-ons store's servers answer (the store lives under `/addons` on that host). */
export const EDGE_ADD_ONS_URL_PATTERNS = ['https://microsoftedge.microsoft.com/*']

/** The brand the Chrome Web Store's server looks for in `Sec-CH-UA` before it renders its install button. */
export const CHROME_BRAND = 'Google Chrome'

/** The brand the Edge Add-ons page looks for in `navigator.userAgentData.brands` before it enables its button. */
export const EDGE_BRAND = 'Microsoft Edge'

/** The brand each store expects the browser to carry. */
export const STORE_BRANDS: Readonly<Record<StoreId, string>> = {
  'chrome-web-store': CHROME_BRAND,
  'edge-add-ons': EDGE_BRAND
}

/**
 * Adds a brand to a `Sec-CH-UA` or `Sec-CH-UA-Full-Version-List` value that lacks it, next to
 * the Chromium entry and with that entry's version (Chrome and Edge report their own brand with
 * the Chromium version) or `version` when there is no Chromium entry. The value is returned
 * unchanged when the brand is already there.
 */
export function withBrand(header: string, brand: string, version: string): string {
  const entries = [...header.matchAll(/"((?:[^"\\]|\\.)*)"\s*;\s*v\s*=\s*"([^"]*)"/g)].map(
    (match) => ({ brand: match[1], version: match[2] })
  )
  if (entries.some((entry) => entry.brand === brand)) return header
  const chromium = entries.findIndex((entry) => entry.brand === 'Chromium')
  const added = { brand, version: chromium >= 0 ? entries[chromium].version : version }
  entries.splice(chromium >= 0 ? chromium + 1 : entries.length, 0, added)
  return entries.map((entry) => `"${entry.brand}";v="${entry.version}"`).join(', ')
}

/**
 * {@link withBrand} for Chrome's brand. The Chrome Web Store renders "Switch to Chrome" instead
 * of the install button when the brand list of the page request names no Chrome, even with a
 * Chrome user-agent string; Electron's list only has Chromium and the GREASE entry.
 */
export function withChromeBrand(header: string, version: string): string {
  return withBrand(header, CHROME_BRAND, version)
}

/**
 * Request headers with `brand` in the client hints (`chromiumVersion` is
 * `process.versions.chrome`); a missing `sec-ch-ua` is written out in full so the low-entropy
 * hint always carries the brand. Header names keep their casing; other headers are untouched.
 */
export function withClientHintBrand(
  headers: Record<string, string>,
  brand: string,
  chromiumVersion: string
): Record<string, string> {
  const major = chromiumVersion.split('.')[0]
  const result: Record<string, string> = { ...headers }
  let sawBrands = false
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'sec-ch-ua') {
      sawBrands = true
      result[name] = withBrand(value, brand, major)
    } else if (lower === 'sec-ch-ua-full-version-list') {
      result[name] = withBrand(value, brand, chromiumVersion)
    }
  }
  if (!sawBrands)
    result['sec-ch-ua'] = withBrand(`"Chromium";v="${major}", "Not_A Brand";v="24"`, brand, major)
  return result
}

/** {@link withClientHintBrand} for Chrome's brand: what the Chrome Web Store's requests carry. */
export function withChromeClientHints(
  headers: Record<string, string>,
  chromiumVersion: string
): Record<string, string> {
  return withClientHintBrand(headers, CHROME_BRAND, chromiumVersion)
}

/** Edge's user-agent token; Edge's reduced UA carries the Chromium major with zeroed minors. */
const EDGE_TOKEN_RE = /\bEdg\/\d/

/**
 * The user-agent string Edge would send for the same Chromium build: Edge appends
 * `Edg/<major>.0.0.0` after `Safari/537.36`. A string that already carries an `Edg/` token is
 * returned as it is.
 */
export function withEdgeToken(userAgent: string, chromiumVersion: string): string {
  if (EDGE_TOKEN_RE.test(userAgent)) return userAgent
  return `${userAgent} Edg/${chromiumVersion.split('.')[0]}.0.0.0`
}

/**
 * Request headers as Edge would send them to its own store: the `User-Agent` gains Edge's token
 * (left alone when the request carries none, since a whole UA cannot be made up here) and the
 * client hints gain Edge's brand. Header names keep their casing; other headers are untouched.
 */
export function withEdgeIdentity(
  headers: Record<string, string>,
  chromiumVersion: string
): Record<string, string> {
  const result = withClientHintBrand(headers, EDGE_BRAND, chromiumVersion)
  for (const [name, value] of Object.entries(headers))
    if (name.toLowerCase() === 'user-agent') result[name] = withEdgeToken(value, chromiumVersion)
  return result
}

/**
 * The store whose page a URL is, if any: the Chrome Web Store on its two hosts (the legacy one
 * only on its webstore path) and Edge Add-ons on its host. These frames receive
 * `chrome.webstorePrivate`, over https only.
 */
export function storeForPage(url: string): StoreId | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname === 'chromewebstore.google.com') return 'chrome-web-store'
  if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
    return 'chrome-web-store'
  if (parsed.hostname === 'microsoftedge.microsoft.com') return 'edge-add-ons'
  return null
}

/** Whether a URL is a store page (see {@link storeForPage}). */
export function isWebstorePage(url: string): boolean {
  return storeForPage(url) !== null
}

/**
 * The store a frame belongs to: its own URL's store, or for the blank child frames a store page
 * creates (they inherit the parent's API in Chrome) the parent's. `parentUrl` is null for a top
 * frame or an unreadable cross-origin parent.
 */
export function storeForFrame(url: string, parentUrl: string | null): StoreId | null {
  const own = storeForPage(url)
  if (own) return own
  if (url !== 'about:blank' || parentUrl === null) return null
  return storeForPage(parentUrl)
}

/**
 * Edge's `getBrowserLogin` result: Chrome's `login` plus the Microsoft account fields
 * (`account_type` is `MSA` or `AAD`, `account_location` a market, `age_group_type` one of the
 * page's `AgeGroupType` enum). A browser with no Microsoft account reports them empty.
 */
export interface WebstoreBrowserLogin {
  login: string
  account_type: string
  account_location: string
  age_group_type:
    | 'Undefined'
    | 'MinorWithoutParentalConsent'
    | 'MinorWithParentalConsent'
    | 'Adult'
    | 'NotAdult'
    | 'MinorNoParentalConsentRequired'
}

export const SIGNED_OUT_BROWSER_LOGIN: WebstoreBrowserLogin = {
  login: '',
  account_type: '',
  account_location: '',
  age_group_type: 'Undefined'
}

/**
 * Edge's `getPreferences` result. `is_edge_feedback_enabled` decides whether the page shows its
 * footer's "Send feedback" link; `aadc_age_group` is the account's Age Appropriate Design Code
 * group (`Child` and `Minor` hide mature content), which is not applicable without an account.
 */
export interface WebstorePreferences {
  is_edge_feedback_enabled: boolean
  aadc_age_group: 'NotApplicable' | 'Child' | 'Minor' | 'Adult' | 'AgeUnknown'
}

export const DEFAULT_WEBSTORE_PREFERENCES: WebstorePreferences = {
  is_edge_feedback_enabled: true,
  aadc_age_group: 'NotApplicable'
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

/** How `beginInstallWithManifest3` ends: Chrome's result string, plus the `lastError` text on failure. */
export type WebstoreBeginInstallOutcome =
  { result: '' } | { result: Exclude<WebstoreResult, ''>; message: string }

/** Install status for the page: enabled/disabled when installed, installable otherwise. */
export function installStatusFor(
  installed: { enabled: boolean } | null | undefined
): WebstoreInstallStatus {
  if (!installed) return 'installable'
  return installed.enabled ? 'enabled' : 'disabled'
}

/** `chrome.management.ExtensionInfo`, as far as a registry record can fill it in. */
export interface ManagementExtensionInfo {
  id: string
  name: string
  shortName: string
  description: string
  version: string
  mayDisable: boolean
  mayEnable: boolean
  enabled: boolean
  disabledReason?: 'unknown' | 'permissions_increase'
  isApp: boolean
  type: 'extension' | 'theme'
  homepageUrl?: string
  updateUrl?: string
  offlineEnabled: boolean
  optionsUrl: string
  permissions: string[]
  hostPermissions: string[]
  installType: 'admin' | 'development' | 'normal' | 'sideload' | 'other'
  icons?: Array<{ size: number; url: string }>
}

export function managementInfoFor(
  record: ExtensionRecord,
  icons: Array<{ size: number; url: string }> = []
): ManagementExtensionInfo {
  const info: ManagementExtensionInfo = {
    id: record.id,
    name: record.name,
    shortName: record.name,
    description: record.description,
    version: record.version,
    mayDisable: true,
    mayEnable: true,
    enabled: record.enabled,
    isApp: false,
    type: 'extension',
    offlineEnabled: false,
    optionsUrl: record.optionsPage ? `chrome-extension://${record.id}/${record.optionsPage}` : '',
    permissions: record.permissions,
    hostPermissions: record.hostPermissions,
    installType:
      record.source === 'unpacked'
        ? 'development'
        : record.source === 'crx' || record.source === 'zip'
          ? 'sideload'
          : 'normal'
  }
  if (!record.enabled)
    info.disabledReason = record.pendingWarnings?.length ? 'permissions_increase' : 'unknown'
  if (record.updateUrl) info.updateUrl = record.updateUrl
  if (icons.length > 0) info.icons = icons
  return info
}
