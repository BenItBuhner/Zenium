import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Lock, LockOpen } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import {
  cookieBytes,
  describeSite,
  formatBytes,
  permissionLabel,
  type SiteCookie,
  type SiteInfo
} from '@shared/siteInfo'
import { cmd, run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import {
  closeSiteInfo,
  dismissSiteInfo,
  refreshSiteInfo,
  setSiteInfoTravel,
  siteInfoDrag,
  siteInfoStore
} from '@renderer/lib/siteInfo'
import { browserStore, pushToast, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'

/** Extra run below the screen edge so an upward overshoot never shows a gap under the sheet. */
const UNDERHANG = 48
/** Cookies listed before the list folds. */
const COOKIE_FOLD = 6

/**
 * Site information: what the browser knows about the site a tab is on – the connection and its
 * certificate, cookies, stored data, permissions – with the actions to take them away again.
 * Opens from the site icon in the address pill: a spring-driven sheet on phones, a panel anchored
 * to the icon everywhere else. Mounted once above whichever shell is up.
 */
export function SiteInfoLayer(): JSX.Element | null {
  const tabId = siteInfoStore.use((s) => s.tabId)
  const state = browserStore.use((s) => s.state)
  const viewport = useViewport()
  const tab = tabId && state ? state.tabs[tabId] : undefined
  // The tab closed underneath the sheet.
  useEffect(() => {
    if (tabId && !tab) dismissSiteInfo()
  }, [tabId, tab])
  if (!tab || !state) return null
  return viewport.formFactor === 'phone' ? (
    <PhoneSheet tab={tab} state={state} />
  ) : (
    <Popover tab={tab} state={state} />
  )
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function useSiteInfo(tab: Tab): { info: SiteInfo | null; loading: boolean } {
  const revision = siteInfoStore.use((s) => s.revision)
  // Every change of the page (or an action of the sheet) is a new reading.
  const key = `${tab.id}|${tab.url}|${revision}|${tab.loading ? 'reloading' : 'settled'}`
  const [result, setResult] = useState<{ key: string; info: SiteInfo | null } | null>(null)
  // While a reload we caused is in flight the last reading stays up; read again once it lands.
  const holdLastReading = tab.loading && result !== null
  useEffect(() => {
    if (holdLastReading) return
    let cancelled = false
    cmd('site.info', { tabId: tab.id }).then(
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
// Phone: bottom sheet on a spring
// ---------------------------------------------------------------------------

function PhoneSheet({ tab, state }: { tab: Tab; state: UIState }): JSX.Element {
  const sheet = siteInfoStore.use((s) => s.sheet)
  const insets = uiStore.use((s) => s.insets)
  const ref = useRef<HTMLDivElement>(null)
  const [travel, setTravel] = useState(0)
  const grip = useSheetGrip()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const height = el.offsetHeight
      setTravel(height)
      setSiteInfoTravel(height)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeSiteInfo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const progress = sheet.progress
  const shown = Math.min(1, Math.max(0, progress))
  return (
    <div
      className="fixed inset-0 z-[80]"
      style={{ pointerEvents: sheet.phase === 'closed' ? 'none' : 'auto' }}
    >
      <div
        className="absolute inset-0 bg-black/40"
        style={{ opacity: 1 - shown }}
        onClick={() => closeSiteInfo()}
      />
      <div
        ref={ref}
        role="dialog"
        aria-label="Site information"
        className="zen-sheet absolute inset-x-0 mx-auto flex w-full max-w-[520px] flex-col"
        style={{
          bottom: -UNDERHANG,
          maxHeight: `calc(100% - ${insets.top + 40}px)`,
          paddingBottom: insets.bottom + 12 + UNDERHANG,
          transform: `translate3d(0, ${Math.round(progress * travel)}px, 0)`
        }}
      >
        <div
          className="shrink-0 px-3 pb-1 pt-2"
          role="button"
          tabIndex={-1}
          aria-label="Drag to dismiss"
          {...grip}
        >
          <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-[var(--zen-fg)]/20" />
          <SiteHeader tab={tab} state={state} />
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 pt-2"
          style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
        >
          <SiteInfoBody tab={tab} />
        </div>
      </div>
    </div>
  )
}

interface GripHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  style: CSSProperties
}

/** Dragging the grip pulls the sheet down; a touch during its animation catches it. */
function useSheetGrip(): GripHandlers {
  const touch = useRef<{ id: number; y0: number; tracker: VelocityTracker } | null>(null)
  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    const { vy } = cancelled ? { vy: 0 } : t.tracker.velocity(e.timeStamp)
    siteInfoDrag.release(vy)
  }
  return {
    onPointerDown: (e) => {
      if (e.button !== 0 || touch.current) return
      if (!siteInfoDrag.begin()) return
      const tracker = new VelocityTracker()
      tracker.add(e.timeStamp, e.clientX, e.clientY)
      touch.current = { id: e.pointerId, y0: e.clientY, tracker }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e) => {
      const t = touch.current
      if (!t || t.id !== e.pointerId) return
      const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }
      const coalesced = native.getCoalescedEvents?.() ?? []
      if (coalesced.length > 0)
        for (const c of coalesced) t.tracker.add(c.timeStamp, c.clientX, c.clientY)
      else t.tracker.add(e.timeStamp, e.clientX, e.clientY)
      siteInfoDrag.move(e.clientY - t.y0)
    },
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    style: { touchAction: 'none' }
  }
}

// ---------------------------------------------------------------------------
// Desktop and tablet: panel anchored to the site icon
// ---------------------------------------------------------------------------

function Popover({ tab, state }: { tab: Tab; state: UIState }): JSX.Element {
  const anchor = siteInfoStore.use((s) => s.anchor)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 8, top: 8 })
  const width = Math.min(400, window.innerWidth - 16)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = anchor ? anchor.x - 12 : (window.innerWidth - width) / 2
    const y = anchor ? anchor.y + anchor.height + 10 : 64
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    })
  }, [anchor, width])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeSiteInfo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="fixed inset-0 z-[80]" onMouseDown={() => closeSiteInfo()}>
      <div
        ref={ref}
        role="dialog"
        aria-label="Site information"
        className="zen-panel zen-animate-pop zen-sheet-panel absolute flex flex-col overflow-hidden"
        style={{ left: pos.left, top: pos.top, width, maxHeight: window.innerHeight - 16 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-3 pt-3">
          <SiteHeader tab={tab} state={state} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
          <SiteInfoBody tab={tab} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function SiteHeader({ tab, state }: { tab: Tab; state: UIState }): JSX.Element {
  const site = describeSite(tab.url)
  const container =
    tab.containerId !== DEFAULT_CONTAINER_ID
      ? state.containers.find((c) => c.id === tab.containerId)?.name
      : undefined
  const title = site.web ? site.host.replace(/^www\./, '') : 'Zenium'
  const detail = [site.web && site.site !== site.host ? site.host : null, container]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex items-center gap-3 px-1">
      <Favicon tab={tab} size={22} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[16px] font-semibold leading-tight">{title}</div>
        {detail && (
          <div className="truncate text-[12px] leading-tight text-[var(--zen-muted)]">{detail}</div>
        )}
      </div>
    </div>
  )
}

function SiteInfoBody({ tab }: { tab: Tab }): JSX.Element {
  const { info, loading } = useSiteInfo(tab)
  const site = describeSite(tab.url)
  const [confirming, setConfirming] = useState<'cookies' | 'data' | null>(null)
  const [busy, setBusy] = useState(false)
  const [allCookies, setAllCookies] = useState(false)

  const act = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await work()
    } catch {
      pushToast('That did not work. Try again.', 'error')
    } finally {
      setBusy(false)
      setConfirming(null)
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
    })
  const clearData = (): Promise<void> =>
    act(async () => {
      await cmd('site.clearData', { tabId: tab.id })
      pushToast(`Cleared everything ${site.site || 'this site'} stored`)
      refreshSiteInfo()
    })
  const resetPermission = (permission?: string): Promise<void> =>
    act(async () => {
      await cmd('site.resetPermissions', { tabId: tab.id, permission })
      refreshSiteInfo()
    })
  const reload = (): void => {
    run('tab.reload', { tabId: tab.id })
    closeSiteInfo()
  }

  const cookies = info?.cookies.items ?? []
  const shownCookies = allCookies ? cookies : cookies.slice(0, COOKIE_FOLD)
  const permissions = info?.permissions ?? []

  return (
    <div className="flex flex-col gap-2.5 pb-1">
      <ConnectionCard info={info} url={tab.url} />

      {site.web && (
        <>
          <Card
            title="Cookies"
            value={
              info ? (
                <span aria-label={`${cookies.length} cookies`}>{cookies.length}</span>
              ) : loading ? (
                <Quiet>Reading…</Quiet>
              ) : null
            }
          >
            {info && cookies.length === 0 && <Quiet>This site has not stored any cookies.</Quiet>}
            {shownCookies.map((c, i) => (
              <CookieRow key={`${c.name}|${c.domain}|${i}`} cookie={c} />
            ))}
            {cookies.length > COOKIE_FOLD && (
              <TextButton onClick={() => setAllCookies((v) => !v)}>
                {allCookies ? 'Show fewer' : `Show all ${cookies.length}`}
              </TextButton>
            )}
            {info && info.cookies.thirdParty.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                <div className="text-[12px] text-[var(--zen-muted)]">
                  Also set by sites embedded in this page
                </div>
                {info.cookies.thirdParty.map((t) => (
                  <Row key={t.site} label={t.site} value={String(t.count)} mono />
                ))}
              </div>
            )}
            {info && cookies.length > 0 && (
              <div className="mt-1 text-[12px] text-[var(--zen-muted)]">
                {formatBytes(cookieBytes(cookies))} in total
              </div>
            )}
          </Card>
          {cookies.length > 0 &&
            (confirming === 'cookies' ? (
              <Confirm
                message={`Removes ${cookies.length} cookie${cookies.length === 1 ? '' : 's'} and signs you out of ${site.site}.`}
                action="Clear"
                actionLabel="Confirm clear cookies"
                busy={busy}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void clearCookies()}
              />
            ) : (
              <Action label="Clear cookies" onClick={() => setConfirming('cookies')} />
            ))}

          <Card
            title="Storage"
            value={
              info ? (
                info.storage.usageBytes !== null && info.storage.usageBytes > 0 ? (
                  formatBytes(info.storage.usageBytes)
                ) : storesAnything(info) ? null : (
                  <Quiet>None</Quiet>
                )
              ) : loading ? (
                <Quiet>Reading…</Quiet>
              ) : null
            }
          >
            {info && <StorageRows info={info} />}
          </Card>

          <Card title="Permissions">
            {info && permissions.length === 0 && (
              <Quiet>This site has not asked for any permissions.</Quiet>
            )}
            {permissions.map((p) => (
              <div key={p.permission} className="flex h-9 items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-[13.5px]">
                  {permissionLabel(p.permission)}
                </span>
                <span
                  className={cn(
                    'text-[12.5px]',
                    p.decision === 'allow' ? 'text-[var(--zen-fg)]' : 'text-[var(--zen-muted)]'
                  )}
                >
                  {p.decision === 'allow' ? 'Allowed' : 'Blocked'}
                </span>
                <TextButton
                  aria-label={`Reset ${permissionLabel(p.permission)} permission`}
                  disabled={busy}
                  onClick={() => void resetPermission(p.permission)}
                >
                  {p.decision === 'allow' ? 'Revoke' : 'Reset'}
                </TextButton>
              </div>
            ))}
            {permissions.length > 1 && (
              <TextButton
                aria-label="Reset all permissions"
                disabled={busy}
                onClick={() => void resetPermission()}
              >
                Reset all
              </TextButton>
            )}
          </Card>

          <div className="flex gap-2.5">
            {confirming === 'data' ? (
              <Confirm
                message={`Removes cookies, stored data and permissions of ${site.site}, then reloads the page.`}
                action="Clear everything"
                actionLabel="Confirm clear all site data"
                busy={busy}
                onCancel={() => setConfirming(null)}
                onConfirm={() => void clearData()}
              />
            ) : (
              <>
                <Action label="Reload" ariaLabel="Reload page" onClick={reload} />
                <Action label="Clear all site data" danger onClick={() => setConfirming('data')} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ConnectionCard({ info, url }: { info: SiteInfo | null; url: string }): JSX.Element {
  const site = describeSite(url)
  const state = info?.security.state ?? site.state
  const cert = info?.security.certificate ?? null
  const mixed = info?.security.mixedContent === true
  const secure = state === 'secure' && !mixed
  const headline =
    state === 'secure'
      ? mixed
        ? 'Partly secure'
        : 'Secure connection'
      : state === 'insecure'
        ? 'Not secure'
        : state === 'local'
          ? 'Local page'
          : state === 'internal'
            ? 'Zenium page'
            : 'Connection unknown'
  const detail =
    state === 'secure'
      ? mixed
        ? 'The page is encrypted, but some of what it loaded came over a plain connection.'
        : 'Everything you send to this site is encrypted on the way.'
      : state === 'insecure'
        ? 'What you send to this site can be read by anyone along the way.'
        : state === 'local'
          ? 'Served from this device; nothing crosses the network.'
          : state === 'internal'
            ? 'Built into the browser; no site is involved.'
            : ''
  return (
    <div className="zen-sheet-card flex flex-col gap-2 p-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'zen-sheet-badge mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center',
            secure && 'zen-sheet-badge-secure',
            (state === 'insecure' || mixed) && 'zen-sheet-badge-warn'
          )}
        >
          {state === 'insecure' || mixed ? (
            <LockOpen className="h-4 w-4" />
          ) : (
            <Lock className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold leading-snug">{headline}</div>
          {detail && (
            <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--zen-muted)]">
              {detail}
            </div>
          )}
        </div>
      </div>
      {cert && (
        <div className="flex flex-col pl-11">
          <Row label="Issued to" value={cert.subject || '—'} />
          <Row label="Issued by" value={cert.issuer || '—'} />
          {cert.validTo !== null && <Row label="Expires" value={formatDate(cert.validTo)} />}
          {cert.protocol && <Row label="Protocol" value={cert.protocol} />}
        </div>
      )}
    </div>
  )
}

function StorageRows({ info }: { info: SiteInfo }): JSX.Element {
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
  if (rows.length === 0) return <Quiet>This site has not stored any data.</Quiet>
  return (
    <div className="flex flex-col">
      {rows.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
      ))}
      {s.origins.length > 1 && (
        <div className="mt-1 text-[12px] leading-relaxed text-[var(--zen-muted)]">
          {s.origins.map((o) => o.replace(/^https?:\/\//, '')).join(', ')}
        </div>
      )}
    </div>
  )
}

function CookieRow({ cookie }: { cookie: SiteCookie }): JSX.Element {
  const attrs: string[] = []
  if (cookie.domain) attrs.push(cookie.domain.replace(/^\./, ''))
  if (cookie.secure) attrs.push('Secure')
  if (cookie.httpOnly) attrs.push('HttpOnly')
  if (cookie.session) attrs.push('Session')
  return (
    <div className="flex h-8 items-center gap-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
        {cookie.name || '(unnamed)'}
      </span>
      <span className="shrink-0 truncate text-[11.5px] text-[var(--zen-muted)]">
        {attrs.join(' · ')}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Primitives of the sheet: cards for information, full-width actions between them
// ---------------------------------------------------------------------------

function Card({
  title,
  value,
  children
}: {
  title: string
  value?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  return (
    <section className="zen-sheet-card flex flex-col gap-1 p-3">
      <header className="flex h-6 items-center gap-3">
        <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--zen-muted)]">
          {title}
        </h3>
        {value !== undefined && value !== null && (
          <div className="shrink-0 text-[14px] font-semibold">{value}</div>
        )}
      </header>
      {children}
    </section>
  )
}

function Row({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex h-8 items-center gap-3">
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[13px]',
          mono ? 'font-mono text-[12.5px]' : 'text-[var(--zen-muted)]'
        )}
      >
        {label}
      </span>
      <span className="max-w-[60%] shrink-0 truncate text-right text-[13px]">{value}</span>
    </div>
  )
}

function Quiet({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="py-1 text-[13px] text-[var(--zen-muted)]">{children}</div>
}

function TextButton({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'zen-sheet-text-button h-8 shrink-0 self-start px-1 text-[13px] font-medium text-[var(--zen-accent)] disabled:opacity-40',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

function Action({
  label,
  ariaLabel,
  danger,
  onClick
}: {
  label: string
  ariaLabel?: string
  danger?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-sheet-action flex h-12 min-w-0 flex-1 items-center justify-center px-4 text-[14px] font-medium"
      data-danger={danger || undefined}
      aria-label={ariaLabel ?? label}
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
    </button>
  )
}

/** A destructive action asks once, inline, where the button was. */
function Confirm({
  message,
  action,
  actionLabel,
  busy,
  onCancel,
  onConfirm
}: {
  message: string
  action: string
  actionLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="zen-sheet-confirm zen-animate-fade flex w-full flex-col gap-2 p-2">
      <div className="px-2 pt-1.5 text-[13px] leading-snug">{message}</div>
      <div className="flex gap-2">
        <button
          type="button"
          className="zen-sheet-action zen-sheet-action-inner flex h-11 flex-1 items-center justify-center text-[14px] font-medium"
          aria-label="Cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="zen-sheet-action zen-sheet-action-inner flex h-11 flex-1 items-center justify-center text-[14px] font-medium"
          data-danger
          aria-label={actionLabel}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : action}
        </button>
      </div>
    </div>
  )
}

function items(n: number): string {
  return `${n} item${n === 1 ? '' : 's'}`
}

/** Anything beyond quota-managed storage: Web Storage items or service workers. */
function storesAnything(info: SiteInfo): boolean {
  const s = info.storage
  return (
    (s.localStorageItems ?? 0) > 0 ||
    (s.sessionStorageItems ?? 0) > 0 ||
    (s.serviceWorkers ?? 0) > 0 ||
    s.origins.length > 0
  )
}

function formatDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(ms))
  } catch {
    return new Date(ms).toDateString()
  }
}
