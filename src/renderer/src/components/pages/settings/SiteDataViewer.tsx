import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { SiteDataListing, SiteDataOriginRow } from '@shared/siteData'
import { cmd } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import {
  SITE_DATA_TEXT,
  originDescription,
  originLabel,
  siteDataCountAside,
  siteDataListingNote
} from '@renderer/lib/siteDataUi'
import { V2Button } from '../../extensions/v2'
import { SheetActions, SheetFooter } from './blocks'
import { SettingsDialog } from './dialogs'
import { attachLineCount } from './lineCount'
import { RowText } from './rows'
import { SettingsSheet } from './sheets'
import { useSheetDismiss, useSheetRelayout } from './sheetContext'

/**
 * See all site data (Chrome's `chrome://settings/content/all`, PS-25): the body of the sheet or
 * dialog the "See all site data and permissions" row opens (`siteDataRows.tsx`), on both
 * platforms the same rows (design language v2 §9.11, §9.17, §9.18, §9.21, §10.3–§10.4). It asks
 * the engine once (`siteData.list`: every origin with cookies, stored data or a permission, the
 * most data first, capped at 1 000) and draws the listing under one heading, "Sites", with the
 * count as the heading's aside – "1,000 of 1,204 sites" when the listing stopped at the cap,
 * with the cap's line under the heading – and, where no origin could be sized (Electron), the
 * honest "Sizes are unavailable on this device." once, never per row.
 *
 * Each origin is a two-line row (64 on the phone, §10.4; the description clamped to two lines):
 * the host on the first line, its cookies, its size where the host sized it and its permissions
 * on the second, then the policy's word for it when a list holds it; the trailing Clear is a
 * §9.11 in-row action in the danger ink (§9.21: the row grows around it, which a two-line row
 * already does), the §9.30 busy button while the engine clears, the row leaving the list when it
 * has (no motion on a layout property), staying with the failure line in the danger ink when it
 * has not. Clear all stands in the sheet's footer (`SheetFooter`, §9.11), in reach at the foot
 * of the longest list, and prompts first (§9.23 – the page's rule for a destructive page action,
 * even where Chrome clears at once): the prompt is a second sheet on the phone (§9.24, one deep
 * from here) and a second dialog on the desktop, which covers this one. Clearing signs the user
 * out of the site; its permissions stay, as the title block says.
 */
export function SiteDataViewer(): JSX.Element {
  const [listing, setListing] = useState<SiteDataListing | null>(null)
  const [failed, setFailed] = useState(false)
  /** Origins whose Clear the engine is running. */
  const [clearing, setClearing] = useState<ReadonlySet<string>>(new Set())
  /** Origins whose Clear the engine refused, with the failure line in place of the storage line. */
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set())
  const [clearingAll, setClearingAll] = useState(false)
  const [allFailed, setAllFailed] = useState(false)
  const [prompt, setPrompt] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    cmd('siteData.list', undefined).then(
      (result) => {
        if (alive.current) setListing(result)
      },
      () => {
        if (alive.current) setFailed(true)
      }
    )
    return () => {
      alive.current = false
    }
  }, [])
  // The body's height changes as the listing arrives and as rows leave: the sheet measures its
  // detents again (the desktop dialog's body scrolls on its own).
  const relayout = useSheetRelayout()
  const count = listing?.rows.length ?? 0
  useEffect(() => {
    relayout()
  }, [relayout, count])

  const clearSite = (origin: string): void => {
    if (clearing.has(origin)) return
    setClearing((set) => new Set(set).add(origin))
    setRefused((set) => without(set, origin))
    cmd('siteData.clearSite', { origin }).then(
      () => {
        if (!alive.current) return
        setClearing((set) => without(set, origin))
        setListing((current) => current && withoutRow(current, origin))
      },
      () => {
        if (!alive.current) return
        setClearing((set) => without(set, origin))
        setRefused((set) => new Set(set).add(origin))
      }
    )
  }
  const clearAll = (): void => {
    if (clearingAll) return
    setClearingAll(true)
    setAllFailed(false)
    cmd('siteData.clearAll', undefined).then(
      () => {
        if (!alive.current) return
        setClearingAll(false)
        setRefused(new Set())
        setListing((current) =>
          current ? { rows: [], total: 0, truncated: false, sized: current.sized } : current
        )
      },
      () => {
        if (!alive.current) return
        setClearingAll(false)
        setAllFailed(true)
      }
    )
  }

  const rows = listing?.rows ?? []
  const note = listing ? siteDataListingNote(listing) : undefined
  const status = failed
    ? SITE_DATA_TEXT.viewer.failed
    : listing === null
      ? SITE_DATA_TEXT.viewer.reading
      : rows.length === 0
        ? SITE_DATA_TEXT.viewer.empty
        : null
  return (
    <div className="zen-settings-groups zen-settings-sheet-rows" data-testid="site-data-viewer">
      <section
        className="zen-settings-group"
        data-group="site-data-origins"
        aria-label={SITE_DATA_TEXT.viewer.sites}
        aria-busy={listing === null && !failed ? true : undefined}
      >
        <h3 className="zen-v2-heading zen-settings-heading">
          {SITE_DATA_TEXT.viewer.sites}
          {listing && (
            <span className="zen-settings-heading-aside" data-testid="site-data-count">
              {siteDataCountAside(listing)}
            </span>
          )}
        </h3>
        {note && <p className="zen-settings-group-description">{note}</p>}
        {allFailed && (
          <p className="zen-settings-group-description" data-tone="danger" role="alert">
            {SITE_DATA_TEXT.viewer.failed}
          </p>
        )}
        {status !== null ? (
          <p className="zen-settings-empty" data-tone={failed ? 'danger' : undefined}>
            {status}
          </p>
        ) : (
          rows.map((row) => (
            <OriginRow
              key={row.origin}
              row={row}
              sized={listing?.sized ?? false}
              busy={clearing.has(row.origin)}
              refused={refused.has(row.origin)}
              onClear={() => clearSite(row.origin)}
            />
          ))
        )}
      </section>
      <SheetFooter>
        <V2Button
          variant="danger"
          busy={clearingAll}
          disabled={rows.length === 0 && !clearingAll}
          aria-haspopup="dialog"
          data-testid="site-data-clear-all"
          onClick={() => setPrompt(true)}
        >
          {SITE_DATA_TEXT.viewer.clearAll}
        </V2Button>
      </SheetFooter>
      {prompt && <ClearAllPrompt close={() => setPrompt(false)} confirm={clearAll} />}
    </div>
  )
}

/**
 * One origin: the host, its storage line (or the failure line when its Clear was refused), the
 * trailing Clear – the §9.34 row primitive as the page's static control row (`rows.tsx`
 * `ControlRow`), the control the target and not the row.
 */
function OriginRow({
  row,
  sized,
  busy,
  refused,
  onClear
}: {
  row: SiteDataOriginRow
  sized: boolean
  busy: boolean
  refused: boolean
  onClear: () => void
}): JSX.Element {
  const label = originLabel(row.origin)
  return (
    <div
      ref={attachLineCount}
      data-row={`site-data-origin:${row.origin}`}
      data-static=""
      data-tone={refused ? 'danger' : undefined}
      className="zen-settings-row zen-settings-control-row zen-v2-row"
    >
      <RowText
        label={label}
        description={refused ? SITE_DATA_TEXT.viewer.failed : originDescription(row, sized)}
      />
      <span className="zen-settings-trailing zen-settings-control">
        <V2Button
          variant="danger"
          busy={busy}
          aria-label={`${SITE_DATA_TEXT.viewer.clear} ${label}`}
          onClick={onClear}
        >
          {SITE_DATA_TEXT.viewer.clear}
        </V2Button>
      </span>
    </div>
  )
}

/**
 * Clear all's prompt (§9.23): the question as the title block over its one paragraph, Cancel |
 * Clear all as §9.11 peers with the destructive one trailing; Cancel takes the focus as it opens.
 * A sheet over the viewer's sheet on the phone, a dialog over its dialog on the desktop.
 */
function ClearAllPrompt({
  close,
  confirm
}: {
  close: () => void
  confirm: () => void
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  const t = SITE_DATA_TEXT.viewer
  if (phone)
    return (
      <SettingsSheet
        name="settings-confirm:site-data-clear-all"
        title={t.clearAllTitle}
        description={t.clearAllDescription}
        under={false}
        onClose={close}
      >
        <PromptActions confirm={confirm} />
      </SettingsSheet>
    )
  return (
    <SettingsDialog
      name="confirm:site-data-clear-all"
      title={t.clearAllTitle}
      description={t.clearAllDescription}
      under={false}
      onClose={close}
      className="zen-settings-dialog-prompt"
    >
      <PromptActions confirm={confirm} />
    </SettingsDialog>
  )
}

/** The prompt's pair, through the prompt's own dismiss: the sheet leaves with its motion first. */
function PromptActions({ confirm }: { confirm: () => void }): JSX.Element {
  const dismiss = useSheetDismiss()
  return (
    <SheetActions
      action={SITE_DATA_TEXT.viewer.clearAll}
      destructive
      onCancel={() => dismiss()}
      onAction={() => dismiss(confirm)}
    />
  )
}

function without(set: ReadonlySet<string>, item: string): ReadonlySet<string> {
  if (!set.has(item)) return set
  const next = new Set(set)
  next.delete(item)
  return next
}

/** The listing with one origin gone: the total follows, the cap's line with it once under it. */
function withoutRow(listing: SiteDataListing, origin: string): SiteDataListing {
  const rows = listing.rows.filter((row) => row.origin !== origin)
  if (rows.length === listing.rows.length) return listing
  const total = Math.max(rows.length, listing.total - 1)
  return { ...listing, rows, total, truncated: listing.truncated && total > rows.length }
}
