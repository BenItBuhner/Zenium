/**
 * `chrome.privacy`, the pure part: the settings Chrome exposes as `types.ChromeSetting`s under
 * `privacy.network`, `privacy.services` and `privacy.websites`, and their current values read off
 * what Zenium has. Every setting answers `get` with its value and `not_controllable`: Zenium does
 * not let extensions change browser settings (`set` and `clear` say so), and the values that have
 * no Zenium counterpart (Google's services, the Privacy Sandbox) report as off.
 */

export type PrivacySection = 'network' | 'services' | 'websites'

export const PRIVACY_SETTINGS: Record<PrivacySection, readonly string[]> = {
  network: ['networkPredictionEnabled', 'webRTCIPHandlingPolicy'],
  services: [
    'alternateErrorPagesEnabled',
    'autofillEnabled',
    'autofillAddressEnabled',
    'autofillCreditCardEnabled',
    'passwordSavingEnabled',
    'safeBrowsingEnabled',
    'safeBrowsingExtendedReportingEnabled',
    'searchSuggestEnabled',
    'spellingServiceEnabled',
    'translationServiceEnabled'
  ],
  websites: [
    'thirdPartyCookiesAllowed',
    'topicsEnabled',
    'fledgeEnabled',
    'adMeasurementEnabled',
    'hyperlinkAuditingEnabled',
    'referrersEnabled',
    'doNotTrackEnabled',
    'protectedContentEnabled',
    'relatedWebsiteSetsEnabled'
  ]
}

export type LevelOfControl =
  | 'not_controllable'
  | 'controlled_by_other_extensions'
  | 'controllable_by_this_extension'
  | 'controlled_by_this_extension'

export interface ChromeSettingDetails {
  value: boolean | string
  levelOfControl: LevelOfControl
}

/** What the browser has that the settings read from. */
export interface PrivacySources {
  /** Settings → Search: live suggestions from the engine while typing. */
  searchSuggestions: boolean
  /** Settings → Passwords: offer to save logins. */
  offerToSavePasswords: boolean
}

export const ERROR_INVALID_SETTING = 'Invalid privacy setting'
export const ERROR_INVALID_DETAILS = 'Invalid details'
/**
 * Chrome's message when an extension without incognito access reads or writes an incognito
 * preference. Extensions never run in Zenium's private windows, so none has that access.
 */
export const ERROR_INCOGNITO_ACCESS = 'You do not have permission to access incognito preferences.'

export class PrivacyError extends Error {}

export function settingNotControllable(setting: string): string {
  return `Zenium does not let extensions change ${setting}.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `network.networkPredictionEnabled` → the pair, or a rejection for anything else. */
export function parseSetting(raw: unknown): { section: PrivacySection; name: string } {
  if (typeof raw !== 'string') throw new PrivacyError(ERROR_INVALID_SETTING)
  const dot = raw.indexOf('.')
  if (dot < 0) throw new PrivacyError(ERROR_INVALID_SETTING)
  const section = raw.slice(0, dot)
  const name = raw.slice(dot + 1)
  if (!isSection(section) || !PRIVACY_SETTINGS[section].includes(name)) {
    throw new PrivacyError(ERROR_INVALID_SETTING)
  }
  return { section, name }
}

function isSection(value: string): value is PrivacySection {
  return value === 'network' || value === 'services' || value === 'websites'
}

/** `get({ incognito? })`: the shape, and whether the incognito value was asked for. */
export function normalizeGetDetails(raw: unknown): { incognito: boolean } {
  if (raw === undefined || raw === null) return { incognito: false }
  if (!isRecord(raw)) throw new PrivacyError(ERROR_INVALID_DETAILS)
  if (raw.incognito !== undefined && typeof raw.incognito !== 'boolean') {
    throw new PrivacyError(ERROR_INVALID_DETAILS)
  }
  return { incognito: raw.incognito === true }
}

/** The value a setting has right now. */
export function settingValue(name: string, sources: PrivacySources): boolean | string {
  switch (name) {
    case 'webRTCIPHandlingPolicy':
      return 'default'
    case 'passwordSavingEnabled':
      return sources.offerToSavePasswords
    case 'searchSuggestEnabled':
      return sources.searchSuggestions
    // Chromium defaults Zenium leaves in place.
    case 'thirdPartyCookiesAllowed':
    case 'hyperlinkAuditingEnabled':
    case 'referrersEnabled':
      return true
    // Google's services, the Privacy Sandbox, autofill, DNT: nothing behind them here.
    default:
      return false
  }
}

export function settingDetails(name: string, sources: PrivacySources): ChromeSettingDetails {
  return { value: settingValue(name, sources), levelOfControl: 'not_controllable' }
}
