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
  useFrameDialog,
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
import { useEscape } from '@renderer/hooks/useEscape'
import { usePopover } from '@renderer/hooks/usePopover'
import { useScrolled } from '../bookmarks/popover'
import { V2Button } from '../extensions/v2'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { GLYPH } from './glyph'

/** The chip in the address pill the popover hangs from, and where Escape hands the keyboard back. */
const CHIP = '[data-blocked-popups-chip]'
/** Rows with a trailing Open button (§9.20). */
const WIDTH = POPOVER_WIDTH.form

type Panel = NonNullable<ReturnType<typeof uiStore.get>['blockedPopupsPanel']>

/**
 * What the pop-up blocker refused for one tab: the pages (and app launches) the site tried to open
 * without being asked, each with an Open button, and the choice that lets the site open windows
 * on its own from now on – a checkbox on desktop, a switch row on a phone (§10.4). On desktop a
 * popover under the address pill's chip; on a phone the shared bottom sheet. Rows holding an
 * Open button are the control plus 8 tall (§9.21): 40 on desktop, 48 on a phone.
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
 * One refused page or app launch: its glyph, the URL, and Open. The shared row for a control
 * (`.zen-v2-control-row`, §9.21, §9.34): the control's height plus 8 – 40 on desktop, 48 on a
 * phone – the 4 above and below the row's own padding, so rows touch, the button centred on it
 * (§9.18); inside it the shared row anatomy, the glyph on the URL's line in the deemphasised
 * ink, 12 before the text. The row is not a target and takes no fill; the button carries its own.
 */
function Entry({ tab, entry }: { tab: Tab; entry: BlockedPopup }): JSX.Element {
  const Glyph = entry.kind === 'external' ? ExternalLink : AppWindow
  return (
    <li className="zen-v2-control-row">
      <span className="zen-v2-row-body">
        <Glyph className={cn(GLYPH, 'zen-v2-row-lead')} aria-hidden />
        <span className="zen-v2-row-text">
          <span className="zen-v2-label truncate" title={entry.url} dir="ltr">
            {entry.url}
          </span>
        </span>
      </span>
      <V2Button onClick={() => run('popups.open', { tabId: tab.id, url: entry.url })}>
        Open
      </V2Button>
    </li>
  )
}

/** Allowing opens the blocked pages in tabs of their own: the list has nothing left to show. */
function useAllow(tab: Tab, pages: number, close: () => void): (allow: boolean) => void {
  return useCallback(
    (allow: boolean) => {
      run('popups.setSiteAllowed', { tabId: tab.id, allow })
      if (allow && pages > 0) close()
    },
    [tab.id, pages, close]
  )
}

/**
 * Desktop: the site's standing answer as a checkbox row (`.zen-v2-checkbox`, the shared
 * primitive) – the box on the label's first line (§9.2), the whole label its target.
 */
function AllowCheckbox({
  tab,
  allowed,
  pages,
  close,
  className
}: ContentProps & { pages: number; close: () => void; className?: string }): JSX.Element {
  const allow = useAllow(tab, pages, close)
  const origin = originOf(tab.url)
  if (!origin) return <span className={className} />
  return (
    <label
      className={cn(
        'flex min-w-0 cursor-default items-start gap-2.5 text-[length:var(--v2-font-body)] leading-[var(--v2-line-body)]',
        className
      )}
    >
      <input
        type="checkbox"
        className="zen-v2-checkbox"
        checked={allowed}
        onChange={(e) => allow(e.target.checked)}
      />
      <span className="min-w-0">Always allow pop-ups on {siteLabel(origin)}</span>
    </label>
  )
}

/**
 * Phone: the same answer as a switch row (§10.4: checkboxes are desktop only) – the shared
 * `.zen-v2-row` with the shared `.zen-v2-switch` trailing, the whole row its target.
 */
function AllowSwitchRow({
  tab,
  allowed,
  pages,
  close
}: ContentProps & { pages: number; close: () => void }): JSX.Element | null {
  const allow = useAllow(tab, pages, close)
  const origin = originOf(tab.url)
  if (!origin) return null
  return (
    <button
      type="button"
      role="switch"
      aria-checked={allowed}
      className="zen-v2-row"
      onClick={() => allow(!allowed)}
    >
      <span className="min-w-0 flex-1">Always allow pop-ups on {siteLabel(origin)}</span>
      <span className="zen-v2-switch" aria-hidden />
    </button>
  )
}

/**
 * Desktop: a popover (v2 draft §9.20) 400 wide – rows with trailing controls – with its top
 * border on the pill's bottom edge, end-aligned with its chip (which sits in the pill's
 * trailing half), placed by `placePopover` (flip, slide, shrink, 8 px inside the window, its
 * height capped by the placement); on the 180 ms pop, radius 8, the panel shadow, no scrim
 * (§9.5). Its title block (§9.23) stays put while the rows scroll under it, a hairline appearing
 * at its edge only then (§9.7). The footer is §9.20's second form: the list's 4 px inset, a
 * hairline in the gutter, then the checkbox and Dismiss at 12 above and below. It renders
 * through the chrome layer (`ChromePortal`), never inside the frame, and the layer's light
 * dismiss puts it away: a press anywhere else closes it on `pointerdown` and reaches nothing
 * beneath, the chip's own press closes it and keeps the focus, a resize and another popover
 * opening close it too. The keyboard is `usePopover`'s (§9.22): focus moves to the first Open
 * button, Tab wraps, and Escape closes it and hands the keyboard back to the chip that opened
 * it. The chip is measured again on every state push, so the popover keeps its place on a chip
 * whose count changed.
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

  const close = useCallback(() => closeBlockedPopups(), [])
  useCloseWhenEmpty(entries.length === 0 && !allowed, close)

  // Escape puts the popover away; the chrome keeps the keyboard, which `usePopover` hands back
  // to the chip the popover was opened from (§9.22).
  usePopover(panelRef, { onClose: () => closeBlockedPopups(false) })
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
          {/* The glyph sits on the title's line (§9.23): (line − glyph) / 2 below its top. */}
          <AppWindow
            className={cn(GLYPH, 'mt-[calc((var(--v2-line-heading-box)-var(--v2-icon))/2)]')}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <h2 id="blocked-popups-title" className="zen-bm-title">
              Blocked pop-ups
            </h2>
            <p className="zen-bm-title-desc">{summaryOf(entries, allowed)}</p>
          </div>
        </div>
        {entries.length > 0 && (
          <ul ref={bodyRef} className="zen-bm-popover-body flex flex-col pb-1">
            {entries.map((entry) => (
              <Entry key={entry.url} tab={tab} entry={entry} />
            ))}
          </ul>
        )}
        <div className="mx-4 flex shrink-0 items-center gap-3 border-t border-[var(--v2-border)] py-3">
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
 * Phone: the shared bottom sheet, which owns the v2 surface, the grip strip, the keyboard (focus
 * on open, Tab, the inert chrome behind the scrim, the lift above the keyboard – §9.22) and the
 * §9.11 footer, where Dismiss sits outside the scroller. The popover's title block in the
 * sheet's form (§9.23) – the glyph on the title's start, the summary as its description at the
 * gutter, no 48 header – so the two platforms are one composition; then the rows edge to edge
 * at the sheet's one 16 px gutter (§9.25), a hairline in the gutter, and the site's standing
 * answer as a switch row (§10.4). A dialog of TabDialogs' `FrameDialogHost` (the shell's box on
 * a phone), drawing the stack's one scrim itself, which fades with its motion (§9.28); the
 * sheet's layer is a page surface (§9.29).
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
  useEscape(dismiss)
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })

  const pages = entries.filter((p) => p.kind === 'popup').length
  // The sheet's layer is the host slot's own child: the host lets the pointer through to a
  // sheet on its own chassis by that layer (`[data-sheet-layer]`), not to a box around it.
  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={() => closeBlockedPopups()}
      contentKey={`${entries.length}|${allowed}`}
      handleLabel="Resize blocked pop-ups"
      labelledBy="blocked-popups-title"
      footer={
        <V2Button
          onClick={() =>
            // The sheet leaves first; the entries go once it is gone.
            sheet.current?.dismiss(() => run('popups.dismiss', { tabId: tab.id }))
          }
        >
          Dismiss
        </V2Button>
      }
    >
      <div className="zen-sheet-title-block">
        <h2 id="blocked-popups-title">
          <AppWindow className={GLYPH} aria-hidden />
          <span className="min-w-0 truncate">Blocked pop-ups</span>
        </h2>
        <p>{summaryOf(entries, allowed)}</p>
      </div>
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
      <AllowSwitchRow tab={tab} entries={entries} allowed={allowed} pages={pages} close={dismiss} />
    </BottomSheet>
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
        className="zen-animate-pop flex min-h-[var(--v2-row)] w-full items-center gap-3 rounded-[var(--v2-radius-control)] border border-[var(--v2-border)] bg-[var(--v2-panel)] px-3 text-left text-[14px] leading-[var(--v2-line-body)] text-[var(--v2-text)] outline-none transition-transform duration-[120ms] active:scale-[.98]"
        onClick={() => void openBlockedPopups(tabId, null)}
      >
        <AppWindow className={GLYPH} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className={cn(GLYPH, 'text-[var(--v2-text-deemphasized)]')} aria-hidden />
      </button>
    </div>
  )
}
