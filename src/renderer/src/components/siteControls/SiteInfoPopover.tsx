import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { Rect, Tab, UIState } from '@shared/types'
import {
  cookieBytes,
  describeSite,
  formatBytes,
  permissionLabel,
  type SiteCookie,
  type SiteInfoSnapshot,
  type SitePermission,
  type SiteSecurity
} from '@shared/siteInfo'
import { cmd, run } from '@renderer/lib/api'
import { manageExtension } from '@renderer/lib/extensions/manage'
import { extensionPageChrome, extensionPageLine } from '@renderer/lib/extensions/pages'
import { POPOVER_WIDTH } from '@renderer/lib/portals'
import { dismissSiteInfo, refreshSiteInfo, siteInfoStore } from '@renderer/lib/siteInfo'
import {
  blockingSummary,
  connectionDetail,
  connectionHeadline,
  cookiesSummary,
  permissionOptions,
  security,
  summaryLine,
  type LevelId,
  type PermissionChoice
} from '@renderer/lib/siteInfoCopy'
import { siteChip, siteChipRects } from '@renderer/lib/surfaces'
import { pushToast } from '@renderer/lib/ui'
import { Favicon } from '../sidebar/Favicon'
import { V2Button } from '../v2/controls'
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
 * favicon, the host, one line on the connection – then four rows: Connection, Cookies and site
 * data, Permissions (each a level away, pushing in on the spring), Reset permissions; a Trackers
 * blocked row where the engine counts them; and the panel form of footer (§9.20) – a hairline in
 * the gutter under the rows, then Clear site data and Reload at 12. The
 * detail levels answer the same commands the Android sheet does (`site.*`, `permissions.*`), so
 * the two surfaces show one site the same way. Everything it shows comes from one
 * `siteInfo.snapshot` reading, taken again after every action.
 */
export function SiteInfoPopover({
  tab,
  state,
  anchor,
  bar,
  closing,
  onDismiss,
  onClosed
}: {
  tab: Tab
  state: UIState
  anchor: Rect | null
  bar: Rect | null
  /** The store let go of the site (another surface took over, the tab closed): leave now. */
  closing: boolean
  /** Escape, a press outside, a window resize: the owner starts the exit. */
  onDismiss: () => void
  onClosed: () => void
}): JSX.Element {
  const { info, loading } = useSiteSnapshot(tab)
  const [nav, setNav] = useState<{ level: LevelId; direction: LevelDirection }>({
    level: 'overview',
    direction: 'none'
  })
  const [busy, setBusy] = useState(false)
  const site = describeSite(tab.url)
  const titleId = `site-info-${tab.id}`

  const go = (level: LevelId): void =>
    setNav({ level, direction: DEPTH[level] > DEPTH[nav.level] ? 'forward' : 'back' })

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
    permission: SitePermission,
    decision: 'allow' | 'deny' | 'default'
  ): Promise<void> =>
    act(async () => {
      if (!info) return
      if (decision === 'default')
        await cmd('permissions.forget', { origin: info.origin, permission: permission.permission })
      else
        await cmd('permissions.set', {
          origin: info.origin,
          permission: permission.permission,
          decision
        })
      refreshSiteInfo()
    })
  const reload = (): void => {
    run('tab.reload', { tabId: tab.id })
    onDismiss()
  }

  const cookies = info?.cookies.items ?? []
  const permissions = info?.permissions ?? []
  const level = nav.level
  // Local files share one permissions site (#139), so a decision of theirs shows here too; a
  // local file with none has only the title block, and the footer sits under its 16 (§9.20).
  const rows = site.web || permissions.length > 0

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
                      <RowValue muted={permissions.length === 0}>
                        {info
                          ? permissions.length === 0
                            ? 'None'
                            : permissions.map((p) => permissionLabel(p.permission)).join(', ')
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
                    disabled={busy || permissions.length === 0}
                    aria-label="Reset permissions of this site"
                  />
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
              onBack={() => go('overview')}
              onClear={() => go('clear-cookies')}
            />
          )}

          {level === 'permissions' && (
            <PermissionsLevel
              id={titleId}
              permissions={permissions}
              loading={loading}
              busy={busy}
              onBack={() => go('overview')}
              onChange={(p, decision) => void setPermission(p, decision)}
              onReload={reload}
            />
          )}

          {level === 'clear-data' && (
            <ConfirmLevel
              id={titleId}
              title="Clear site data?"
              description={`Removes cookies, stored data and permissions of ${site.site || 'this site'}, then reloads the page.`}
              action="Clear site data"
              busy={busy}
              onCancel={() => go('overview')}
              onConfirm={() => void clearData()}
            />
          )}

          {level === 'clear-cookies' && (
            <ConfirmLevel
              id={titleId}
              title="Clear cookies?"
              description={`Removes ${cookies.length} cookie${cookies.length === 1 ? '' : 's'} and signs you out of ${site.site || 'this site'}.`}
              action="Clear cookies"
              busy={busy}
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
  'clear-cookies': 2
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
  onBack,
  onClear
}: {
  id: string
  info: SiteInfoSnapshot | null
  loading: boolean
  busy: boolean
  onBack: () => void
  onClear: () => void
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

function PermissionsLevel({
  id,
  permissions,
  loading,
  busy,
  onBack,
  onChange,
  onReload
}: {
  id: string
  permissions: SitePermission[]
  loading: boolean
  busy: boolean
  onBack: () => void
  onChange: (permission: SitePermission, decision: PermissionChoice) => void
  onReload: () => void
}): JSX.Element {
  const [scrolled, setScrolled] = useState(false)
  const [changed, setChanged] = useState(false)
  return (
    <>
      <BarHeader id={id} title="Permissions" onBack={onBack} scrolled={scrolled} />
      <Body onScrolled={setScrolled}>
        {permissions.length === 0 &&
          (loading ? (
            <EmptyLine>Reading…</EmptyLine>
          ) : (
            <EmptyLine>This site has not asked for any permissions</EmptyLine>
          ))}
        {permissions.map((p) => (
          <ListRow
            key={p.permission}
            label={permissionLabel(p.permission)}
            control
            trailing={
              <Menulist<PermissionChoice>
                value={p.decision}
                options={permissionOptions(p.permission)}
                label={permissionLabel(p.permission)}
                disabled={busy}
                onChange={(decision) => {
                  setChanged(true)
                  onChange(p, decision)
                }}
              />
            }
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

/** A destructive action asks once, one level in: the question, one sentence, Cancel and the deed. */
function ConfirmLevel({
  id,
  title,
  description,
  action,
  busy,
  onCancel,
  onConfirm
}: {
  id: string
  title: string
  description: string
  action: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <>
      <TitleBlock id={id} title={title} description={description} />
      <Footer count={2} hairline={false} className="pt-0 pb-4">
        <V2Button disabled={busy} onClick={onCancel}>
          Cancel
        </V2Button>
        <BusyButton
          variant="danger"
          busy={busy}
          onClick={onConfirm}
          aria-label={`Confirm ${action.toLowerCase()}`}
        >
          {action}
        </BusyButton>
      </Footer>
    </>
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
  const tab = tabId ? state.tabs[tabId] : undefined
  // The popover's subject: the store's tab once it names one, followed while it changes, and kept
  // as last seen while the popover leaves – after the user dismissed it, the tab closed or the
  // store moved on. Settled during render, so the exit never waits on an effect.
  const [held, setHeld] = useState<{ tab: Tab; anchor: Rect | null; dismissed: boolean } | null>(
    null
  )
  let shown = held
  if (tab && held === null) {
    shown = { tab, anchor, dismissed: false }
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
      onDismiss={onDismiss}
      onClosed={onClosed}
    />
  )
}
