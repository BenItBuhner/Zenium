import type { JSX, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bell,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clapperboard,
  ClipboardPaste,
  Cookie,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  LockOpen,
  MapPin,
  Mic,
  Music2,
  Puzzle,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import {
  certificateErrorDetail,
  cookieBytes,
  describeSite,
  formatBytes,
  permissionLabel,
  refusedCertificate,
  securityIndicator,
  type IndicatorState,
  type SiteCertificate,
  type SiteCookie,
  type SiteDescription,
  type SiteInfo
} from '@shared/siteInfo'
import { describeNetError } from '@shared/zenPages'
import { cmd } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { manageExtension } from '@renderer/lib/extensions/manage'
import {
  extensionPageChrome,
  extensionPageLine,
  type ExtensionPageChrome
} from '@renderer/lib/extensions/pages'
import { useViewport } from '@renderer/lib/formFactor'
import { LevelMotion, type LevelState } from '@renderer/lib/motion/levels'
import { openSettings as openSettingsPage } from '@renderer/lib/pages'
import { useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import {
  dismissSiteInfo,
  refreshSiteInfo,
  registerSiteInfoSurface,
  siteInfoDismissed,
  siteInfoStore,
  stepBackSiteInfo
} from '@renderer/lib/siteInfo'
import {
  browserStore,
  closeSiteDataConfirm,
  overlayAvailable,
  pushToast,
  uiStore,
  type UiState
} from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useEscapeTrap } from '../bookmarks/escape'
import { focusAnchor, wrapTab } from '../bookmarks/popover'
import { pillChipRows, type PillChipModel, type PillChipRow } from '../phone/pillChips'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { Favicon } from '../sidebar/Favicon'
import { SiteInfoDesktopLayer } from '../siteControls/SiteInfoPopover'

/** Cookies listed before the list folds. */
const COOKIE_FOLD = 6

type LevelId = 'main' | 'connection' | 'cookies' | 'permissions'
const LEVEL_TITLES: Record<Exclude<LevelId, 'main'>, string> = {
  connection: 'Connection',
  cookies: 'Cookies and site data',
  permissions: 'Permissions'
}

/**
 * Site information: what the browser knows about the site a tab is on – the connection and its
 * certificate, cookies and stored data, permissions – with the actions to take them away again.
 * Opens from the site icon in the address pill: on phones a sheet on the shared `BottomSheet`
 * chassis (this file), on a mouse the §9.20 popover under the pill on `siteInfo.snapshot`
 * (`siteControls/SiteInfoPopover`). Rows lead into levels (certificate, cookies, permissions)
 * that push in and pop back on a spring; the system back gesture pops a level before it
 * dismisses the sheet. Mounted once above whichever shell is up.
 */
export function SiteInfoLayer(): JSX.Element | null {
  const tabId = siteInfoStore.use((s) => s.tabId)
  const state = browserStore.use((s) => s.state)
  const viewport = useViewport()
  const tab = tabId && state ? state.tabs[tabId] : undefined
  const phone = viewport.formFactor === 'phone'
  // The tab closed underneath the sheet (the desktop popover plays its exit first).
  useEffect(() => {
    if (phone && tabId && !tab) dismissSiteInfo()
  }, [phone, tabId, tab])
  if (!state) return null
  if (!phone) return <SiteInfoDesktopLayer state={state} />
  if (!tab) return null
  return <PhoneSheet key={tab.id} tab={tab} state={state} />
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
// Security, as words: the pill's real state (#124) and the certificate exception (#136)
// ---------------------------------------------------------------------------

type Tone = 'ok' | 'warn' | 'danger' | 'neutral'

interface Security {
  indicator: IndicatorState
  tone: Tone
  /** A word or two for a row's value: "Secure", "Not secure". */
  short: string
  /** The headline of the connection level. */
  headline: string
  /** The sentence under it. */
  detail: string
  /** The certificate to list: the page's, or the one that was refused. */
  certificate: SiteCertificate | null
  /** The certificate failed verification and the connection reports as not secure. */
  certificateError: boolean
}

function securityOf(tab: Tab, info: SiteInfo | null, site: SiteDescription): Security {
  const error = info?.security.certificateError ?? tab.certificateError ?? null
  const indicator = securityIndicator(tab.url, tab.errorCode, error).state
  const mixed = info?.security.mixedContent === true
  const cert = info?.security.certificate ?? (error ? refusedCertificate(error) : null)
  switch (indicator) {
    case 'secure':
      return mixed
        ? {
            indicator,
            tone: 'warn',
            short: 'Partly secure',
            headline: 'Connection is partly secure',
            detail:
              'The page is encrypted, but some of what it loaded came over a plain connection.',
            certificate: cert,
            certificateError: false
          }
        : {
            indicator,
            tone: 'ok',
            short: 'Secure',
            headline: 'Connection is secure',
            detail: 'Everything you send to this site is encrypted on the way.',
            certificate: cert,
            certificateError: false
          }
    case 'certificate-error':
      return {
        indicator,
        tone: 'danger',
        short: 'Not secure',
        headline: 'Connection is not secure',
        detail: error
          ? `${certificateErrorDetail(error)} ${describeNetError(error.code, '')}`.trim()
          : 'The certificate this site sent could not be verified.',
        certificate: cert,
        certificateError: true
      }
    case 'dangerous':
      return {
        indicator,
        tone: 'danger',
        short: 'Dangerous',
        headline: 'Dangerous site',
        detail:
          'Safe Browsing found this site to be dangerous and blocked the page. Attackers here might try to steal your information.',
        certificate: null,
        certificateError: false
      }
    case 'insecure':
      return {
        indicator,
        tone: 'warn',
        short: 'Not secure',
        headline: 'Connection is not secure',
        detail: 'What you send to this site can be read by anyone along the way.',
        certificate: null,
        certificateError: false
      }
    case 'local':
      return {
        indicator,
        tone: 'neutral',
        short: site.scheme === 'file' ? 'Local file' : 'Local',
        headline: site.scheme === 'file' ? 'Local file' : 'Local site',
        detail: 'Served from this device; nothing crosses the network.',
        certificate: null,
        certificateError: false
      }
    case 'extension':
      return {
        indicator,
        tone: 'neutral',
        short: 'Extension page',
        headline: 'Extension page',
        detail: 'A page of an installed extension; no site is involved.',
        certificate: null,
        certificateError: false
      }
    case 'internal':
      return {
        indicator,
        tone: 'neutral',
        short: tab.errorCode !== null ? 'Not loaded' : 'Zenium page',
        headline: tab.errorCode !== null ? 'The page could not be loaded' : 'Part of Zenium',
        detail:
          tab.errorCode !== null
            ? describeNetError(tab.errorCode, 'The page could not be loaded.')
            : 'Built into the browser; no site is involved.',
        certificate: null,
        certificateError: false
      }
    default:
      return {
        indicator,
        tone: 'neutral',
        short: '',
        headline: 'Connection',
        detail: '',
        certificate: null,
        certificateError: false
      }
  }
}

/** The connection's glyph: a shield for a dangerous site, a puzzle piece for an extension's page, a globe off the web, else the lock. */
function securityGlyph(
  security: Security,
  props: { className?: string; strokeWidth?: number } = {}
): JSX.Element {
  if (security.indicator === 'dangerous') return <ShieldAlert {...props} aria-hidden />
  if (security.indicator === 'extension') return <Puzzle {...props} aria-hidden />
  if (security.indicator === 'internal' || security.indicator === 'local')
    return <Globe {...props} aria-hidden />
  return security.tone === 'ok' ? (
    <Lock {...props} aria-hidden />
  ) : (
    <LockOpen {...props} aria-hidden />
  )
}

function toneClass(tone: Tone): string | false {
  return (
    (tone === 'ok' && 'text-[var(--v2-ok)]') ||
    (tone === 'warn' && 'text-[var(--v2-warn)]') ||
    (tone === 'danger' && 'text-[var(--v2-danger)]')
  )
}

/** A permission's glyph, from the catalogue the browser prompts for. */
function permissionGlyph(permission: string, props: { className?: string } = {}): JSX.Element {
  const Icon = PERMISSION_ICONS[permission] ?? ShieldCheck
  return <Icon {...props} aria-hidden />
}

const PERMISSION_ICONS: Record<string, LucideIcon> = {
  camera: Camera,
  microphone: Mic,
  media: Camera,
  geolocation: MapPin,
  notifications: Bell,
  midi: Music2,
  'clipboard-read': ClipboardPaste,
  openExternal: ExternalLink,
  mediaKeySystem: Clapperboard
}

function isPrivateTab(tab: Tab, state: UIState): boolean {
  return tab.containerId === PRIVATE_CONTAINER_ID || state.window.kind === 'private'
}

// ---------------------------------------------------------------------------
// Levels: one spring, two panes at a time
// ---------------------------------------------------------------------------

interface Levels {
  motion: LevelMotion
  /** Discrete state (stack, direction, phase); `t` is read from `motion.current` per frame. */
  state: LevelState
  level: LevelId
  /** Called on every frame of the motion, after `motion.current` is updated. */
  onFrame: (listener: () => void) => () => void
}

function useLevels(): Levels {
  const [state, setState] = useState<LevelState | null>(null)
  const engine = useMemo(() => {
    const listeners = new Set<() => void>()
    const motion = new LevelMotion('main', (s) => {
      for (const l of listeners) l()
      // Only a discrete change re-renders; the frames of `t` are painted directly.
      setState((prev) =>
        prev &&
        prev.stack === s.stack &&
        prev.from === s.from &&
        prev.to === s.to &&
        prev.phase === s.phase
          ? prev
          : s
      )
    })
    return { motion, listeners }
  }, [])
  const { motion } = engine
  useEffect(() => () => motion.dispose(), [motion])
  const onFrame = useCallback(
    (listener: () => void) => {
      engine.listeners.add(listener)
      return () => {
        engine.listeners.delete(listener)
      }
    },
    [engine]
  )
  const current = state ?? motion.current
  // The level the surface shows or is heading to: the target of a push, the parent of a pop.
  const level = current.to as LevelId
  return { motion, state: current, level, onFrame }
}

/**
 * Paints one frame of the level motion onto the panes: the pane arriving is in flow and sizes
 * the track; the pane leaving is laid over it and slides out; the deeper of the two travels the
 * full width from the trailing edge, the one under it shifts by a third and fades.
 */
function paintLevels(motion: LevelMotion, panes: Map<string, HTMLElement>, width: number): void {
  const { from, to, t } = motion.current
  for (const [id, el] of panes) {
    const arriving = id === to
    const leaving = id === from && from !== to
    if (!arriving && !leaving) {
      el.style.display = 'none'
      el.removeAttribute('data-leaving')
      continue
    }
    el.style.display = ''
    if (leaving) el.setAttribute('data-leaving', '')
    else el.removeAttribute('data-leaving')
    const shown = arriving ? t : 1 - t
    const pushing = motion.pushing
    const deeper = pushing ? arriving : leaving
    const x = from === to ? 0 : deeper ? (1 - shown) * width : -0.3 * (1 - shown) * width
    el.style.transform = x ? `translate3d(${x.toFixed(2)}px, 0, 0)` : ''
    el.style.opacity = from === to ? '' : String(Math.min(1, Math.max(0, (shown - 0.2) / 0.6)))
    el.style.willChange = from === to ? '' : 'transform, opacity'
    const hidden = shown < 0.5
    if (el.getAttribute('aria-hidden') !== String(hidden))
      el.setAttribute('aria-hidden', String(hidden))
  }
}

function usePaneRegistry(): {
  panes: Map<string, HTMLElement>
  register: (id: LevelId) => (el: HTMLElement | null) => void
} {
  const panes = useMemo(() => new Map<string, HTMLElement>(), [])
  const register = useCallback(
    (id: LevelId) => (el: HTMLElement | null) => {
      if (el) panes.set(id, el)
      else panes.delete(id)
    },
    [panes]
  )
  return { panes, register }
}

// ---------------------------------------------------------------------------
// Phone: a sheet on the chassis
// ---------------------------------------------------------------------------

function PhoneSheet({ tab, state }: { tab: Tab; state: UIState }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const { info, loading } = useSiteInfo(tab)
  const levels = useLevels()
  const { panes, register } = usePaneRegistry()
  const [confirm, setConfirm] = useState<'cookies' | 'data' | null>(null)
  const confirmRef = useRef(confirm)
  useEffect(() => {
    confirmRef.current = confirm
  }, [confirm])
  const [allCookies, setAllCookies] = useState(false)

  const paint = useCallback((): void => {
    const track = trackRef.current
    if (!track) return
    paintLevels(levels.motion, panes, track.offsetWidth)
  }, [levels.motion, panes])
  useLayoutEffect(paint)
  useEffect(() => levels.onFrame(paint), [levels, paint])

  // What this module needs of the mounted surface: the chassis owns the sheet's motion, the
  // component its levels. The back gesture peeks and pops a level; on the root it pulls the
  // sheet down through the chassis, as every other sheet's does.
  useEffect(() => {
    const { motion } = levels
    registerSiteInfoSurface({
      depth: () => motion.depth,
      pop: () => {
        motion.pop()
      },
      dismiss: () => sheet.current?.dismiss(),
      backProgress: (p) => {
        if (motion.depth > 0) motion.backProgress(p)
        else sheet.current?.backProgress(p)
      },
      backCommit: () => {
        if (motion.depth > 0) {
          if (motion.current.phase === 'back') motion.backCommit()
          else motion.pop()
        } else sheet.current?.commitBack()
      },
      backCancel: () => {
        if (motion.depth > 0) motion.backCancel()
        else sheet.current?.cancelBack()
      }
    })
    return () => registerSiteInfoSurface(null)
  }, [levels])

  // Escape (hardware keyboards exist on tablets): one level up, or away. A confirmation sheet
  // stacked on this one answers its own Escape first (§9.24).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || confirmRef.current) return
      e.preventDefault()
      e.stopImmediatePropagation()
      stepBackSiteInfo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const site = describeSite(tab.url)
  const security = securityOf(tab, info, site)
  const actions = useActions(tab, site)
  // A page of an extension (v2 §10.1 applied to extension pages): the sheet says whose page it
  // is and leads to the extension's details in Settings, in place of the site's rows.
  const extension =
    site.state === 'extension' ? extensionPageChrome(tab.url, state.extensions) : null
  const level = levels.level
  const push = (id: LevelId): void => levels.motion.push(id)
  const pop = (): void => {
    levels.motion.pop()
  }
  const cookies = info?.cookies.items ?? []
  // The chips the phone pill keeps out of the pill (OMN-02, v2 §9.29): the blocking shield with
  // its count and the translate offer are this sheet's rows, always, at its top, with the same
  // names, states and actions the chips had, and a live state chip waits here as a row while a
  // newer state has the pill's slot (`components/phone/pillChips.tsx`).
  const mediaSheetOpen = uiStore.use((s) => s.mediaSheet !== null)
  const pillChips = extension
    ? []
    : pillChipRows(state, tab, {
        siteInfoOpen: true,
        mediaSheetOpen,
        activeTabId: activeTab(state)?.id ?? null
      })
  // The chassis measures its detents again when this changes: a level, the reading arriving,
  // or the pill's rows changing under it.
  const contentKey = `${tab.id}:${level}:${info ? 'ready' : 'reading'}:${allCookies ? 'all' : 'fold'}:${pillChips.length}`

  return (
    <>
      <BottomSheet
        ref={sheet}
        onDismissed={() => siteInfoDismissed()}
        contentKey={contentKey}
        handleLabel="Dismiss"
        // The dialog's name as TalkBack opens it (A11Y-01): what the sheet is and whose, then the
        // level's title once the sheet has drilled into one (the root pane stays in the track, so
        // the name is composed rather than pointed at a title element).
        label={
          level === 'main'
            ? `Site information for ${sheetTitleOf(site, extension)}`
            : LEVEL_TITLES[level]
        }
        header={
          level !== 'main' ? (
            <>
              <button
                type="button"
                className="zen-sheet-header-control"
                data-side="leading"
                onClick={pop}
                aria-label="Back to site information"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden />
              </button>
              <h2 className="zen-sheet-title">{LEVEL_TITLES[level]}</h2>
            </>
          ) : undefined
        }
      >
        <div ref={trackRef} className="zen-sheet-track">
          <section ref={register('main')} className="zen-sheet-pane" data-level="main">
            <SheetTitle
              tab={tab}
              state={state}
              site={site}
              security={security}
              extension={extension}
            />
            {extension ? (
              <div className="flex flex-col pb-2">
                <SheetRow
                  glyph={<Puzzle />}
                  label={extension.extension ? 'Manage extension' : 'Manage extensions'}
                  onClick={() => {
                    dismissSiteInfo()
                    manageExtension(extension.id, tab.id)
                  }}
                />
              </div>
            ) : (
              <PillChipRows chips={pillChips} />
            )}
            {!extension && (
              <SheetMainRows
                site={site}
                security={security}
                info={info}
                loading={loading}
                push={push}
                onSettings={() => actions.openSettings()}
                onClear={() => setConfirm('data')}
              />
            )}
          </section>
          <section ref={register('connection')} className="zen-sheet-pane" data-level="connection">
            <ConnectionRows security={security} kit={SHEET_ROWS} />
          </section>
          <section ref={register('cookies')} className="zen-sheet-pane" data-level="cookies">
            <CookieRows
              info={info}
              site={site}
              all={allCookies}
              onToggleAll={() => setAllCookies((v) => !v)}
              kit={SHEET_ROWS}
            />
            {cookies.length > 0 && (
              <>
                <div aria-hidden className="zen-sheet-sep" />
                <button
                  type="button"
                  className="zen-sheet-item"
                  data-danger
                  aria-busy={actions.busy === 'cookies' || undefined}
                  onClick={() => setConfirm('cookies')}
                >
                  <span className="zen-sheet-item-glyph" data-tone="danger">
                    <Trash2 />
                  </span>
                  <span className="min-w-0 flex-1 truncate">Clear cookies</span>
                </button>
              </>
            )}
          </section>
          <section
            ref={register('permissions')}
            className="zen-sheet-pane"
            data-level="permissions"
          >
            <PermissionRows
              info={info}
              busy={actions.busy}
              onReset={actions.resetPermission}
              kit={SHEET_ROWS}
            />
          </section>
        </div>
      </BottomSheet>
      {confirm && (
        <ConfirmSheet
          kind={confirm}
          site={site.site || site.host}
          count={cookies.length}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null)
            if (confirm === 'cookies') await actions.clearCookies()
            else await actions.clearData()
          }}
        />
      )}
    </>
  )
}

/**
 * The sheet opens on a title block (§9.23): the favicon on the host's start, the connection
 * under it. An extension's page names no host: the block says whose page it is.
 */
/** The sheet's title: the site's host, an extension page's kind, or the browser's own name. */
function sheetTitleOf(site: SiteDescription, extension: ExtensionPageChrome | null): string {
  return extension ? 'Extension page' : site.web ? site.host.replace(/^www\./, '') : 'Zenium'
}

function SheetTitle({
  tab,
  state,
  site,
  security,
  extension
}: {
  tab: Tab
  state: UIState
  site: SiteDescription
  security: Security
  extension: ExtensionPageChrome | null
}): JSX.Element {
  const title = sheetTitleOf(site, extension)
  const container =
    tab.containerId !== DEFAULT_CONTAINER_ID && tab.containerId !== PRIVATE_CONTAINER_ID
      ? state.containers.find((c) => c.id === tab.containerId)?.name
      : undefined
  const line = [
    extension ? extensionPageLine(extension) : security.short,
    security.certificate?.issuer || null,
    container
  ].filter((p): p is string => Boolean(p))
  return (
    <div className="zen-sheet-title-block">
      <h2>
        <Favicon tab={tab} size={20} />
        <span className="min-w-0 truncate">{title}</span>
        {isPrivateTab(tab, state) && <span className="zen-v2-badge">Private</span>}
      </h2>
      {line.length > 0 && (
        <p className="flex items-center gap-1.5">
          {securityGlyph(security, {
            className: cn('h-4 w-4 shrink-0', toneClass(security.tone)),
            strokeWidth: 1.75
          })}
          <span className="min-w-0 truncate">{line.join(' · ')}</span>
        </p>
      )}
    </div>
  )
}

/**
 * What the phone pill carries only here (OMN-02; v2 §9.29 as amended on Bennett's ruling: the
 * pill shows the favicon, the host and the lock, nothing else): a rows group at the top of the
 * root level, over a hairline, one chassis row per chip with the chip's name, its state as the
 * value and its action – the shield row carries the blocked count and leads on to the blocking
 * lists in Settings, the translate row still offers (the sheet leaves for the bar), a media row
 * waiting behind a newer state opens the player – so nothing is lost, only moved. No heading:
 * the rows name themselves. Nothing on a page with neither.
 */
function PillChipRows({
  chips
}: {
  chips: ReadonlyArray<PillChipModel & { row: PillChipRow }>
}): JSX.Element | null {
  if (chips.length === 0) return null
  return (
    <div className="flex flex-col" data-testid="siteinfo-pill-chips">
      {chips.map((chip) => (
        <SheetRow
          key={chip.id}
          glyph={chip.row.glyph}
          label={chip.row.label}
          value={chip.row.value}
          onClick={chip.row.activate}
        />
      ))}
      <div aria-hidden className="zen-sheet-sep" />
    </div>
  )
}

/** The four rows of the root level, and the two actions under a hairline. */
function SheetMainRows({
  site,
  security,
  info,
  loading,
  push,
  onSettings,
  onClear
}: {
  site: SiteDescription
  security: Security
  info: SiteInfo | null
  loading: boolean
  push: (id: LevelId) => void
  onSettings: () => void
  onClear: () => void
}): JSX.Element {
  const reading = loading && !info
  const cookies = info?.cookies.items ?? []
  const permissions = info?.permissions ?? []
  const hasData = info ? cookies.length > 0 || storesAnything(info) : false
  return (
    <div className="flex flex-col pb-2">
      <SheetRow
        glyph={securityGlyph(security)}
        tone={security.tone}
        label="Connection"
        value={security.short || undefined}
        valueTone={security.tone === 'warn' || security.tone === 'danger' ? 'warn' : undefined}
        onClick={security.detail ? () => push('connection') : undefined}
      />
      {site.web && (
        <>
          <SheetRow
            glyph={<Cookie />}
            label="Cookies and site data"
            value={info ? summariseData(info) : reading ? 'Reading…' : undefined}
            onClick={hasData ? () => push('cookies') : undefined}
          />
          <SheetRow
            glyph={<ShieldCheck />}
            label="Permissions"
            value={
              info
                ? permissions.length
                  ? permissions.map((p) => permissionLabel(p.permission)).join(', ')
                  : 'None asked for'
                : reading
                  ? 'Reading…'
                  : undefined
            }
            onClick={permissions.length ? () => push('permissions') : undefined}
          />
          <div aria-hidden className="zen-sheet-sep" />
          <SheetRow glyph={<Settings />} label="Site settings" onClick={onSettings} />
          <button
            type="button"
            className="zen-sheet-item"
            data-danger
            disabled={!hasData && permissions.length === 0}
            onClick={onClear}
          >
            <span className="zen-sheet-item-glyph" data-tone="danger">
              <Trash2 />
            </span>
            <span className="min-w-0 flex-1 truncate">Clear site data</span>
          </button>
        </>
      )}
      {!site.web && permissions.length > 0 && (
        <SheetRow
          glyph={<ShieldCheck />}
          label="Permissions"
          value={permissions.map((p) => permissionLabel(p.permission)).join(', ')}
          onClick={() => push('permissions')}
        />
      )}
    </div>
  )
}

/** A chassis row (§9.2, §9.18): 44 tall, glyph 20, label 15, a 13/69% value, a chevron when it leads on. */
function SheetRow({
  glyph,
  tone,
  label,
  description,
  value,
  valueTone,
  control,
  danger,
  disabled,
  onClick
}: {
  glyph?: ReactNode
  tone?: Tone
  label: string
  description?: string
  value?: string
  valueTone?: 'warn'
  control?: ReactNode
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
}): JSX.Element {
  const body = (
    <>
      {glyph && (
        <span className="zen-sheet-item-glyph" data-tone={tone}>
          {glyph}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description && (
          <span className="zen-sheet-item-secondary block text-[13px] leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
            {description}
          </span>
        )}
      </span>
      {value && (
        <span className="zen-sheet-item-value" data-tone={valueTone}>
          {value}
        </span>
      )}
      {control}
      {onClick && !control && (
        <ChevronRight className="zen-sheet-item-secondary h-5 w-5 shrink-0" strokeWidth={1.75} />
      )}
    </>
  )
  const className = cn(
    'zen-sheet-item',
    description && 'zen-sheet-item-two-line',
    control && 'zen-sheet-item-control'
  )
  if (onClick)
    return (
      <button
        type="button"
        className={className}
        data-danger={danger || undefined}
        disabled={disabled}
        // The row's name is its label and its value, read as two parts ("Connection, Secure").
        aria-label={value ? `${label}, ${value}` : label}
        onClick={onClick}
      >
        {body}
      </button>
    )
  return (
    <div className={className} data-danger={danger || undefined}>
      {body}
    </div>
  )
}

function SheetHeading({ title, aside }: { title: string; aside?: string }): JSX.Element {
  return (
    <h3 className="zen-sheet-heading">
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {aside && <span className="zen-sheet-item-value">{aside}</span>}
    </h3>
  )
}

/**
 * "Clear site data?" on a phone: a sheet over the sheet (§9.24) – a title block with the
 * question and what it does, then the two actions splitting the footer (§9.11). Portalled next
 * to the site-information layer so it stacks above it; the chassis recedes the sheet beneath.
 */
function ConfirmSheet({
  kind,
  site,
  count,
  onCancel,
  onConfirm
}: {
  kind: 'cookies' | 'data'
  site: string
  count: number
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const decided = useRef(false)
  useBackSurface({
    name: 'site-info-confirm',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      sheet.current?.dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const words = confirmWords(kind, site, count)
  return createPortal(
    <BottomSheet
      ref={sheet}
      onDismissed={() => {
        if (!decided.current) onCancel()
      }}
      contentKey={`site-info-confirm:${kind}`}
      handleLabel="Dismiss"
      label={words.title}
    >
      <div className="zen-sheet-title-block">
        <h2>
          <Trash2 className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 truncate">{words.title}</span>
        </h2>
        <p>{words.detail}</p>
      </div>
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
          Cancel
        </button>
        <button
          type="button"
          className="zen-v2-button"
          data-danger
          aria-label={words.confirmLabel}
          onClick={() => {
            decided.current = true
            // The sheet leaves first; the action runs once it is gone, then the reading refreshes.
            sheet.current?.dismiss(() => void onConfirm())
          }}
        >
          {words.action}
        </button>
      </div>
    </BottomSheet>,
    document.body
  )
}

function confirmWords(
  kind: 'cookies' | 'data',
  site: string,
  count: number
): { title: string; detail: string; action: string; confirmLabel: string } {
  const where = site || 'this site'
  return kind === 'cookies'
    ? {
        title: 'Clear cookies?',
        detail: `Removes ${count} cookie${count === 1 ? '' : 's'} and signs you out of ${where}.`,
        action: 'Clear cookies',
        confirmLabel: 'Confirm clear cookies'
      }
    : {
        title: 'Clear site data?',
        detail: `Removes the cookies, stored data and permissions of ${where}, then reloads the page.`,
        action: 'Clear site data',
        confirmLabel: 'Confirm clear all site data'
      }
}

// ---------------------------------------------------------------------------
// The levels' rows, shared by both surfaces
// ---------------------------------------------------------------------------

/** The two row vocabularies, one per surface: the chassis row on a phone, the popover row on a mouse. */
interface RowKit {
  Row: typeof SheetRow
  Heading: typeof SheetHeading
  phone?: boolean
}
const SHEET_ROWS: RowKit = { Row: SheetRow, Heading: SheetHeading, phone: true }

/** The connection and its certificate: the state as a two-line row, then the certificate's fields. */
function ConnectionRows({ security, kit }: { security: Security; kit: RowKit }): JSX.Element {
  const { Row, Heading, phone } = kit
  const cert = security.certificate
  return (
    <div className={cn('flex flex-col', phone && 'pb-2')}>
      <Row
        glyph={securityGlyph(security)}
        tone={security.tone}
        label={security.headline}
        description={security.detail}
      />
      {cert && (
        <>
          <Heading
            title={security.certificateError ? 'Certificate that was refused' : 'Certificate'}
          />
          <Row label="Issued to" value={cert.subject || '—'} />
          <Row label="Issued by" value={cert.issuer || '—'} />
          {cert.validFrom !== null && <Row label="Valid from" value={formatDate(cert.validFrom)} />}
          {cert.validTo !== null && <Row label="Valid until" value={formatDate(cert.validTo)} />}
          {cert.protocol && <Row label="Protocol" value={cert.protocol} />}
        </>
      )}
    </div>
  )
}

/** Every cookie of the site, the sites embedded in it, and what else it stored. */
function CookieRows({
  info,
  site,
  all,
  onToggleAll,
  kit
}: {
  info: SiteInfo | null
  site: SiteDescription
  all: boolean
  onToggleAll: () => void
  kit: RowKit
}): JSX.Element {
  const { Row, Heading, phone } = kit
  const cookies = info?.cookies.items ?? []
  const shown = all ? cookies : cookies.slice(0, COOKIE_FOLD)
  const thirdParty = info?.cookies.thirdParty ?? []
  const foldClass = phone ? 'zen-sheet-item-secondary h-5 w-5 shrink-0' : 'zen-siteinfo-chevron'
  return (
    <div className={cn('flex flex-col', phone && 'pb-2')}>
      <Heading
        title="Cookies"
        aside={
          info && cookies.length > 0
            ? `${cookies.length} · ${formatBytes(cookieBytes(cookies))}`
            : undefined
        }
      />
      {info && cookies.length === 0 && (
        <p className={phone ? 'zen-sheet-empty' : 'zen-siteinfo-empty'}>
          This site has not stored any cookies
        </p>
      )}
      {shown.map((c, i) => (
        <CookieRow key={`${c.name}|${c.domain}|${i}`} cookie={c} site={site.site} Row={Row} />
      ))}
      {cookies.length > COOKIE_FOLD && (
        <Row
          label={all ? 'Show fewer' : `Show all ${cookies.length}`}
          control={
            all ? (
              <ChevronUp className={foldClass} strokeWidth={phone ? 1.75 : 1.5} />
            ) : (
              <ChevronDown className={foldClass} strokeWidth={phone ? 1.75 : 1.5} />
            )
          }
          onClick={onToggleAll}
        />
      )}
      {thirdParty.length > 0 && (
        <>
          <Heading title="Also set by embedded sites" />
          {thirdParty.map((t) => (
            <Row key={t.site} label={t.site} value={String(t.count)} />
          ))}
        </>
      )}
      {info && <StorageRows info={info} Row={Row} Heading={Heading} />}
    </div>
  )
}

/** A cookie: its name, the flags that set it apart as a description, and its size. */
function CookieRow({
  cookie,
  site,
  Row
}: {
  cookie: SiteCookie
  site: string
  Row: typeof SheetRow
}): JSX.Element {
  const attrs: string[] = []
  const domain = cookie.domain.replace(/^\./, '')
  if (domain && domain !== site) attrs.push(domain)
  if (cookie.secure) attrs.push('Secure')
  if (cookie.httpOnly) attrs.push('HttpOnly')
  if (cookie.session) attrs.push('Session')
  return (
    <Row
      label={cookie.name || '(unnamed)'}
      description={attrs.length ? attrs.join(' · ') : undefined}
      value={cookie.size > 0 ? formatBytes(cookie.size) : undefined}
    />
  )
}

function StorageRows({
  info,
  Row,
  Heading
}: {
  info: SiteInfo
  Row: typeof SheetRow
  Heading: typeof SheetHeading
}): JSX.Element | null {
  const s = info.storage
  const rows: Array<[string, string]> = []
  if (s.usageBytes !== null && s.usageBytes > 0)
    rows.push(['Storage used', formatBytes(s.usageBytes)])
  if (s.localStorageItems !== null && s.localStorageItems > 0)
    rows.push(['Local storage', items(s.localStorageItems)])
  if (s.sessionStorageItems !== null && s.sessionStorageItems > 0)
    rows.push(['Session storage', items(s.sessionStorageItems)])
  if (s.serviceWorkers !== null && s.serviceWorkers > 0)
    rows.push(['Service workers', String(s.serviceWorkers)])
  if (s.origins.length > 1) rows.push(['Origins with data', String(s.origins.length)])
  if (rows.length === 0) return null
  return (
    <>
      <Heading title="Site data" />
      {rows.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
      ))}
    </>
  )
}

/** What the site may do, each with a control to take it back (§9.11: an action inside a row). */
function PermissionRows({
  info,
  busy,
  onReset,
  kit
}: {
  info: SiteInfo | null
  busy: Busy
  onReset: (permission: string) => Promise<void>
  kit: RowKit
}): JSX.Element {
  const { Row, phone } = kit
  const permissions = info?.permissions ?? []
  return (
    <div className={cn('flex flex-col', phone && 'pb-2')}>
      {info && permissions.length === 0 && (
        <p className={phone ? 'zen-sheet-empty' : 'zen-siteinfo-empty'}>
          This site has not asked for any permissions
        </p>
      )}
      {permissions.map((p) => {
        const label = permissionLabel(p.permission)
        return (
          <Row
            key={p.permission}
            glyph={permissionGlyph(p.permission)}
            label={label}
            value={p.decision === 'allow' ? 'Allowed' : 'Blocked'}
            control={
              <button
                type="button"
                className={phone ? 'zen-v2-button' : 'zen-button'}
                aria-label={`Reset ${label} permission`}
                // Working (§9.30): full opacity, the label gives way to a spinner at the same width.
                aria-busy={busy === `permission:${p.permission}` || undefined}
                onClick={() => void onReset(p.permission)}
              >
                {busy === `permission:${p.permission}` ? (
                  <Loader2 className="zen-spin h-4 w-4" aria-hidden />
                ) : (
                  'Reset'
                )}
              </button>
            }
          />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Actions, and words for numbers
// ---------------------------------------------------------------------------

/** Which action is running, for the control that started it to show as busy (§9.30). */
type Busy = 'cookies' | 'data' | `permission:${string}` | null

function useActions(
  tab: Tab,
  site: SiteDescription
): {
  busy: Busy
  clearCookies: () => Promise<void>
  clearData: () => Promise<void>
  resetPermission: (permission?: string) => Promise<void>
  openSettings: () => void
} {
  const [busy, setBusy] = useState<Busy>(null)
  // Busy is not disabled (§9.30): the working control keeps its look and says so; a second press
  // while one action runs is simply ignored here.
  const act = async (key: NonNullable<Busy>, work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(key)
    try {
      await work()
    } catch {
      pushToast('That did not work. Try again.', 'error')
    } finally {
      setBusy(null)
    }
  }
  return {
    busy,
    clearCookies: () =>
      act('cookies', async () => {
        const { removed } = await cmd('site.clearCookies', { tabId: tab.id })
        pushToast(
          removed === 0
            ? 'No cookies to remove'
            : `Removed ${removed} cookie${removed === 1 ? '' : 's'}`
        )
        refreshSiteInfo()
      }),
    clearData: () =>
      act('data', async () => {
        await cmd('site.clearData', { tabId: tab.id })
        pushToast(`Cleared everything ${site.site || 'this site'} stored`)
        refreshSiteInfo()
      }),
    resetPermission: (permission?: string) =>
      act(`permission:${permission ?? '*'}`, async () => {
        await cmd('site.resetPermissions', { tabId: tab.id, permission })
        refreshSiteInfo()
      }),
    // Settings (§10): the site's settings live there; opening it replaces the sheet. Through the
    // one route for internal pages (lib/pages.ts): on a host with page tabs the Settings tab
    // comes up in place of this sheet, which leaves first; the desktop's overlay dismisses the
    // popover itself as it opens (lib/siteInfo.ts).
    openSettings: () => {
      if (!overlayAvailable('settings')) dismissSiteInfo()
      openSettingsPage()
    }
  }
}

/**
 * "Clear site data?" on a mouse: a frame dialog (§9.23, §9.5) over the page's picture, opened
 * from the popover, which the frame host closes as this comes up (§9.20, one popover at a time).
 * Rendered by `TabDialogs` inside its `FrameDialogHost`.
 */
export function SiteDataConfirmDialog({
  state,
  request
}: {
  state: UIState
  request: NonNullable<UiState['siteDataConfirm']>
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const tab = state.tabs[request.tabId]
  const words = confirmWords(request.kind, request.site, request.count)
  useEffect(() => {
    if (!tab) closeSiteDataConfirm()
  }, [tab])
  // Destructive: the keyboard starts on Cancel (§9.22); Escape and the scrim are Cancel too.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  useEscapeTrap(true, () => closeSiteDataConfirm())
  useBackSurface({ name: 'site-data-confirm', onCommit: () => closeSiteDataConfirm() })
  const confirm = async (): Promise<void> => {
    if (busy || !tab) return
    setBusy(true)
    try {
      if (request.kind === 'cookies') {
        const { removed } = await cmd('site.clearCookies', { tabId: tab.id })
        pushToast(
          removed === 0
            ? 'No cookies to remove'
            : `Removed ${removed} cookie${removed === 1 ? '' : 's'}`
        )
      } else {
        await cmd('site.clearData', { tabId: tab.id })
        pushToast(`Cleared everything ${request.site || 'this site'} stored`)
      }
    } catch {
      pushToast('That did not work. Try again.', 'error')
    } finally {
      setBusy(false)
      closeSiteDataConfirm()
      // The chip's next open reads the site again.
      refreshSiteInfo()
      focusAnchor('[data-site-info]')
    }
  }
  return (
    <FrameConfirm
      ref={dialogRef}
      title={words.title}
      detail={words.detail}
      action={words.action}
      actionLabel={words.confirmLabel}
      busy={busy}
      cancelRef={cancelRef}
      onCancel={() => closeSiteDataConfirm()}
      onConfirm={() => void confirm()}
    />
  )
}

/** A `--v2-dialog` prompt (§9.23): a title block with the question, then its two actions. */
function FrameConfirm({
  ref,
  title,
  detail,
  action,
  actionLabel,
  busy,
  cancelRef,
  onCancel,
  onConfirm
}: {
  ref: RefObject<HTMLDivElement | null>
  title: string
  detail: string
  action: string
  actionLabel: string
  busy: boolean
  cancelRef: RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  useFrameDialog({ onScrimPress: onCancel })
  const titleId = 'zen-site-data-confirm-title'
  const bodyId = 'zen-site-data-confirm-body'
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="zen-animate-pop zen-bm-dialog flex w-[400px] max-w-[calc(100%-24px)] flex-col"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') wrapTab(e, ref.current)
      }}
    >
      <div className="zen-bm-title-block">
        <h2 id={titleId} className="zen-bm-title flex items-center gap-2">
          <Trash2 className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden />
          <span className="min-w-0 truncate">{title}</span>
        </h2>
        <p id={bodyId} className="zen-bm-title-desc">
          {detail}
        </p>
      </div>
      <div className="zen-bm-form">
        <div className="zen-bm-footer justify-end">
          <button ref={cancelRef} type="button" className="zen-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="zen-button"
            data-variant="danger"
            aria-label={actionLabel}
            aria-busy={busy || undefined}
            onClick={onConfirm}
          >
            {busy ? <Loader2 className="zen-spin h-4 w-4" aria-hidden /> : action}
          </button>
        </div>
      </div>
    </div>
  )
}

function summariseData(info: SiteInfo): string {
  const cookies = info.cookies.items
  const parts: string[] = []
  if (cookies.length) parts.push(`${cookies.length} cookie${cookies.length === 1 ? '' : 's'}`)
  const usage = info.storage.usageBytes
  if (usage !== null && usage > 0) parts.push(formatBytes(usage))
  else if (cookies.length) parts.push(formatBytes(cookieBytes(cookies)))
  if (parts.length === 0) return storesAnything(info) ? 'Some site data' : 'None'
  return parts.join(' · ')
}

function items(n: number): string {
  return `${n} item${n === 1 ? '' : 's'}`
}

/** Anything beyond cookies: quota-managed storage, Web Storage items or service workers. */
function storesAnything(info: SiteInfo): boolean {
  const s = info.storage
  return (
    (s.usageBytes ?? 0) > 0 ||
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
