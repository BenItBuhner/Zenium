import type { DeviceGrant, DeviceKind, MediaState, Platform, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import {
  builtInDefault,
  contentSetting,
  type ContentDecision,
  type ContentDefault
} from '@shared/contentSettings'
import {
  certificateErrorDetail,
  certificateFault,
  cookieBytes,
  describeSite,
  formatBytes,
  permissionLabel,
  refusedCertificate,
  type SiteInfoSnapshot,
  type SitePermission,
  type SiteSecurity
} from '@shared/siteInfo'
import type { MenulistOption } from '@renderer/components/siteControls/primitives'
import { DEVICE_KIND_ORDER, DEVICE_KIND_WORDS, grantsByKind } from '@renderer/lib/devices'

/**
 * The words of the desktop site-information popover (`components/siteControls/SiteInfoPopover`):
 * what the connection, cookies, blocking and permission rows say, kept apart from the rendering
 * so they can be read and tested on their own.
 */

/**
 * The popover's levels: the overview, the four it pushes in to, and – a level under Permissions –
 * the devices of one kind the site is connected to (`devices:usb`, …; MW-32..35).
 */
export type LevelId =
  | 'overview'
  | 'connection'
  | 'cookies'
  | 'permissions'
  | 'clear-data'
  | 'clear-cookies'
  | `devices:${DeviceKind}`

/**
 * The connection under the page as the popover reads it: the host's reading (`info.security`,
 * the core's `composeSiteInfo`) once it has landed, else what the tab itself can tell – a
 * certificate the tab refused (`Tab.certificateError`) reads as not secure from the first frame,
 * as the pill's triangle already does, never as secure for the beat the reading takes. An
 * extension page has no connection to speak of, whatever origin the Android runtime serves it
 * from (`describeSite` says `extension`).
 */
export function security(
  info: SiteInfoSnapshot | null,
  url: string,
  tab?: Pick<Tab, 'certificateError'>
): SiteSecurity {
  const site = describeSite(url)
  if (site.state === 'extension')
    return { state: 'extension', certificate: null, mixedContent: null }
  if (info) return info.security
  const error = tab?.certificateError ?? null
  if (site.state === 'secure' && error)
    return {
      state: 'insecure',
      certificate: refusedCertificate(error),
      mixedContent: null,
      certificateError: error
    }
  return { state: site.state, certificate: null, mixedContent: null }
}

/**
 * What is wrong with the connection's certificate, in the shared module's words
 * (`certificateFault`, Android's #382: "Certificate expired", "Certificate not trusted", …), as
 * the phone sheet's title line names it; null while no certificate was refused. The fault and
 * never the issuer: an invalid certificate's issuer is no credential – the Connection level's
 * certificate rows still list it, under "Certificate that was refused". `now` tells an expired
 * certificate from one not yet valid, for a test's fixed clock.
 */
export function connectionFault(s: SiteSecurity, now?: number): string | null {
  const error = s.certificateError
  if (!error) return null
  return certificateFault(error.code, error.certificate, now)
}

/**
 * The overview's Connection row value and the Connection level's headline: the certificate's
 * fault where one was refused – in the danger ink, the caller's – else the headline.
 */
export function connectionValue(s: SiteSecurity): string {
  return connectionFault(s) ?? connectionHeadline(s)
}

/** "Secure connection", "Not secure", … as the connection row and level headline say it. */
export function connectionHeadline(s: SiteSecurity): string {
  switch (s.state) {
    case 'secure':
      return s.mixedContent ? 'Partly secure' : 'Secure'
    case 'insecure':
      return 'Not secure'
    case 'local':
      return 'Local page'
    case 'internal':
      return 'Zenium page'
    case 'extension':
      return 'Extension page'
    default:
      return 'Unknown'
  }
}

export function connectionDetail(s: SiteSecurity): string {
  // A refused certificate: the shared module's sentence, the phone sheet's (bypassed or refused).
  if (s.certificateError) return certificateErrorDetail(s.certificateError)
  switch (s.state) {
    case 'secure':
      return s.mixedContent
        ? 'The page is encrypted, but some of what it loaded came over a plain connection.'
        : 'Everything you send to this site is encrypted on the way.'
    case 'insecure':
      return 'What you send to this site can be read by anyone along the way.'
    case 'local':
      return 'Served from this device; nothing crosses the network.'
    case 'internal':
      return 'Built into the browser; no site is involved.'
    case 'extension':
      return 'A page of an installed extension; no site is involved.'
    default:
      return 'Zenium could not tell how this page reached you.'
  }
}

/**
 * The title block's line: the connection, who vouched for it – or, where the certificate failed
 * verification, what is wrong with it (the phone sheet's line: "Not secure · Certificate
 * expired"; the issuer of a refused certificate is no credential) – and what sets this tab apart:
 * a container other than the default, or the private session.
 */
export function summaryLine(info: SiteInfoSnapshot | null, tab: Tab, state: UIState): string {
  const s = security(info, tab.url, tab)
  const parts = [connectionHeadline(s)]
  const fault = connectionFault(s)
  if (fault) parts.push(fault)
  else if (s.state === 'secure' && s.certificate?.issuer) parts.push(s.certificate.issuer)
  if (info?.isPrivate) parts.push('Private tab')
  else if (tab.containerId !== DEFAULT_CONTAINER_ID) {
    const container = state.containers.find((c) => c.id === tab.containerId)?.name
    if (container) parts.push(container)
  }
  return parts.join(' · ')
}

/** "4 cookies · 542 B", "1.2 MB stored", "None". */
export function cookiesSummary(info: SiteInfoSnapshot): string {
  const cookies = info.cookies.items
  const parts: string[] = []
  if (cookies.length > 0)
    parts.push(
      `${cookies.length} cookie${cookies.length === 1 ? '' : 's'} · ${formatBytes(cookieBytes(cookies))}`
    )
  const stored = info.storage.usageBytes
  if (stored !== null && stored > 0) parts.push(`${formatBytes(stored)} stored`)
  else if (cookies.length === 0 && storesAnything(info)) parts.push('Stored data')
  return parts.length > 0 ? parts.join(' · ') : 'None'
}

/** Anything beyond quota-managed storage: Web Storage items or service workers. */
export function storesAnything(info: SiteInfoSnapshot): boolean {
  const s = info.storage
  return (
    (s.localStorageItems ?? 0) > 0 ||
    (s.sessionStorageItems ?? 0) > 0 ||
    (s.serviceWorkers ?? 0) > 0 ||
    s.origins.length > 0
  )
}

export function blockingSummary(info: SiteInfoSnapshot): string {
  const b = info.blocking
  if (!b.enabled) return 'Blocking off'
  if (b.excepted) return 'Off for this site'
  return String(b.blockedCount)
}

export type PermissionChoice = 'allow' | 'deny' | 'default'

/** Allow / Block / back to the default, the default named for what it is. */
export function permissionOptions(permission: string): MenulistOption<PermissionChoice>[] {
  const fallback = builtInDefault(permission)
  const label = fallback === 'ask' ? 'Ask' : fallback === 'allow' ? 'Allow' : 'Block'
  return [
    { value: 'default', label: `${label} (default)` },
    { value: 'allow', label: 'Allow' },
    { value: 'deny', label: 'Block' }
  ]
}

/** The levels, for the tests' `data-level` selectors. */
export const SITE_INFO_LEVELS: readonly LevelId[] = [
  'overview',
  'connection',
  'cookies',
  'permissions',
  'clear-data',
  'clear-cookies',
  ...DEVICE_KIND_ORDER.map((kind): LevelId => `devices:${kind}`)
]

/** The kind a `devices:<kind>` level shows; null for any other level. */
export function deviceLevelKind(level: LevelId): DeviceKind | null {
  if (!level.startsWith('devices:')) return null
  const kind = level.slice('devices:'.length) as DeviceKind
  return DEVICE_KIND_ORDER.includes(kind) ? kind : null
}

/**
 * Whether the Permissions level carries the Sound row (Chrome's page info shows it for a tab
 * that plays or has played sound, or whose site has its own answer): the site has a stored
 * `sound` decision, or the tab is audible or muted.
 */
export function showsSoundRow(permissions: readonly SitePermission[], tab: Tab): boolean {
  return permissions.some((p) => p.permission === 'sound') || tab.audible || tab.muted
}

/**
 * The site's own `sound` answer as stored, or `default` where it has none. The stored answer,
 * not the row's position: the Sound switch reads the state in force (`switchOn`).
 */
export function soundChoice(permissions: readonly SitePermission[]): PermissionChoice {
  return permissions.find((p) => p.permission === 'sound')?.decision ?? 'default'
}

/**
 * The defaults the core carries to the chrome (`UIState.permissionDefaults`: every catalogue
 * row's default in force, the user's where Settings chose one, else the catalogue's), or none
 * where a state has yet to carry them.
 */
export type PermissionDefaults = Readonly<Record<string, ContentDefault>> | undefined

/**
 * The default in force for a permission: the core's word where it carries one, else the
 * catalogue's built-in – the reading Settings › Site settings' rows take (`settingsRows`).
 */
export function defaultInForce(permission: string, defaults: PermissionDefaults): ContentDefault {
  return defaults?.[permission] ?? builtInDefault(permission)
}

/**
 * The position of a switch row of the sheet (§10.4, the lead's ruling on #531): the state in
 * force for this site – its own answer where it has one, else the default in force – and never
 * the stored answer alone. With Background video's default at Allow and no answer for the site,
 * the site plays on, and the row reads on; an answer equal to the default reads as the default
 * does. On is `allow`; anything else (a block, or a default that asks) is off.
 */
export function switchOn(
  permissions: readonly SitePermission[],
  permission: string,
  defaults: PermissionDefaults
): boolean {
  const stored = permissions.find((p) => p.permission === permission)?.decision
  return (stored ?? defaultInForce(permission, defaults)) === 'allow'
}

/** What a press on a switch row writes for the site: its own rule, or its answer forgotten. */
export type SwitchWrite = { decision: ContentDecision } | { forget: true }

/**
 * The write a press makes (§10.4): the site's rule that gives the state the press asks – an
 * `allow` under a blocking default, a `deny` under an allowing one – and a forget only where the
 * default already gives what the press asks, since an answer equal to the default is redundant
 * (Chrome clears an exception equal to the default). `on` is the state after the press;
 * `fallback` the default in force. Under a default that asks, neither state is given, so either
 * press stores.
 */
export function switchWrite(on: boolean, fallback: ContentDefault): SwitchWrite {
  const decision: ContentDecision = on ? 'allow' : 'deny'
  return fallback === decision ? { forget: true } : { decision }
}

/** The catalogue's Background video row (services' #523): Block by default, Android enforced, the desktop `n-a`. */
const BACKGROUND_VIDEO = contentSetting('background-video')

/**
 * Whether the phone sheet carries the Background video row (MED-08 / EDGE-32, the lead's ruling
 * on #523: a site's per-site answer has its home among the sheet's permission rows). Two
 * conditions: the host honours the setting – the catalogue's `support` for the platform is not
 * `n-a`, so Android alone today; the desktop has no background transition to gate and never
 * earns the row, whatever its window's form factor – and, in Sound's `audible || muted` shape,
 * the site has a stored `background-video` answer or the tab's media session reports video
 * (`MediaState.video`: a page that plays or has played a video while the tab lives; a chrome
 * player's session never says video).
 */
export function showsBackgroundVideoRow(
  permissions: readonly SitePermission[],
  media: Pick<MediaState, 'video'> | null | undefined,
  platform: Platform
): boolean {
  const support = BACKGROUND_VIDEO?.support[platform === 'android' ? 'android' : 'desktop']
  if (!support || support === 'n-a') return false
  return permissions.some((p) => p.permission === 'background-video') || media?.video === true
}

/**
 * The site's own `background-video` answer as stored, or `default` where it has none. The
 * stored answer, not the row's position: the Background video switch reads the state in force
 * (`switchOn`), under a default the catalogue sets to Block and Settings may turn to Allow.
 */
export function backgroundVideoChoice(permissions: readonly SitePermission[]): PermissionChoice {
  return permissions.find((p) => p.permission === 'background-video')?.decision ?? 'default'
}

/**
 * The row's second line, one and the same in both states (the lead's ruling on #531): the sheet
 * is this site's, so the line names what the switch does for it, and the switch alone carries
 * the state (§10.4's switch rows carry one constant line saying what on does). The catalogue's
 * two sentences – "Sites can keep playing video in the background" / "Sites cannot play video in
 * the background" – are Settings › Site settings' and stay there: their subject is sites in
 * general, and a line that flips with the switch tells the state twice; on a per-site row both
 * would be wrong.
 */
export const BACKGROUND_VIDEO_LINE = 'Keeps playing video in the background'

/**
 * The permission rows of the Permissions level in order: the stored decisions as the engine
 * lists them (Sound among them where it is stored), then Sound at its default where the tab
 * earns the row without a decision.
 */
export function permissionRows(
  permissions: readonly SitePermission[],
  tab: Tab
): Array<{ permission: string; decision: PermissionChoice }> {
  const rows: Array<{ permission: string; decision: PermissionChoice }> = permissions.map((p) => ({
    permission: p.permission,
    decision: p.decision
  }))
  if (showsSoundRow(permissions, tab) && !permissions.some((p) => p.permission === 'sound'))
    rows.push({ permission: 'sound', decision: 'default' })
  return rows
}

/**
 * The device rows of the Permissions level: one per kind the site is connected to, in the
 * catalogue's order, each with its count; a kind with no grants shows nothing.
 */
export function deviceRows(
  grants: readonly DeviceGrant[],
  origin: string
): Array<{ kind: DeviceKind; label: string; count: number }> {
  return grantsByKind(grants, origin).map(({ kind, grants: own }) => ({
    kind,
    label: DEVICE_KIND_WORDS[kind].label,
    count: own.length
  }))
}

/**
 * The overview's Permissions value: "None", or the stored permissions' labels and the device
 * kinds the site is connected to, comma-separated ("Camera, USB devices").
 */
export function permissionsSummary(
  permissions: readonly SitePermission[],
  grants: readonly DeviceGrant[],
  origin: string
): string {
  const names = [
    ...permissions.map((p) => permissionLabel(p.permission)),
    ...deviceRows(grants, origin).map((r) => r.label)
  ]
  return names.length === 0 ? 'None' : names.join(', ')
}
