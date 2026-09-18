import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppWindow, ChevronRight, ExternalLink } from 'lucide-react'
import type { BlockedPopup, Rect, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { viewportStore } from '@renderer/lib/formFactor'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  type PopoverBox,
  placePopover,
  popoverStyle,
  toRect,
  useLightDismiss,
  viewportSize
} from '@renderer/lib/portals'
import {
  blockedPopupsOf,
  closeBlockedPopups,
  openBlockedPopups,
  originOf,
  popupsAllowedFor,
  siteLabel
} from '@renderer/lib/security'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useFocusReach } from '@renderer/hooks/useFocusReach'
import { useEscapeTrap } from '../bookmarks/escape'
import { focusAnchor, useScrolled } from '../bookmarks/popover'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { V2_GLYPH, V2Button, V2Checkbox } from '../v2/controls'

/** The chip in the address pill the popover hangs from, and where Escape hands the keyboard back. */
const CHIP = '[data-blocked-popups-chip]'
/** Rows with a trailing Open button (§9.20). */
const WIDTH = POPOVER_WIDTH.form

type Panel = NonNullable<ReturnType<typeof uiStore.get>['blockedPopupsPanel']>

/**
 * What the pop-up blocker refused for one tab: the pages (and app launches) the site tried to open
 * without being asked, each with an Open button, and the checkbox that lets the site open windows
 * on its own from now on. On desktop a popover under the address pill's chip; on a phone the
 * shared bottom sheet. Rows holding an Open button are the control plus 8 tall (§9.21): 40 on
 * desktop, 48 on a phone.
 */
export function BlockedPopupsPanel({
  state,
  panel
}: {
  state: UIState
  panel: Panel
}): JSX.Element | null {
  const phone = viewportStore.use((s) => s.formFactor === 'phone')
  const tab = state.tabs[panel.tabId]
  // The tab was closed under the list: nothing to animate away, but the page must come back.
  useEffect(() => {
    if (!tab) closeBlockedPopups()
  }, [tab])
  if (!tab) return null
  const entries = blockedPopupsOf(state, panel.tabId)
  const allowed = popupsAllowedFor(state, tab)
  const props = { tab, entries, allowed }
  return phone ? (
    <BlockedPopupsSheet {...props} />
  ) : (
    <BlockedPopupsPopover {...props} state={state} anchor={panel.anchor} />
  )
}

interface ContentProps {
  tab: Tab
  entries: BlockedPopup[]
  allowed: boolean
}

function summaryOf(entries: BlockedPopup[], allowed: boolean): string {
  if (entries.length === 0) {
    return allowed ? 'This site may open pop-ups on its own.' : 'Nothing was blocked on this page.'
  }
  const pages = entries.filter((p) => p.kind === 'popup').length
  const launches = entries.length - pages
  const parts = [
    pages > 0 && `${pages} ${pages === 1 ? 'pop-up' : 'pop-ups'}`,
    launches > 0 && `${launches} ${launches === 1 ? 'app launch' : 'app launches'}`
  ].filter((p): p is string => typeof p === 'string')
  const text = parts.join(' and ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} blocked on this page.`
}

/** The last entry was opened and nothing is left to say: the list leaves on its own. */
function useCloseWhenEmpty(empty: boolean, close: () => void): void {
  useEffect(() => {
    if (empty) close()
  }, [empty, close])
}

/**
 * One refused page or app launch: its glyph, the URL, and Open, centred on the row (§9.18). The
 * row grows around its button (§9.21): the larger of the base row and the control plus 8, the 4
 * above and below being the row's own padding, so rows touch. The row itself is not a control,
 * so it has no hover fill; the button carries its own.
 */
function Entry({ tab, entry }: { tab: Tab; entry: BlockedPopup }): JSX.Element {
  const Glyph = entry.kind === 'external' ? ExternalLink : AppWindow
  return (
    <li className="flex min-h-[max(var(--v2-row),calc(var(--v2-control)+8px))] items-center gap-2.5 px-4">
      <Glyph className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[15px] leading-5" title={entry.url} dir="ltr">
        {entry.url}
      </span>
      <V2Button onClick={() => run('popups.open', { tabId: tab.id, url: entry.url })}>
        Open
      </V2Button>
    </li>
  )
}

function AllowCheckbox({
  tab,
  allowed,
  pages,
  close,
  className
}: ContentProps & { pages: number; close: () => void; className?: string }): JSX.Element {
  const origin = originOf(tab.url)
  if (!origin) return <span className={className} />
  return (
    <V2Checkbox
      className={className}
      checked={allowed}
      onChange={(e) => {
        run('popups.setSiteAllowed', { tabId: tab.id, allow: e.target.checked })
        // Allowing opens the blocked pages in tabs of their own, and the newest of them takes
        // the page's place: the list has nothing left to show for this tab.
        if (e.target.checked && pages > 0) close()
      }}
      label={`Always allow pop-ups on ${siteLabel(origin)}`}
    />
  )
}

/**
 * Desktop: a popover (v2 draft §9.20) 400 wide – rows with trailing controls – with its top
 * border on the pill's bottom edge, end-aligned with its chip (which sits in the pill's
 * trailing half), placed by `placePopover` (flip, slide, shrink, 8 px inside the window), no
 * taller than 60% of it; on the 180 ms pop, radius 8, the panel shadow, no scrim (§9.5). Its
 * title block (§9.23) stays put while the rows scroll under it, a hairline appearing at its
 * edge only then (§9.7); a hairline sets the footer apart, as in Firefox's panels (§0.2). It
 * renders through the chrome layer (`ChromePortal`), never inside the frame, and the layer's
 * light dismiss puts it away: a press anywhere else closes it on `pointerdown` and reaches
 * nothing beneath, the chip's own press closes it and keeps the focus, a resize and another
 * popover opening close it too. Focus moves to the first Open button (§9.22) and Escape hands
 * it back to the chip; the chip is measured again on every state push, so the popover keeps
 * its place on a chip whose count changed.
 */
function BlockedPopupsPopover({
  tab,
  entries,
  allowed,
  state,
  anchor
}: ContentProps & { state: UIState; anchor: Rect | null }): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLUListElement>(null)
  const scrolled = useScrolled(bodyRef)
  const [box, setBox] = useState<PopoverBox>(() => place(anchor))
  const lastAnchor = useRef<Rect | null>(anchor)

  useLayoutEffect(() => {
    const chip = document.querySelector(CHIP)
    if (chip) lastAnchor.current = toRect(chip.getBoundingClientRect())
    const next = place(lastAnchor.current)
    setBox((prev) => (sameBox(prev, next) ? prev : next))
  }, [state])

  useFocusReach(panelRef)
  const close = useCallback(() => closeBlockedPopups(), [])
  useCloseWhenEmpty(entries.length === 0 && !allowed, close)

  // Escape puts the popover away and hands the keyboard back to the chip (§9.22).
  useEscapeTrap(true, () => {
    closeBlockedPopups(false)
    focusAnchor(CHIP)
  })
  // The chrome layer's light dismiss (§9.20 amended): a press anywhere else puts the popover
  // away and the page gets the keyboard back; the chip's own press closes it and the focus
  // stays on the chip, where the press went.
  useLightDismiss(panelRef, (reason) => closeBlockedPopups(reason !== 'anchor'), {
    anchor: () => document.querySelector(CHIP)
  })

  const pages = entries.filter((p) => p.kind === 'popup').length
  return (
    <ChromePortal>
      {/* A page surface (§9.29): the count inside it, the buttons and the checkbox draw in the page family. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby="blocked-popups-title"
        data-blocked-popups-panel=""
        data-surface="page"
        className="zen-animate-pop zen-bm-popover fixed z-[70] flex flex-col outline-none"
        style={popoverStyle(box)}
        tabIndex={-1}
      >
        <div
          className="zen-bm-title-block flex items-start gap-2"
          data-scrolled={scrolled || undefined}
        >
          {/* The glyph sits on the title's 22 px line (§9.23): (22 − glyph) / 2 below its top. */}
          <AppWindow className={cn(V2_GLYPH, 'mt-[calc((22px-var(--v2-icon))/2)]')} aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="blocked-popups-title" className="zen-bm-title">
              Blocked Pop-ups
            </h2>
            <p className="zen-bm-title-desc">{summaryOf(entries, allowed)}</p>
          </div>
        </div>
        {entries.length > 0 && (
          <ul ref={bodyRef} className="zen-bm-popover-body flex flex-col pb-2">
            {entries.map((entry) => (
              <Entry key={entry.url} tab={tab} entry={entry} />
            ))}
          </ul>
        )}
        <div className="flex shrink-0 items-center gap-3 border-t border-[var(--v2-border)] px-4 py-3">
          <AllowCheckbox
            tab={tab}
            entries={entries}
            allowed={allowed}
            pages={pages}
            close={close}
            className="min-w-0 flex-1"
          />
          <V2Button
            onClick={() => {
              run('popups.dismiss', { tabId: tab.id })
              close()
            }}
          >
            Dismiss
          </V2Button>
        </div>
      </div>
    </ChromePortal>
  )
}

/**
 * Where the popover goes: hanging from the pill's bottom edge, end-aligned with the chip; with
 * neither on screen, in the window's top trailing corner like the star bubble.
 */
function place(chip: Rect | null): PopoverBox {
  const viewport = viewportSize()
  const pill = document.querySelector('.zen-pill')
  const pillRect = pill ? toRect(pill.getBoundingClientRect()) : null
  const anchor = chip ?? {
    x: viewport.width - POPOVER_MARGIN - 28,
    y: 28,
    width: 28,
    height: 28
  }
  return placePopover(anchor, pillRect ?? anchor, viewport, WIDTH)
}

function sameBox(a: PopoverBox, b: PopoverBox): boolean {
  if (a.left !== b.left || a.width !== b.width || a.maxHeight !== b.maxHeight) return false
  return a.side === 'below'
    ? b.side === 'below' && a.top === b.top
    : b.side === 'above' && a.bottom === b.bottom
}

/**
 * Phone: the shared bottom sheet, which owns the v2 surface, the grip strip and the 48 header
 * with the title centred (§9.16). The summary is body copy under the header – 15/400 in the
 * page ink, 16 above the rows it introduces (§9.23) – then the rows edge to edge at the sheet's
 * one 16 px gutter (§9.25), a hairline in the gutter before the checkbox row, and the one action
 * filling the §9.11 footer. Rendered through the chrome layer: the sheet is a window-wide layer
 * of its own, not a child of the frame dialog host it is mounted from.
 */
function BlockedPopupsSheet({ tab, entries, allowed }: ContentProps): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const dismiss = useCallback((): void => sheet.current?.dismiss(), [])
  useCloseWhenEmpty(entries.length === 0 && !allowed, dismiss)

  // The system back gesture pulls the sheet down with the finger; the back button, a hardware
  // Escape and a scrim tap slide it away.
  useBackSurface({
    name: 'blocked-popups',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscapeTrap(true, dismiss)

  const pages = entries.filter((p) => p.kind === 'popup').length
  return (
    <ChromePortal>
      <BottomSheet
        ref={sheet}
        onDismissed={() => closeBlockedPopups()}
        contentKey={`${entries.length}|${allowed}`}
        handleLabel="Resize blocked pop-ups"
        header={<h2 className="zen-sheet-title">Blocked Pop-ups</h2>}
      >
        <p className="px-4 pb-4 text-[15px] leading-5">{summaryOf(entries, allowed)}</p>
        {entries.length > 0 && (
          <>
            <ul className="flex flex-col">
              {entries.map((entry) => (
                <Entry key={entry.url} tab={tab} entry={entry} />
              ))}
            </ul>
            <div className="zen-sheet-sep" />
          </>
        )}
        <div className="flex min-h-[var(--v2-row)] items-center px-4">
          <AllowCheckbox
            tab={tab}
            entries={entries}
            allowed={allowed}
            pages={pages}
            close={dismiss}
            className="min-w-0 flex-1"
          />
        </div>
        <div className="zen-sheet-footer">
          <V2Button
            onClick={() =>
              // The sheet leaves first; the entries go once it is gone.
              sheet.current?.dismiss(() => run('popups.dismiss', { tabId: tab.id }))
            }
          >
            Dismiss
          </V2Button>
        </div>
      </BottomSheet>
    </ChromePortal>
  )
}

/**
 * Phones have no room for an indicator in the address pill: a bar in its own row between the
 * page and the toolbar says a pop-up was blocked and opens the list. It takes a row of its own
 * (the page above shrinks) because the host draws the page over anything the chrome puts on top
 * of it. A flat 44 px control on the panel surface with a trailing chevron (§9.18), not a pill,
 * at the Android menu size on its 20 px line (§4); a page surface of its own on the window
 * (§9.29), so its ink and chevron are the page's.
 */
export function BlockedPopupsChip({
  state,
  tabId,
  className
}: {
  state: UIState
  tabId: string
  className?: string
}): JSX.Element | null {
  const entries = blockedPopupsOf(state, tabId)
  if (entries.length === 0) return null
  const label = entries.length === 1 ? 'Pop-up blocked' : `${entries.length} pop-ups blocked`
  return (
    <div className={cn('flex shrink-0 px-4 py-2', className)}>
      <button
        type="button"
        data-surface="page"
        className="zen-v2-chip zen-animate-pop flex min-h-[var(--v2-row)] w-full items-center gap-3 rounded-[var(--v2-radius-control)] border border-[var(--v2-border)] bg-[var(--v2-panel)] px-3 text-left text-[14px] leading-5 text-[var(--v2-text)] outline-none transition-transform duration-[120ms] active:scale-[.98]"
        onClick={() => void openBlockedPopups(tabId, null)}
      >
        <AppWindow className={V2_GLYPH} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')} aria-hidden />
      </button>
    </div>
  )
}
