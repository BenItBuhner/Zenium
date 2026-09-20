/**
 * `chrome.privacy` without the engine: the browser settings it exposes (`types.ChromeSetting`
 * objects under `network`, `services` and `websites`), what `get` / `set` / `clear` accept, and
 * how the values several extensions set for one setting resolve to the value the browser
 * applies and the `levelOfControl` each extension sees. The host owns the values' persistence
 * and applies the ones Zenium can enforce; everything here is pure.
 *
 * Chrome's rules (`ExtensionPrefValueMap`): every extension holding `privacy` may set every
 * setting; when several did, the most recently installed enabled extension's value wins. A
 * `regular` value applies to normal and private windows alike unless a private-window value
 * exists; `regular_only` applies to normal windows only; `incognito_persistent` and
 * `incognito_session_only` apply to private windows only, the latter until the browser quits.
 * An extension's values reach private windows only when the user allowed it there, and the
 * private-window scopes need that too.
 */

export type PrivacyCategory = 'network' | 'services' | 'websites'

export type PrivacyScope =
  'regular' | 'regular_only' | 'incognito_persistent' | 'incognito_session_only'

export const PRIVACY_SCOPES: readonly PrivacyScope[] = [
  'regular',
  'regular_only',
  'incognito_persistent',
  'incognito_session_only'
]

export type LevelOfControl =
  | 'not_controllable'
  | 'controlled_by_other_extensions'
  | 'controllable_by_this_extension'
  | 'controlled_by_this_extension'

export type PrivacyValue = boolean | string

/** Chrome's `IPHandlingPolicy`, the values Electron's `setWebRTCIPHandlingPolicy` takes. */
export const WEB_RTC_IP_HANDLING_POLICIES = [
  'default',
  'default_public_and_private_interfaces',
  'default_public_interface_only',
  'disable_non_proxied_udp'
] as const

export type WebRtcIpHandlingPolicy = (typeof WEB_RTC_IP_HANDLING_POLICIES)[number]

export function isWebRtcIpHandlingPolicy(value: unknown): value is WebRtcIpHandlingPolicy {
  return (
    typeof value === 'string' && (WEB_RTC_IP_HANDLING_POLICIES as readonly string[]).includes(value)
  )
}

/**
 * What Zenium does with a setting's value: `webRtc` sets the pages' WebRTC IP handling policy,
 * `request` acts in the request pipeline (pings, the `Referer` and `DNT` headers), `stored`
 * only remembers and reports the value (Electron has no switch for the feature, or the feature
 * does not exist in Zenium).
 */
export type PrivacyEffect = 'webRtc' | 'request' | 'stored'

export interface PrivacySettingSpec {
  category: PrivacyCategory
  name: string
  /** The values `set` accepts. */
  kind: { type: 'boolean' } | { type: 'enum'; values: readonly string[] }
  /**
   * The browser's own value while no extension controls the setting. Chromium features Zenium
   * does not have (Safe Browsing, autofill, the Privacy Sandbox, Google's error pages, spelling
   * and translation services) report as off.
   */
  browserDefault: PrivacyValue
  effect: PrivacyEffect
}

const boolean = (
  category: PrivacyCategory,
  name: string,
  browserDefault: boolean,
  effect: PrivacyEffect = 'stored'
): PrivacySettingSpec => ({ category, name, kind: { type: 'boolean' }, browserDefault, effect })

/** Every setting `chrome.privacy` exposes. */
export const PRIVACY_SETTINGS: readonly PrivacySettingSpec[] = [
  boolean('network', 'networkPredictionEnabled', true),
  {
    category: 'network',
    name: 'webRTCIPHandlingPolicy',
    kind: { type: 'enum', values: WEB_RTC_IP_HANDLING_POLICIES },
    browserDefault: 'default',
    effect: 'webRtc'
  },
  boolean('services', 'alternateErrorPagesEnabled', false),
  boolean('services', 'autofillEnabled', false),
  boolean('services', 'autofillAddressEnabled', false),
  boolean('services', 'autofillCreditCardEnabled', false),
  boolean('services', 'passwordSavingEnabled', true),
  boolean('services', 'safeBrowsingEnabled', false),
  boolean('services', 'safeBrowsingExtendedReportingEnabled', false),
  boolean('services', 'searchSuggestEnabled', true),
  boolean('services', 'spellingServiceEnabled', false),
  boolean('services', 'translationServiceEnabled', false),
  boolean('websites', 'thirdPartyCookiesAllowed', true),
  boolean('websites', 'hyperlinkAuditingEnabled', true, 'request'),
  boolean('websites', 'referrersEnabled', true, 'request'),
  boolean('websites', 'doNotTrackEnabled', false, 'request'),
  boolean('websites', 'topicsEnabled', false),
  boolean('websites', 'fledgeEnabled', false),
  boolean('websites', 'adMeasurementEnabled', false),
  boolean('websites', 'relatedWebsiteSetsEnabled', false),
  boolean('websites', 'privacySandboxEnabled', false)
]

/** The setting names per category: the shape the shim builds `chrome.privacy` from. */
export const PRIVACY_SETTING_NAMES: Readonly<Record<PrivacyCategory, readonly string[]>> = {
  network: PRIVACY_SETTINGS.filter((s) => s.category === 'network').map((s) => s.name),
  services: PRIVACY_SETTINGS.filter((s) => s.category === 'services').map((s) => s.name),
  websites: PRIVACY_SETTINGS.filter((s) => s.category === 'websites').map((s) => s.name)
}

/** The shim's calls on a setting object, routed as `privacy.<method>(category, name, details)`. */
export const PRIVACY_METHODS = ['get', 'set', 'clear'] as const

export type PrivacyMethod = (typeof PRIVACY_METHODS)[number]

export const PRIVACY_PERMISSION_ERROR =
  "You do not have permission to access the preference. Be sure to declare the 'privacy' permission in your manifest."
export const INCOGNITO_ERROR = 'You do not have permission to access incognito preferences.'
export const INCOGNITO_SCOPE_ERROR =
  "You cannot set a preference with scope 'incognito_session_only' when no incognito window is open."

export function settingKey(category: string, name: string): string {
  return `${category}.${name}`
}

export function privacySetting(category: unknown, name: unknown): PrivacySettingSpec | undefined {
  if (typeof category !== 'string' || typeof name !== 'string') return undefined
  return PRIVACY_SETTINGS.find((s) => s.category === category && s.name === name)
}

export function isPrivacyScope(value: unknown): value is PrivacyScope {
  return typeof value === 'string' && (PRIVACY_SCOPES as readonly string[]).includes(value)
}

export function isIncognitoScope(scope: PrivacyScope): boolean {
  return scope === 'incognito_persistent' || scope === 'incognito_session_only'
}

/** Whether `value` is one the setting accepts. */
export function acceptsValue(spec: PrivacySettingSpec, value: unknown): value is PrivacyValue {
  if (spec.kind.type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && spec.kind.values.includes(value)
}

// ---------------------------------------------------------------------------
// Argument shapes
// ---------------------------------------------------------------------------

export interface GetDetails {
  incognito: boolean
}

export interface SetDetails {
  value: PrivacyValue
  scope: PrivacyScope
}

export interface ClearDetails {
  scope: PrivacyScope
}

function record(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid details.')
  return raw as Record<string, unknown>
}

function scopeOf(details: Record<string, unknown>): PrivacyScope {
  const scope = details.scope
  if (scope === undefined || scope === null) return 'regular'
  if (!isPrivacyScope(scope)) throw new Error(`Invalid scope '${String(scope)}'.`)
  return scope
}

export function normalizeGetDetails(raw: unknown): GetDetails {
  const details = record(raw)
  const incognito = details.incognito
  if (incognito !== undefined && incognito !== null && typeof incognito !== 'boolean') {
    throw new Error("Invalid value for 'incognito': expected boolean.")
  }
  return { incognito: incognito === true }
}

/**
 * The shape every `set` shares before the setting's own check of `value`: `value` is required,
 * `scope` optional and one of `PRIVACY_SCOPES` (`regular` when absent).
 */
export function normalizeSetScope(raw: unknown): { value: unknown; scope: PrivacyScope } {
  const details = record(raw)
  if (!('value' in details)) throw new Error("Missing required property 'value'.")
  return { value: details.value, scope: scopeOf(details) }
}

export function normalizeSetDetails(spec: PrivacySettingSpec, raw: unknown): SetDetails {
  const { value, scope } = normalizeSetScope(raw)
  if (!acceptsValue(spec, value)) {
    const expected =
      spec.kind.type === 'boolean' ? 'a boolean' : `one of ${spec.kind.values.join(', ')}`
    throw new Error(`Invalid value for '${spec.name}': expected ${expected}.`)
  }
  return { value, scope }
}

export function normalizeClearDetails(raw: unknown): ClearDetails {
  return { scope: scopeOf(record(raw)) }
}

// ---------------------------------------------------------------------------
// Values and precedence
// ---------------------------------------------------------------------------

/** What an extension set for one setting, per scope. */
export type ScopedValues = Partial<Record<PrivacyScope, PrivacyValue>>

/** The values every extension set for one setting, by extension id. */
export type SettingValues = ReadonlyMap<string, ScopedValues>

/**
 * Whose values apply and in which order: an extension's position in the install order, newest
 * first (a lower number wins), or undefined when its values do not count at all because it is
 * not enabled, or because `incognito` and the user has not allowed it in private windows.
 */
export type PrivacyRank = (extensionId: string, incognito: boolean) => number | undefined

/** The value the browser applies for normal or private windows, and the extension it came from. */
export interface EffectiveSetting {
  value: PrivacyValue
  /** Null when no extension controls the setting (the browser's own value applies). */
  controller: string | null
}

/** The answer to `get`, and the argument of `onChange`. */
export interface SettingResult {
  value: PrivacyValue
  levelOfControl: LevelOfControl
  /**
   * Only in answers about private windows: whether an extension set a private-window value
   * for the setting (Chrome's `HasIncognitoPrefValue`).
   */
  incognitoSpecific?: boolean
}

/** The value an extension's entry gives for normal or private windows, if any. */
export function valueFor(values: ScopedValues, incognito: boolean): PrivacyValue | undefined {
  if (incognito) {
    if (values.incognito_session_only !== undefined) return values.incognito_session_only
    if (values.incognito_persistent !== undefined) return values.incognito_persistent
    return values.regular
  }
  if (values.regular_only !== undefined) return values.regular_only
  return values.regular
}

/** Whether an entry holds a value for private windows specifically. */
export function hasIncognitoValue(values: ScopedValues): boolean {
  return values.incognito_persistent !== undefined || values.incognito_session_only !== undefined
}

/**
 * Who controls a setting for normal or private windows: among the extensions whose values
 * apply there, the highest ranked one that set a value applying there. Equal ranks (ids the
 * ranking does not order) settle by id.
 */
export function controllerOf(
  values: SettingValues,
  incognito: boolean,
  rank: PrivacyRank
): { extensionId: string; value: PrivacyValue } | undefined {
  let best: { extensionId: string; value: PrivacyValue; rank: number } | undefined
  for (const [extensionId, scoped] of values) {
    const value = valueFor(scoped, incognito)
    if (value === undefined) continue
    const r = rank(extensionId, incognito)
    if (r === undefined) continue
    if (!best || r < best.rank || (r === best.rank && extensionId < best.extensionId)) {
      best = { extensionId, value, rank: r }
    }
  }
  return best && { extensionId: best.extensionId, value: best.value }
}

/** The value the browser applies (normal or private windows) and who set it. */
export function effectiveSetting(
  values: SettingValues,
  browserValue: PrivacyValue,
  incognito: boolean,
  rank: PrivacyRank
): EffectiveSetting {
  const controller = controllerOf(values, incognito, rank)
  return controller
    ? { value: controller.value, controller: controller.extensionId }
    : { value: browserValue, controller: null }
}

export function sameEffective(a: EffectiveSetting, b: EffectiveSetting): boolean {
  return a.value === b.value && a.controller === b.controller
}

/** How much say an extension has over a setting another (or no) extension controls. */
export function levelOfControlFor(controller: string | null, extensionId: string): LevelOfControl {
  if (controller === null) return 'controllable_by_this_extension'
  return controller === extensionId
    ? 'controlled_by_this_extension'
    : 'controlled_by_other_extensions'
}

/** Whether any extension whose values apply to private windows set a private-window value. */
export function incognitoSpecific(values: SettingValues, rank: PrivacyRank): boolean {
  for (const [extensionId, scoped] of values) {
    if (hasIncognitoValue(scoped) && rank(extensionId, true) !== undefined) return true
  }
  return false
}

/**
 * The answer to `get` for one extension: the effective value and how much say the extension
 * has. `browserValue` is the browser's own value when no extension controls the setting.
 */
export function settingResult(
  values: SettingValues,
  browserValue: PrivacyValue,
  extensionId: string,
  incognito: boolean,
  rank: PrivacyRank
): SettingResult {
  const effective = effectiveSetting(values, browserValue, incognito, rank)
  const result: SettingResult = {
    value: effective.value,
    levelOfControl: levelOfControlFor(effective.controller, extensionId)
  }
  if (incognito) result.incognitoSpecific = incognitoSpecific(values, rank)
  return result
}

/** Set a scope's value, returning whether anything changed. */
export function withValue(values: ScopedValues, scope: PrivacyScope, value: PrivacyValue): boolean {
  if (values[scope] === value) return false
  values[scope] = value
  return true
}

/** Clear a scope's value, returning whether anything changed. */
export function withoutValue(values: ScopedValues, scope: PrivacyScope): boolean {
  if (values[scope] === undefined) return false
  delete values[scope]
  return true
}

/** Whether an entry still holds any value. */
export function hasValues(values: ScopedValues): boolean {
  return PRIVACY_SCOPES.some((scope) => values[scope] !== undefined)
}

/** The persisted part of an entry: session-only private-window values do not survive a restart. */
export function persistedValues(values: ScopedValues): ScopedValues {
  const out: ScopedValues = {}
  if (values.regular !== undefined) out.regular = values.regular
  if (values.regular_only !== undefined) out.regular_only = values.regular_only
  if (values.incognito_persistent !== undefined) {
    out.incognito_persistent = values.incognito_persistent
  }
  return out
}

/** Read an entry back from persistence, keeping only values the setting accepts. */
export function normalizeScopedValues(spec: PrivacySettingSpec, raw: unknown): ScopedValues {
  const out: ScopedValues = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const entry = raw as Record<string, unknown>
  for (const scope of PRIVACY_SCOPES) {
    if (scope === 'incognito_session_only') continue
    const value = entry[scope]
    if (acceptsValue(spec, value)) out[scope] = value
  }
  return out
}
