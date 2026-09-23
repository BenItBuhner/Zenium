import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { DeviceGrant, DeviceKind, Rect, Tab, UIState } from '@shared/types'
import {
  cookieBytes,
  describeSite,
  formatBytes,
  permissionLabel,
  type SiteCookie,
  type SiteInfoSnapshot,
  type SiteSecurity
} from '@shared/siteInfo'
import { cmd, run } from '@renderer/lib/api'
import { useEscape } from '@renderer/hooks/useEscape'
import { DEVICE_KIND_WORDS, grantDetail, grantsOf, grantsRowLabel } from '@renderer/lib/devices'
import { manageExtension } from '@renderer/lib/extensions/manage'
import { extensionPageChrome, extensionPageLine } from '@renderer/lib/extensions/pages'
import { openSettings } from '@renderer/lib/pages'
import { focusableIn } from '@renderer/lib/popover'
import { POPOVER_WIDTH } from '@renderer/lib/portals'
import { permissionSiteOf } from '@renderer/lib/siteChips'
import {
  SITE_DATA_TEXT,
  applySiteDataChoice,
  siteDataChoice,
  siteDataChoiceOptions,
  siteDataDecider,
  siteDataOverviewLine,
  type SiteDataChoice
} from '@renderer/lib/siteDataUi'
import { dismissSiteInfo, refreshSiteInfo, siteInfoStore } from '@renderer/lib/siteInfo'
import {
  blockingSummary,
  connectionDetail,
  connectionHeadline,
  cookiesSummary,
  deviceLevelKind,
  deviceRows,
  permissionOptions,
  permissionRows,
  permissionsSummary,
  security,
  summaryLine,
  type LevelId,
  type PermissionChoice
} from '@renderer/lib/siteInfoCopy'
import { siteChip, siteChipRects } from '@renderer/lib/surfaces'
import { pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useConfirmKeyboard } from '../dialogs/confirmKeyboard'
import { Favicon } from '../sidebar/Favicon'
import { V2_GLYPH, V2Button } from '../v2/controls'
import {
  BarHeader,
  BusyButton,
  DesktopPopover,
  EmptyLine,
  Footer,
  Level,
  ListRow,
  Menulist,
  RowValue,
  Separator,
  TitleBlock,
  type LevelDirection
} from './primitives'

/**
 * Site information on a mouse (design language v1 §9 target, on the v2 chassis): a 400 px popover
 * under the site icon in the address pill (v2 §9.20) opening on a title block (§9.23) – the
 * favicon, the host, one line on the connection – then the rows: Connection, Cookies and site
 * data, Permissions (each a level away, pushing in on the spring), a Trackers blocked row where
 * the engine counts them, Reset permissions, and Site settings (Chrome's last row of page info,
 * omnibox-28: Settings › Privacy and security as a tab, on the site's landing); and the panel
 * form of footer (§9.20) – a hairline in the gutter under the rows, then Clear site data and
 * Reload at 12. The detail levels answer the same commands the Android sheet does (`site.*`,
 * `permissions.*`), so the two surfaces show one site the same way. Everything it shows comes
 * from one `siteInfo.snapshot` reading, taken again after every action. The pill's site-
 * information slot opens it on the Permissions level while it shows a live capture or a blocked
 * permission (`level`, omnibox-38).
 */
export function SiteInfoPopover({
  tab,
  state,
  anchor,
  bar,
  closing,
  level: initialLevel = 'overview',
  onDismiss,
  onClosed
}: {
  tab: Tab
  state: UIState
  anchor: Rect | null
  bar: Rect | null
  /** The store let go of the site (another surface took over, the tab closed): leave now. */
  closing: boolean
  /**
   * The level it opens on: the overview, or Permissions from the pill's site-information slot
   * while it carries a capture or a block (omnibox-38), with the overview a Back away as from
   * any level.
   */
  level?: LevelId
  /** Escape, a press outside, a window resize: the owner starts the exit. */
  onDismiss: () => void
  onClosed: () => void
}): JSX.Element {
  const { info, loading } = useSiteSnapshot(tab)
  const [nav, setNav] = useState<{
    level: LevelId
    direction: LevelDirection
    /** What opened the confirm level standing (`ConfirmOpener`); null on every other level. */
    opener: ConfirmOpener | null
  }>({ level: initialLevel, direction: 'none', opener: null })
  const [busy, setBusy] = useState(false)
  const site = describeSite(tab.url)
  const titleId = `site-info-${tab.id}`

  // A confirm level records what opened it as it is pushed: `go` runs in the opener's own click
  // or key handler, while that control still holds the focus (§10.4's one hop back).
  const go = (level: LevelId): void =>
    setNav({
      level,
      direction: DEPTH[level] > DEPTH[nav.level] ? 'forward' : 'back',
      opener: level === 'clear-data' || level === 'clear-cookies' ? confirmOpener() : null
    })

  const act = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } catch {
      pushToast('That did not work. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  }
  const clearCookies = (): Promise<void> =>
    act(async () => {
      const { removed } = await cmd('site.clearCookies', { tabId: tab.id })
      pushToast(
        removed === 0
          ? 'No cookies to remove'
          : `Removed ${removed} cookie${removed === 1 ? '' : 's'}`
      )
      refreshSiteInfo()
      go('cookies')
    })
  const clearData = (): Promise<void> =>
    act(async () => {
      await cmd('site.clearData', { tabId: tab.id })
      pushToast(`Cleared everything ${site.site || 'this site'} stored`)
      onDismiss()
    })
  const resetPermissions = (): Promise<void> =>
    act(async () => {
      await cmd('site.resetPermissions', { tabId: tab.id })
      refreshSiteInfo()
    })
  const setPermission = (
    permission: string,
    decision: 'allow' | 'deny' | 'default'
  ): Promise<void> =>
    act(async () => {
      if (!info) return
      if (decision === 'default')
        await cmd('permissions.forget', { origin: info.origin, permission })
      else
        await cmd('permissions.set', {
          origin: info.origin,
          permission,
          decision
        })
      refreshSiteInfo()
    })
  // A device the site was connected to through a chooser is forgotten (MW-32..35): the grants
  // are live state (`deviceGrants`), so the rows follow on their own.
  const forgetDevice = (grant: DeviceGrant): Promise<void> =>
    act(async () => {
      await cmd('devices.forget', {
        origin: grant.origin,
        kind: grant.kind,
        deviceId: grant.deviceId
      })
    })
  // The site onto the list picked, or off its list (Chrome's "Add" of the cookies page, from the
  // page itself): the engine says why when it refused (a list at its thousand); the reading is
  // taken again either way, the row and the cookies under it with it.
  const setSiteData = (choice: SiteDataChoice): Promise<void> =>
    act(async () => {
      if (!info) return
      const problem = await applySiteDataChoice(info.siteData, tab.url, choice)
      if (problem) pushToast(problem, 'error')
      refreshSiteInfo()
    })
  const reload = (): void => {
    run('tab.reload', { tabId: tab.id })
    onDismiss()
  }
  // Chrome's last row of page info (omnibox-28): Settings › Privacy and security as a tab, on
  // the `?site=<origin>` landing that opens with the site's own group on screen (#356; the phone
  // sheet's "Site settings" row and the pill's "Requests blocked" row lead the same way). The
  // popover leaves as the tab opens: a settings tab under an open popover would say two things.
  const openSiteSettings = (): void => {
    const origin = permissionSiteOf(tab.url)
    onDismiss()
    openSettings('privacy', origin ? { site: origin } : undefined)
  }

  const cookies = info?.cookies.items ?? []
  const permissions = info?.permissions ?? []
  // The devices the site is connected to (MW-32..35): live state, read by the site's origin.
  const grants = info ? state.deviceGrants.filter((g) => g.origin === info.origin) : []
  const level = nav.level
  const deviceKind = deviceLevelKind(level)
  // Local files share one permissions site (#139), so a decision of theirs shows here too; a
  // local file with none has only the title block, and the footer sits under its 16 (§9.20).
  const rows = site.web || permissions.length > 0 || grants.length > 0

  // A page of an extension (v2 §10.1 applied to extension pages): no site, no connection to
  // describe – the popover says whose page it is and leads to the extension's details.
  const extension =
    site.state === 'extension' ? extensionPageChrome(tab.url, state.extensions) : null
  if (extension) {
    return (
      <DesktopPopover
        anchor={anchor}
        bar={bar}
        width={POPOVER_WIDTH.form}
        labelledBy={titleId}
        closing={closing}
        onClosed={onClosed}
        onDismiss={onDismiss}
        anchorElement={siteChip}
        data-testid="site-info"
        data-level="overview"
      >
        {() => (
          <Level key="extension" direction="none" className="min-h-0">
            <TitleBlock
              id={titleId}
              glyph={<Favicon tab={tab} size={16} />}
              title="Extension page"
              description={extensionPageLine(extension)}
            />
            <Body>
              <ListRow
                label={extension.extension ? 'Manage extension' : 'Manage extensions'}
                chevron
                onClick={() => {
                  onDismiss()
                  manageExtension(extension.id, tab.id)
                }}
              />
            </Body>
            <Footer count={1} hairline>
              <V2Button disabled={busy} onClick={reload} aria-label="Reload page">
                Reload
              </V2Button>
            </Footer>
          </Level>
        )}
      </DesktopPopover>
    )
  }

  return (
    <DesktopPopover
      anchor={anchor}
      bar={bar}
      width={POPOVER_WIDTH.form}
      labelledBy={titleId}
      closing={closing}
      onClosed={onClosed}
      onDismiss={onDismiss}
      anchorElement={siteChip}
      data-testid="site-info"
      data-level={level}
    >
      {() => (
        <Level key={level} direction={nav.direction} className="min-h-0">
          {level === 'overview' && (
            <>
              <TitleBlock
                id={titleId}
                glyph={<Favicon tab={tab} size={16} />}
                title={site.web ? site.host.replace(/^www\./, '') : 'Zenium'}
                description={summaryLine(info, tab, state)}
              />
              {rows && (
                <Body>
                  {site.web && (
                    <>
                      <ListRow
                        label="Connection"
                        trailing={
                          <RowValue>{connectionHeadline(security(info, tab.url))}</RowValue>
                        }
                        chevron
                        onClick={() => go('connection')}
                      />
                      <ListRow
                        label="Cookies and site data"
                        // A list's word for the site is the row's second line (§9.2).
                        description={info ? siteDataOverviewLine(info.siteData) : undefined}
                        trailing={
                          <RowValue muted={!info || cookies.length === 0}>
                            {info ? cookiesSummary(info) : loading ? 'Reading…' : '—'}
                          </RowValue>
                        }
                        chevron
                        onClick={() => go('cookies')}
                      />
                    </>
                  )}
                  <ListRow
                    label="Permissions"
                    trailing={
                      <RowValue muted={permissions.length === 0 && grants.length === 0}>
                        {info
                          ? permissionsSummary(permissions, grants, info.origin)
                          : loading
                            ? 'Reading…'
                            : '—'}
                      </RowValue>
                    }
                    chevron
                    onClick={() => go('permissions')}
                  />
                  {site.web && info?.blocking.available && (
                    <ListRow
                      label="Trackers blocked"
                      trailing={
                        <RowValue muted={info.blocking.blockedCount === 0}>
                          {blockingSummary(info)}
                        </RowValue>
                      }
                    />
                  )}
                  <Separator />
                  <ListRow
                    label="Reset permissions"
                    onClick={() => void resetPermissions()}
                    // The core's reset drops the site's device grants with its decisions.
                    disabled={busy || (permissions.length === 0 && grants.length === 0)}
                    aria-label="Reset permissions of this site"
                  />
                  {site.web && (
                    // The row leaves the popover for a tab, so it trails the open glyph rather
                    // than a level's chevron (§9.20), in the chevron's ink.
                    <ListRow
                      label="Site settings"
                      trailing={
                        <ExternalLink
                          className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')}
                          aria-hidden
                        />
                      }
                      onClick={openSiteSettings}
                      data-site-settings=""
                    />
                  )}
                </Body>
              )}
              <Footer
                count={site.web ? 2 : 1}
                hairline={rows}
                className={rows ? undefined : 'pt-0'}
              >
                {site.web && (
                  <V2Button variant="danger" disabled={busy} onClick={() => go('clear-data')}>
                    Clear site data
                  </V2Button>
                )}
                <V2Button disabled={busy} onClick={reload} aria-label="Reload page">
                  Reload
                </V2Button>
              </Footer>
            </>
          )}

          {level === 'connection' && (
            <ConnectionLevel
              id={titleId}
              security={security(info, tab.url)}
              onBack={() => go('overview')}
            />
          )}

          {level === 'cookies' && (
            <CookiesLevel
              id={titleId}
              info={info}
              loading={loading}
              busy={busy}
              nextLaunch={state.siteData.clearsAtNextLaunch}
              onBack={() => go('overview')}
              onClear={() => go('clear-cookies')}
              onSiteData={(choice) => void setSiteData(choice)}
            />
          )}

          {level === 'permissions' && (
            <PermissionsLevel
              id={titleId}
              rows={info ? permissionRows(permissions, tab) : []}
              devices={info ? deviceRows(grants, info.origin) : []}
              loading={loading}
              busy={busy}
              onBack={() => go('overview')}
              onChange={(permission, decision) => void setPermission(permission, decision)}
              onDevices={(kind) => go(`devices:${kind}`)}
              onReload={reload}
            />
          )}

          {deviceKind && (
            <DevicesLevel
              id={titleId}
              kind={deviceKind}
              grants={info ? grantsOf(state.deviceGrants, info.origin, deviceKind) : []}
              busy={busy}
              onBack={() => go('permissions')}
              onForget={(grant) => void forgetDevice(grant)}
            />
          )}

          {level === 'clear-data' && (
            <ConfirmLevel
              id={titleId}
              name="clear-data"
              title="Clear site data?"
              description={`Removes cookies, stored data and permissions of ${site.site || 'this site'}, then reloads the page.`}
              action="Clear site data"
              busy={busy}
              opener={nav.opener}
              onCancel={() => go('overview')}
              onConfirm={() => void clearData()}
            />
          )}

          {level === 'clear-cookies' && (
            <ConfirmLevel
              id={titleId}
              name="clear-cookies"
              title="Clear cookies?"
              description={`Removes ${cookies.length} cookie${cookies.length === 1 ? '' : 's'} and signs you out of ${site.site || 'this site'}.`}
              action="Clear cookies"
              busy={busy}
              opener={nav.opener}
              onCancel={() => go('cookies')}
              onConfirm={() => void clearCookies()}
            />
          )}
        </Level>
      )}
    </DesktopPopover>
  )
}

const DEPTH: Record<LevelId, number> = {
  overview: 0,
  connection: 1,
  cookies: 1,
  permissions: 1,
  'clear-data': 1,
  'clear-cookies': 2,
  'devices:usb': 2,
  'devices:serial': 2,
  'devices:hid': 2,
  'devices:bluetooth': 2
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * One `siteInfo.snapshot` reading per page and per action (the store's revision): every change of
 * the page is a new reading, and while a reload the popover caused is in flight the last one
 * stays up.
 */
function useSiteSnapshot(tab: Tab): { info: SiteInfoSnapshot | null; loading: boolean } {
  const revision = siteInfoStore.use((s) => s.revision)
  const key = `${tab.id}|${tab.url}|${revision}|${tab.loading ? 'reloading' : 'settled'}`
  const [result, setResult] = useState<{ key: string; info: SiteInfoSnapshot | null } | null>(null)
  const holdLastReading = tab.loading && result !== null
  useEffect(() => {
    if (holdLastReading) return
    let cancelled = false
    cmd('siteInfo.snapshot', { tabId: tab.id }).then(
      (info) => {
        if (!cancelled) setResult({ key, info })
      },
      () => {
        if (!cancelled) setResult({ key, info: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [key, tab.id, holdLastReading])
  return { info: result?.info ?? null, loading: result?.key !== key }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** The scrolling middle of a level: the rows, edge to edge, under a sticky header. */
function Body({
  children,
  onScrolled
}: {
  children: ReactNode
  onScrolled?: (scrolled: boolean) => void
}): JSX.Element {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto pb-1"
      onScroll={onScrolled ? (e) => onScrolled(e.currentTarget.scrollTop > 0) : undefined}
    >
      {children}
    </div>
  )
}

function ConnectionLevel({
  id,
  security: s,
  onBack
}: {
  id: string
  security: SiteSecurity
  onBack: () => void
}): JSX.Element {
  const cert = s.certificate
  return (
    <>
      <BarHeader id={id} title="Connection" onBack={onBack} />
      <Body>
        <div className="px-4 pt-1 pb-3">
          <div className="text-[15px] leading-5 font-semibold">{connectionHeadline(s)}</div>
          {/* Body copy at 15 (§4), like every sentence in the levels around it. */}
          <p className="mt-1 text-[15px] leading-5 text-[var(--v2-text-deemphasized)]">
            {connectionDetail(s)}
          </p>
        </div>
        {cert && (
          <>
            <Separator />
            <ListRow label="Issued to" trailing={<RowValue>{cert.subject || '—'}</RowValue>} />
            <ListRow label="Issued by" trailing={<RowValue>{cert.issuer || '—'}</RowValue>} />
            {cert.validTo !== null && (
              <ListRow label="Expires" trailing={<RowValue>{formatDate(cert.validTo)}</RowValue>} />
            )}
            {cert.protocol && (
              <ListRow label="Protocol" trailing={<RowValue>{cert.protocol}</RowValue>} />
            )}
          </>
        )}
      </Body>
    </>
  )
}

function CookiesLevel({
  id,
  info,
  loading,
  busy,
  nextLaunch,
  onBack,
  onClear,
  onSiteData
}: {
  id: string
  info: SiteInfoSnapshot | null
  loading: boolean
  busy: boolean
  /** The host clears on exit at its next launch (Android): the clear-on-exit option says so. */
  nextLaunch: boolean
  onBack: () => void
  onClear: () => void
  onSiteData: (choice: SiteDataChoice) => void
}): JSX.Element {
  const [scrolled, setScrolled] = useState(false)
  const cookies = info?.cookies.items ?? []
  const thirdParty = info?.cookies.thirdParty ?? []
  const storage = info ? storageRows(info) : []
  const empty = info && cookies.length === 0 && thirdParty.length === 0 && storage.length === 0
  return (
    <>
      <BarHeader id={id} title="Cookies and site data" onBack={onBack} scrolled={scrolled} />
      <Body onScrolled={setScrolled}>
        {!info && loading && <EmptyLine>Reading…</EmptyLine>}
        {info && (
          <>
            {/*
              The per-site policy first (Chrome's cookies page, reached from page info): the
              choice as a menulist trailing the row (§9.13, §9.21), the entry that decides – or
              the default the page falls to – as the row's description. A page with no site to
              add keeps the control at §9.30's .4.
            */}
            <ListRow
              label={SITE_DATA_TEXT.site.label}
              description={siteDataDecider(info.siteData)}
              control
              trailing={
                <Menulist<SiteDataChoice>
                  value={siteDataChoice(info.siteData)}
                  options={siteDataChoiceOptions(info.siteData, nextLaunch)}
                  label={SITE_DATA_TEXT.site.picker}
                  disabled={!info.siteData.addable && !info.siteData.pattern}
                  readOnly={busy}
                  onChange={onSiteData}
                />
              }
            />
            <Separator />
          </>
        )}
        {empty && <EmptyLine>This site has not stored any cookies or data</EmptyLine>}
        {cookies.length > 0 && (
          <>
            <GroupLabel>{`${cookies.length} cookie${cookies.length === 1 ? '' : 's'} · ${formatBytes(cookieBytes(cookies))}`}</GroupLabel>
            {cookies.map((c, i) => (
              <CookieRow key={`${c.name}|${c.domain}|${i}`} cookie={c} />
            ))}
          </>
        )}
        {thirdParty.length > 0 && (
          <>
            <GroupLabel>Also set by sites embedded in this page</GroupLabel>
            {thirdParty.map((t) => (
              <ListRow key={t.site} label={t.site} trailing={<RowValue>{t.count}</RowValue>} />
            ))}
          </>
        )}
        {storage.length > 0 && (
          <>
            <GroupLabel>Stored data</GroupLabel>
            {storage.map(([label, value]) => (
              <ListRow key={label} label={label} trailing={<RowValue>{value}</RowValue>} />
            ))}
          </>
        )}
      </Body>
      {cookies.length > 0 && (
        <Footer count={1}>
          <V2Button variant="danger" disabled={busy} onClick={onClear}>
            Clear cookies
          </V2Button>
        </Footer>
      )}
    </>
  )
}

/** A line naming the rows under it (13 at 69%, in the gutter), as a list's section label. */
function GroupLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-4 pt-2 pb-1 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]">
      {children}
    </div>
  )
}

function CookieRow({ cookie }: { cookie: SiteCookie }): JSX.Element {
  const attrs: string[] = []
  if (cookie.domain) attrs.push(cookie.domain.replace(/^\./, ''))
  if (cookie.session) attrs.push('Session')
  return (
    <ListRow
      label={cookie.name || '(unnamed)'}
      trailing={<RowValue>{attrs.join(' · ')}</RowValue>}
    />
  )
}

function storageRows(info: SiteInfoSnapshot): Array<[string, string]> {
  const s = info.storage
  const rows: Array<[string, string]> = []
  if (s.usageBytes !== null && s.usageBytes > 0) {
    rows.push([
      'Site data',
      s.quotaBytes
        ? `${formatBytes(s.usageBytes)} of ${formatBytes(s.quotaBytes)}`
        : formatBytes(s.usageBytes)
    ])
  }
  if (s.localStorageItems !== null && s.localStorageItems > 0)
    rows.push(['Local storage', items(s.localStorageItems)])
  if (s.sessionStorageItems !== null && s.sessionStorageItems > 0)
    rows.push(['Session storage', items(s.sessionStorageItems)])
  if (s.serviceWorkers !== null && s.serviceWorkers > 0)
    rows.push(['Service workers', String(s.serviceWorkers)])
  if (s.origins.length > 1) rows.push(['Origins with data', String(s.origins.length)])
  return rows
}

/**
 * The Permissions level: a menulist row per stored decision (Sound among them for a tab that
 * plays sound, at its default until the site has its own answer – the row Chrome's page info
 * shows for an audible tab), then, for each device kind the site is connected to through a
 * chooser (MW-32..35), a row with the count that leads to the kind's devices and their Revoke.
 */
function PermissionsLevel({
  id,
  rows,
  devices,
  loading,
  busy,
  onBack,
  onChange,
  onDevices,
  onReload
}: {
  id: string
  rows: Array<{ permission: string; decision: PermissionChoice }>
  devices: Array<{ kind: DeviceKind; label: string; count: number }>
  loading: boolean
  busy: boolean
  onBack: () => void
  onChange: (permission: string, decision: PermissionChoice) => void
  onDevices: (kind: DeviceKind) => void
  onReload: () => void
}): JSX.Element {
  const [scrolled, setScrolled] = useState(false)
  const [changed, setChanged] = useState(false)
  return (
    <>
      <BarHeader id={id} title="Permissions" onBack={onBack} scrolled={scrolled} />
      <Body onScrolled={setScrolled}>
        {rows.length === 0 &&
          devices.length === 0 &&
          (loading ? (
            <EmptyLine>Reading…</EmptyLine>
          ) : (
            <EmptyLine>This site has not asked for any permissions</EmptyLine>
          ))}
        {rows.map((p) => (
          <ListRow
            key={p.permission}
            label={permissionLabel(p.permission)}
            control
            data-permission={p.permission}
            trailing={
              <Menulist<PermissionChoice>
                value={p.decision}
                options={permissionOptions(p.permission)}
                label={permissionLabel(p.permission)}
                disabled={busy}
                onChange={(decision) => {
                  setChanged(true)
                  onChange(p.permission, decision)
                }}
              />
            }
          />
        ))}
        {devices.map((d) => (
          <ListRow
            key={d.kind}
            label={d.label}
            aria-label={grantsRowLabel(d.kind, d.count)}
            data-device-kind={d.kind}
            trailing={<RowValue>{d.count}</RowValue>}
            chevron
            onClick={() => onDevices(d.kind)}
          />
        ))}
      </Body>
      {changed && (
        <Footer count={1} className="justify-between">
          <span className="min-w-0 truncate text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]">
            Reload the page to apply
          </span>
          <V2Button disabled={busy} onClick={onReload} aria-label="Reload page">
            Reload
          </V2Button>
        </Footer>
      )}
    </>
  )
}

/**
 * The devices of one kind the site is connected to (MW-32..35), a level under Permissions: a
 * row per grant with the device's name and, where the engine knows them, its ids as the second
 * line, and Revoke trailing (Chrome's word) – the site must ask again through a chooser. A row
 * revoked leaves the list at once; the last one gone, the level says so and Back is the way out.
 */
function DevicesLevel({
  id,
  kind,
  grants,
  busy,
  onBack,
  onForget
}: {
  id: string
  kind: DeviceKind
  grants: DeviceGrant[]
  busy: boolean
  onBack: () => void
  onForget: (grant: DeviceGrant) => void
}): JSX.Element {
  const [scrolled, setScrolled] = useState(false)
  return (
    <>
      <BarHeader
        id={id}
        title={DEVICE_KIND_WORDS[kind].label}
        onBack={onBack}
        scrolled={scrolled}
      />
      <Body onScrolled={setScrolled}>
        {grants.length === 0 && <EmptyLine>No devices</EmptyLine>}
        {grants.map((grant) => (
          <ListRow
            key={grant.deviceId}
            label={grant.name}
            description={grantDetail(grant) || undefined}
            control
            data-device-id={grant.deviceId}
            trailing={
              <V2Button
                disabled={busy}
                onClick={() => onForget(grant)}
                aria-label={`Revoke ${grant.name}`}
              >
                Revoke
              </V2Button>
            }
          />
        ))}
      </Body>
    </>
  )
}

/**
 * A destructive action asks once, one level in: the question, one sentence, Cancel and the deed
 * – the deed in the danger ink beside Cancel, no primary (§6; `V2Button`'s `data-danger`, the
 * `--v2-danger` ink of §1). The level wears the confirmation primitive's keyboard (§9.22 as
 * amended on #392; `useConfirmKeyboard`, W4-14): it HOLDS ITS CONTAINER as it comes – no verb
 * preselected. `Level` arms a level's first control as the push begins, a list's rule, which for
 * a prompt is Cancel (§9.22's failure case): the container takes the focus back in the same
 * effect flush, before the paint – a parent's effect runs after its child's, so the level's own
 * focusing is queued as a microtask behind it (`Level` itself is W4-7's this round; a
 * `focus: 'container'` on it is the follow-up). Tab enters at Cancel then the verb, wrapping at
 * the ends (the popover's own wrap); Enter from the held container is inert – a destructive
 * prompt has no default – and a focused button answers its own Enter and Space; Escape is one hop
 * back, the level's Escape standing above the popover's on the stack (the popover stays up and
 * takes the next press), and – as Cancel's button does – it hands the focus to the control the
 * level opened from (§10.4 as the lead read it: the control that opened it – here the footer's
 * danger verb of the level under it, "Clear site data", "Clear cookies"): the `opener` the
 * popover recorded as it pushed the level, found again in the level under it as this one leaves
 * (`returnTargetOf`) and focused behind the arriving level's own first focus. While the deed is
 * at work (§9.30) Cancel is disabled and Escape is inert with it. The container carries
 * `data-confirm="<name>"`, the primitive's handle.
 */
function ConfirmLevel({
  id,
  name,
  title,
  description,
  action,
  busy,
  opener,
  onCancel,
  onConfirm
}: {
  id: string
  /** The level's name on its container, `data-confirm="<name>"`: a test's and a drive's handle. */
  name: string
  title: string
  description: string
  action: string
  busy: boolean
  /** What opened the level, recorded as it was pushed; null when nothing that could be told held the focus. */
  opener: ConfirmOpener | null
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const latest = useRef({ busy, opener, onCancel })
  useLayoutEffect(() => {
    latest.current = { busy, opener, onCancel }
  })
  /** How the level was left, for the return: only a Cancel goes back to the verb it came from. */
  const answer = useRef<'cancel' | 'confirm' | null>(null)
  useEffect(() => {
    const el = container.current
    if (!el) return
    let left = false
    queueMicrotask(() => {
      if (!left) el.focus({ preventScroll: true })
    })
    return () => {
      left = true
      if (answer.current !== 'cancel') return
      // The level under this one has mounted by now (this cleanup runs in the same flush as its
      // mount); the control that opened this level stands in it again. Focused behind `Level`'s
      // own first-control focus, before the paint.
      const back = returnTargetOf(latest.current.opener)
      if (!back) return
      queueMicrotask(() => {
        if (back.isConnected) back.focus({ preventScroll: true })
      })
    }
  }, [])
  useConfirmKeyboard(container, { destructive: true, confirm: onConfirm, tab: false })
  const cancel = (): void => {
    answer.current = 'cancel'
    latest.current.onCancel()
  }
  useEscape(() => {
    if (latest.current.busy) return
    cancel()
  })
  return (
    <div
      ref={container}
      tabIndex={-1}
      data-confirm={name}
      data-destructive="true"
      className="flex min-h-0 flex-col outline-none"
    >
      <TitleBlock id={id} title={title} description={description} />
      <Footer count={2} hairline={false} className="pt-0 pb-4">
        <V2Button disabled={busy} onClick={cancel}>
          Cancel
        </V2Button>
        <BusyButton
          variant="danger"
          busy={busy}
          onClick={() => {
            answer.current = 'confirm'
            onConfirm()
          }}
          aria-label={`Confirm ${action.toLowerCase()}`}
        >
          {action}
        </BusyButton>
      </Footer>
    </div>
  )
}

/**
 * What opened a confirm level – §10.4's one hop back, "the control that opened it" as the lead
 * read the sentence (the phone's action row; this popover's footer verb) – recorded as `go`
 * pushes the level, while that control still holds the focus: `go` runs in its click or key
 * handler, and Chromium focuses a button on mousedown, so the mouse path records it as the
 * keyboard's does. The element AND its name: the popover shows one level at a time, so the
 * footer holding the opener unmounts as the confirm level comes and mounts anew as it leaves –
 * the element recorded is out of the document by the return, and its name finds the verb that
 * stands in its place (`returnTargetOf`).
 */
interface ConfirmOpener {
  element: HTMLElement
  name: string
}

/**
 * The control holding the focus inside the popover as a confirm level is pushed; null when none
 * that could be told again does – `body` (a click that moved no focus, as a test's synthetic
 * one), a nameless container, or something outside the popover – and the return falls to the
 * heuristic. It leans on the opener taking the focus as it is pressed: a `<button>` does, on
 * mousedown, unless a mousedown handler prevents that – `V2Button` has none, and one added would
 * want the opener passed to `go` instead.
 */
function confirmOpener(): ConfirmOpener | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !active.closest('[data-testid="site-info"]')) return null
  const name = nameOf(active)
  return name ? { element: active, name } : null
}

/** A control's name for finding it again: its `aria-label`, else its text. */
function nameOf(el: HTMLElement): string {
  return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''
}

/**
 * Where a cancelled confirm level hands the keyboard, read as the level leaves: the recorded
 * opener itself while it is in the document (a host that kept its level mounted), else the
 * popover's control of the same name in the level standing now (the re-mounted footer's verb –
 * so a footer with two danger verbs still returns to the one that asked), else – nothing
 * recorded, or nothing by that name – the heuristic, `openerOfConfirmLevel`.
 */
function returnTargetOf(opener: ConfirmOpener | null): HTMLElement | null {
  if (opener?.element.isConnected) return opener.element
  const root = document.querySelector<HTMLElement>('[data-testid="site-info"]')
  if (opener && root) {
    const named = focusableIn(root).find((el) => nameOf(el) === opener.name)
    if (named) return named
  }
  return openerOfConfirmLevel()
}

/**
 * The fallback for `returnTargetOf` – a heuristic, right for the popover as drawn: the ONE
 * danger verb in the footer of the level standing then – the overview's "Clear site data", the
 * cookies level's "Clear cookies" (the confirm level's own verb is out of the document by the
 * time its cleanup runs). It assumes one danger verb per level's footer, and takes the first
 * were there two; the recorded opener above is what tells them apart. Null when that level draws
 * no such footer (the cookies went).
 */
function openerOfConfirmLevel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="site-info"] [data-footer] .zen-v2-button[data-danger]'
  )
}

function items(n: number): string {
  return `${n} item${n === 1 ? '' : 's'}`
}

function formatDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ms))
  } catch {
    return new Date(ms).toDateString()
  }
}

// ---------------------------------------------------------------------------
// The desktop layer
// ---------------------------------------------------------------------------

/**
 * The popover on a mouse, mounted once above the desktop shell. It holds on to the tab and the
 * anchor after the store lets go of them, so the exit runs on the spring: Escape, a press
 * outside or a resize mark it closing and the store hears `dismissSiteInfo` once the motion is
 * done; when another surface takes over (the store clears first) the same exit plays before the
 * popover unmounts. A tab that closes underneath it is the second case.
 */
export function SiteInfoDesktopLayer({ state }: { state: UIState }): JSX.Element | null {
  const tabId = siteInfoStore.use((s) => s.tabId)
  const anchor = siteInfoStore.use((s) => s.anchor)
  const level = siteInfoStore.use((s) => s.level)
  const tab = tabId ? state.tabs[tabId] : undefined
  // The popover's subject: the store's tab once it names one, followed while it changes, and kept
  // as last seen while the popover leaves – after the user dismissed it, the tab closed or the
  // store moved on. Settled during render, so the exit never waits on an effect. The level it
  // opened on is held with them: the store's word is for the mount, and it is read there once.
  const [held, setHeld] = useState<{
    tab: Tab
    anchor: Rect | null
    level: LevelId
    dismissed: boolean
  } | null>(null)
  let shown = held
  if (tab && held === null) {
    shown = { tab, anchor, level, dismissed: false }
    setHeld(shown)
  } else if (tab && held && held.tab.id === tab.id && held.tab !== tab) {
    shown = { ...held, tab }
    setHeld(shown)
  }
  const shownId = shown?.tab.id ?? null
  const closing = shown !== null && (shown.dismissed || tab?.id !== shownId)
  const onDismiss = useCallback(() => setHeld((h) => (h ? { ...h, dismissed: true } : h)), [])
  const onClosed = useCallback(() => {
    setHeld(null)
    // The store still names this tab when the user dismissed the popover or its tab closed;
    // when another tab's popover took over it names that one, which stays.
    if (shownId !== null && siteInfoStore.get().tabId === shownId) dismissSiteInfo()
  }, [shownId])
  if (!shown) return null
  const bar = shown.anchor ? (siteChipRects().bar ?? shown.anchor) : null
  return (
    <SiteInfoPopover
      key={shown.tab.id}
      tab={shown.tab}
      state={state}
      anchor={shown.anchor}
      bar={bar}
      closing={closing}
      level={shown.level}
      onDismiss={onDismiss}
      onClosed={onClosed}
    />
  )
}
