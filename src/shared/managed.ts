/**
 * The managed browser (TB-13): Chrome for Android's "Managed browser" row at the foot of the app
 * menu and the chrome://management page it opens.
 *
 * Android lets a device or profile owner – a mobile-device-management agent, the policy
 * controller of a work profile – hand an app a managed configuration: a bundle of app
 * restrictions the app reads through `RestrictionsManager.getApplicationRestrictions()`. Chrome
 * turns that bundle into policies (`AppRestrictionsProvider` → `CombinedPolicyProvider` →
 * `PolicyConverter`, which keeps every key it does not know) and a non-empty bundle alone makes
 * the browser managed (`ManagementService::IsBrowserManaged` over `HasMachineLevelPolicies`):
 * the app menu then ends in "Managed browser" (`TabbedAppMenuPropertiesDelegate.
 * buildManagedByItem`, the `ic_domain` glyph) and chrome://management names the organisation
 * when it can and says what is managed.
 *
 * Zenium reads the bundle once, lazily, and shows the same row and page; it applies none of the
 * bundle's keys yet, and the page says so. Nothing here invents a policy: the status is the
 * bundle's own keys, and the organisation's name is the bundle's `EnterpriseCustomLabel` string
 * when the administrator set one (Chrome's key for the name chrome://management shows), else
 * the generic wording Chrome's `ManagedUi` falls back to.
 */

/** What a host reads from the app-restrictions bundle; `Commands['managed.status']`'s result. */
export interface ManagedStatus {
  /**
   * The organisation's display name, from the bundle's `EnterpriseCustomLabel` string, or
   * `null` when no restriction names one: the page then says "your organisation", as Chrome's
   * `GetManagementPageSubtitle` does without a manager.
   */
  by: string | null
  /**
   * The restriction keys the bundle carries – sorted, each once – the settings an administrator
   * configured; empty for an unmanaged browser. Values never cross the bridge: a bundle may
   * carry credentials, and the page lists what is configured, not what it is set to.
   */
  keys: string[]
}

/** The bundle key Chrome reads the organisation's display name from (policy `EnterpriseCustomLabel`). */
export const MANAGED_ORG_KEY = 'EnterpriseCustomLabel'

/** More keys than this and the rest are dropped: a managed configuration has dozens at most. */
export const MANAGED_KEYS_MAX = 512
/** A key longer than this names nothing an administrator typed: it is dropped. */
export const MANAGED_KEY_MAX = 200
/** A display name longer than this is cut, as the page's heading is one line of prose. */
export const MANAGED_BY_MAX = 120

/** A browser under no managed configuration: what every host without a bundle reports. */
export function unmanaged(): ManagedStatus {
  return { by: null, keys: [] }
}

/**
 * Chrome's rule (`ManagementService::IsBrowserManaged`): any restriction at all – Chrome keeps
 * the keys it does not know as policies – and the browser is managed. `null` is a status not yet
 * read, which shows nothing: the row and the page never precede the read.
 */
export function isManaged(status: ManagedStatus | null | undefined): status is ManagedStatus {
  return status != null && status.keys.length > 0
}

/**
 * The status a host's read becomes: the bridge's JSON checked field by field, the name trimmed
 * (an empty `EnterpriseCustomLabel` names nobody), the keys trimmed, deduplicated and sorted so
 * two reads of one bundle compare equal and the page's list has one order. Anything that is not
 * a status – a host that sent `null`, a malformed reply – is the unmanaged status: a doubtful
 * read never shows a row.
 */
export function managedStatusOf(value: unknown): ManagedStatus {
  if (typeof value !== 'object' || value === null) return unmanaged()
  const record = value as Record<string, unknown>
  const rawKeys = Array.isArray(record.keys) ? record.keys : []
  const keys = [
    ...new Set(
      rawKeys
        .filter((key): key is string => typeof key === 'string')
        .map((key) => key.trim())
        .filter((key) => key.length > 0 && key.length <= MANAGED_KEY_MAX)
    )
  ]
    .sort()
    .slice(0, MANAGED_KEYS_MAX)
  const by = typeof record.by === 'string' ? record.by.trim().slice(0, MANAGED_BY_MAX) : ''
  return { by: keys.length > 0 && by.length > 0 ? by : null, keys }
}

/**
 * The app menu row's label: Chrome's `IDS_MANAGED_BROWSER` ("Managed browser") in the menus'
 * Title Case (v2 §10). Chrome's desktop menu says "Managed by your organization" / "Managed by
 * <org>" (`IDS_MANAGED`, `IDS_MANAGED_BY`); the phone's row is the Android one.
 */
export const MANAGED_MENU_LABEL = 'Managed Browser'

/** The page's tab title: Chrome for Android's `IDS_MANAGEMENT` ("Management"). */
export const MANAGEMENT_PAGE_TITLE = 'Management'

/**
 * The page's heading, Chrome's `IDS_MANAGEMENT_SUBTITLE_MANAGED_BY` / `_SUBTITLE_MANAGED` /
 * `_NOT_MANAGED_SUBTITLE` in `components/management_strings.grdp` ("Your browser is managed by
 * your organization"), in the house's British spelling.
 */
export function managementHeading(status: ManagedStatus): string {
  if (!isManaged(status)) return 'Your browser is not managed'
  return status.by === null
    ? 'Your browser is managed by your organisation'
    : `Your browser is managed by ${status.by}`
}

/**
 * The notice under the heading. Unmanaged: Chrome's `IDS_MANAGEMENT_NOT_MANAGED_NOTICE` ("…by a
 * company or other organization…") with the product's name, in the house's British spelling.
 * Managed: Chrome's notice promises remote changes and reporting, which Zenium does not do – the
 * bundle is read and listed, not applied – so the notice says exactly that, keeping Chrome's
 * closing sentence about management outside the browser.
 */
export function managementNotice(status: ManagedStatus): string {
  if (!isManaged(status)) {
    return 'This browser is not managed by a company or other organisation. Activity on this device may be managed outside of Zenium.'
  }
  return 'Your administrator set up a managed configuration for Zenium on this device. Zenium reads it and lists the settings below; it does not apply them yet. Activity on this device may also be managed outside of Zenium.'
}

/**
 * The heading of the page's list of keys. Chrome's page has no list of policies (it sends the
 * reader to chrome://policy); the heading says who set the bundle's keys without claiming they
 * are applied – the notice above the list says they are not.
 */
export const MANAGED_KEYS_HEADING = 'Settings your administrator set'
