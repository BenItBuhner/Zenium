import type { JSX, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { MonitorSmartphone, Plus, X } from 'lucide-react'
import type { Rect, SidePanelInfo, SplitGroup, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { chromeUnderPages } from '@renderer/lib/cover'
import { wantsDefaultBrowserBanner } from '@renderer/lib/defaultBrowser'
import { useViewport } from '@renderer/lib/formFactor'
import { SPLIT_GAP, SPLIT_GAP_TOUCH, splitPaneRects } from '@renderer/lib/layout'
import { isPageTab } from '@renderer/lib/pages'
import { isPdfViewerTab } from '@renderer/lib/pdfViewer'
import { usePrivateCoverUp } from '@renderer/lib/privateLock'
import { activeTab, isForeignTab } from '@renderer/lib/selectors'
import { useChord } from '@renderer/lib/shortcuts'
import { barStateOf } from '@renderer/lib/translate'
import {
  captureActiveTab,
  closeFindBar,
  closeZoom,
  panelAloneOverContent,
  uiStore,
  type UiState
} from '@renderer/lib/ui'
import { extensionChromeAloneOverContent } from '@renderer/lib/extensions/scrim'
import { cn } from '@renderer/lib/utils'
import { dropStore } from '@renderer/lib/drag'
import { newTabGrowStore } from '@renderer/lib/newtab'
import { PickerStrip } from '../autofill/PickerStrip'
import { Urlbar } from '../urlbar/Urlbar'
import { NewTabPage } from '../newtab/NewTabPage'
import { OverlayHost } from '../overlays/OverlayHost'
import { InternalPageHost } from '../pages/InternalPageHost'
import { PdfViewerBar } from '../pdf/PdfViewerBar'
import { PrivateLockCover } from '../phone/PrivateLockCover'
import { TranslateBar } from '../translate/TranslateBar'
import { CoverImage } from './CoverImage'
import { CrashRestoreBanner } from './CrashRestoreBanner'
import { DefaultBrowserBanner } from './DefaultBrowserBanner'
import { FindBar } from './FindBar'
import { GlanceFrame } from './GlanceFrame'
import { LoadProgress } from './LoadProgress'
import { PullIndicator } from './PullIndicator'
import { ReadAloudPanel } from './ReadAloudPanel'
import { SplitChrome } from './SplitChrome'
import { useLayoutReporter } from './useLayoutReporter'
import { ZoomSheet } from './ZoomSheet'

interface Props {
  state: UIState
  ui: UiState
}

/**
 * The area where tab views live. Everything rendered here is chrome that shows *around* or
 * *instead of* the web content (split gutters, glance frame, URL bar, panels, empty state).
 */
export function ContentArea({ state, ui }: Props): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const sidePanelRef = useRef<HTMLDivElement>(null)
  const tab = activeTab(state)
  const group = tab?.splitGroupId ? (state.splitGroups[tab.splitGroupId] ?? null) : null
  const glanceActive = ui.glanceActive
  const glanceTabId = state.glance?.tabId ?? null
  const glanceParentId = state.glance?.parentTabId ?? null

  // Glance: freeze the parent behind a snapshot, animate the card in, then show the view.
  useEffect(() => {
    if (!glanceTabId) {
      uiStore.set({ glanceActive: false, glanceReady: false })
      return
    }
    let cancelled = false
    void captureActiveTab(glanceParentId).then(() => {
      if (cancelled) return
      uiStore.set({ glanceActive: true })
      setTimeout(() => {
        if (!cancelled) uiStore.set({ glanceReady: true })
      }, 210)
    })
    return () => {
      cancelled = true
    }
  }, [glanceTabId, glanceParentId])

  const { area, contentHidden } = useLayoutReporter(
    viewportRef,
    sidePanelRef,
    state,
    ui,
    glanceActive
  )
  const local: Rect | null = area ? { x: 0, y: 0, width: area.width, height: area.height } : null
  // The phone shell draws the URL bar itself: its field sits in the bar band outside this frame.
  const phone = useViewport().formFactor === 'phone'
  // The phone's gesture stage draws its own cards where the page was; nothing to dim behind it.
  // Its URL bar covers the frame completely, so there is nothing to dim behind that either.
  const staged = ui.stageActive && !overlayCoversContentBesidesStage(ui)
  const foreign = isForeignTab(state, tab?.id)
  // The "Make Zenium your default browser" and "Restore pages?" strips sit above the page,
  // inside the frame, so the layout reporter's viewport (and the tab view under it) shrink by
  // their height. A fullscreen window shows the page alone (Chrome hides its infobars there too).
  const banner = !phone && !state.window.fullscreen && wantsDefaultBrowserBanner(state)
  const crashRestore = !phone ? state.crashRestore : null
  // The phone draws a new tab page in the frame where the blank page would be (the desktop
  // keeps Zen's bare frame). Its view is never placed there – see `useLayoutReporter`.
  const newTabPage = phone && tab !== null && tab.url === BLANK_URL && !foreign
  // The grow surface is a stage layer too, but the page it reveals must be painted under it: the
  // surface fades on its own progress and the page shows through (NewTabGrowLayer).
  const growing = newTabGrowStore.use((s) => s.phase !== 'idle')
  // An internal page (Settings) is chrome like the new tab page: neither has a view to snapshot,
  // and both stay drawn under a sheet's own scrim, so nothing dims them from here.
  const pageTab = isPageTab(tab)
  // The lock cover over a locked private tab (INC-05): it paints the tab's own picture, blurred,
  // under its veil, so the plain snapshot stands aside; the gesture stage and the phone's
  // omnibox cover the frame whole and take it over as they take the snapshot over.
  const lockCover =
    usePrivateCoverUp(state) && tab !== null && !staged && !(phone && ui.urlbar.open)
  const showSnapshot =
    (contentHidden || glanceActive) &&
    Boolean(tab) &&
    !pageTab &&
    !staged &&
    !(phone && ui.urlbar.open) &&
    !newTabPage &&
    !lockCover
  const dropKey = dropStore.use((s) => s.key)
  // The translate bar shares the frame with the live page, under the strips and directly above
  // the page; chrome that stands in for the page (panels, the gesture stage) takes the whole frame.
  const translateBar = barStateOf(state, tab?.id)
  const showTranslateBar =
    translateBar !== null && !foreign && ui.overlay === 'none' && !ui.stageActive

  // The load bar is the phone's (and Android's at any width); the desktop program has not adopted
  // it yet, so Electron's wide layout renders the frame alone as it did.
  const loadBar = phone || state.platform === 'android'

  // The inline PDF viewer's bar (CT-02) docks where the find bar and the zoom sheet do, one of
  // the three at a time: the find bar over a viewer tab searches the document itself and takes
  // the slot over while it is up; a page shown in another window has no controls here.
  const pdfBar =
    state.capabilities.pdfViewer &&
    tab !== null &&
    !foreign &&
    !ui.findOpen &&
    !ui.zoomTabId &&
    isPdfViewerTab(state, tab.id)

  // Read aloud's player is the fourth docked panel (§9.32: one in the slot at a time). A session
  // starting takes the slot – the find bar and the zoom sheet give it up, as they do for each
  // other – and a find or zoom opened while it reads takes the slot back for its stay: the
  // panel hides, the session goes on (the OS controls still carry it), and it returns when they
  // close. The PDF viewer's bar keeps the slot on its tab (a document there is the viewer's,
  // not an article). The panel is the session's tab's: another tab in front shows no player.
  // The phone's panel alone: the desktop's read aloud is the services program's own UI, and
  // the desktop frame must not grow a phone panel for a session its menus start.
  const readAloud = state.readAloud
  const readAloudTabId = phone ? (readAloud?.tabId ?? null) : null
  useEffect(() => {
    if (!readAloudTabId) return
    const current = uiStore.get()
    if (current.findOpen) closeFindBar()
    if (current.zoomTabId) closeZoom()
  }, [readAloudTabId])
  const readAloudDocked =
    phone &&
    readAloud !== null &&
    tab !== null &&
    readAloud.tabId === tab.id &&
    !foreign &&
    !ui.findOpen &&
    ui.zoomTabId === null &&
    !pdfBar

  // Overlays are hosted beside the frame, not inside it: on phones the frame recedes (scales to
  // .97) under a sheet, and a sheet mounted within it would shrink with the page – its 44 px
  // targets measured 42.7. The wrapper has the frame's box and no transform of its own.
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        className="zen-content-frame relative flex h-full min-h-0 flex-col overflow-hidden"
        data-staged={staged || undefined}
        // A phone panel takes the whole frame (OverlayShell): what it covers – a chrome page's
        // own rows and headings, the find bar – leaves the accessibility tree with it (§9.22:
        // nothing focusable is left behind; A11Y-01: TalkBack's order is the visual order).
        inert={phone && ui.overlay !== 'none' ? true : undefined}
      >
        {(crashRestore || banner) && (
          // Under a desktop overlay panel the strips keep their height (the viewport under them
          // does not jump) but are not painted or reachable: the panel's 12 px margin showed the
          // strip's top edge and its accent button above every overlay (services' #92 pass).
          <div
            className="zen-frame-strips contents"
            data-under-overlay={ui.overlay !== 'none' || undefined}
          >
            {crashRestore && <CrashRestoreBanner offer={crashRestore} />}
            {banner && <DefaultBrowserBanner state={state} />}
          </div>
        )}
        {showTranslateBar && <TranslateBar state={state} tab={translateBar} />}
        <div className="flex min-h-0 flex-1 flex-row">
          {/* A tab dragged onto the page (past the split zones at its edges) tears off into a new window. */}
          <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden" data-tear-zone>
            {state.capabilities.pullToRefresh && <PullIndicator />}
            {!tab && !ui.urlbar.open && ui.overlay === 'none' && !staged && <EmptyState />}
            {tab && pageTab && <InternalPageHost state={state} tab={tab} hidden={staged} />}
            {newTabPage && (
              // Kept mounted under the omnibox and the gesture stage (which draws its own cards),
              // just not painted, so the page is there the moment they leave.
              <NewTabPage state={state} tab={tab} hidden={ui.urlbar.open || (staged && !growing)} />
            )}
            {tab && foreign && !contentHidden && !glanceActive && (
              <ForeignTabPreview tabId={tab.id} />
            )}
            {showSnapshot && (
              <div className="absolute inset-0">
                {ui.snapshot &&
                ui.snapshotTabId &&
                ui.snapshotTabId === (glanceActive ? glanceParentId : tab?.id) ? (
                  <CoverImage
                    tabId={ui.snapshotTabId}
                    src={ui.snapshot}
                    // The Android chassis swaps the page for this picture at every form factor
                    // (see lib/cover.ts); the desktop hosts show it as they always have.
                    cover={chromeUnderPages(state.platform)}
                    className="h-full w-full object-cover object-top"
                  />
                ) : null}
                {/*
                 * Desktop and tablet: the capture is dimmed under the URL bar and the overlays.
                 * Panels draw no scrim: a bar panel, the star bubble, the puzzle panel, a local
                 * menu or the popup frame leaves the capture undimmed; an extension prompt's
                 * scrim is the frame dialog host's (the sheet's on a phone). On a phone the
                 * capture is drawn plain: the sheet's scrim, fading with the sheet's own progress
                 * over the receded frame, is the one dim layer (design language v2 draft §11.5)
                 * – a second, timed fade here was seen stacking with it.
                 */}
                {!phone && !panelAloneOverContent(ui) && !extensionChromeAloneOverContent(ui) && (
                  <div
                    className={cn(
                      'absolute inset-0 bg-black/35 transition-opacity',
                      ui.drag && 'bg-black/20'
                    )}
                  />
                )}
              </div>
            )}
            {tab && !pageTab && (
              // Always mounted so a cover the lock released under lifts before it goes; it draws
              // nothing while not asked for. Over the phone's new tab page (chrome, no view to
              // picture) the veil's backdrop blur does the covering.
              <PrivateLockCover shown={lockCover} tab={newTabPage ? null : tab} />
            )}
            {group && local && !contentHidden && !glanceActive && (
              <SplitChrome state={state} group={group} area={local} activeTabId={tab?.id ?? null} />
            )}
            {ui.drag && local && tab && (
              <SplitDropZones
                dropKey={dropKey}
                group={group}
                area={local}
                draggedTabId={ui.drag.tabId}
              />
            )}
            {glanceActive && state.glance && local && (
              <GlanceFrame
                state={state}
                glance={state.glance}
                area={local}
                ready={ui.glanceReady}
              />
            )}
            {ui.urlbar.open && local && !phone && (
              <Urlbar
                key={`${ui.urlbar.mode}-${ui.urlbar.tabId ?? 'new'}`}
                state={state}
                urlbar={ui.urlbar}
                area={local}
              />
            )}
          </div>
          {state.sidePanel && !phone && (
            <SidePanelStrip panel={state.sidePanel} bodyRef={sidePanelRef} />
          )}
        </div>
        {ui.findOpen && ui.findTabId && state.tabs[ui.findTabId] && (
          <FindBar state={state} tabId={ui.findTabId} ui={ui} docked="content" />
        )}
        {ui.zoomTabId && state.capabilities.pageControls && (
          <ZoomSheet state={state} tabId={ui.zoomTabId} />
        )}
        {pdfBar && tab && <PdfViewerBar key={tab.id} state={state} tabId={tab.id} />}
        {readAloudDocked && <ReadAloudPanel session={readAloud} />}
        {/* The autofill picker of a host without a popup surface docks here, above the keyboard. */}
        <PickerStrip state={state} />
      </div>
      {/* The bar is the frame's edge: it recedes with the frame, and overlays cover both. */}
      {loadBar && <LoadProgress tab={tab} hidden={contentHidden || glanceActive || foreign} />}
      {ui.overlay !== 'none' && <OverlayHost state={state} ui={ui} />}
    </div>
  )
}

/**
 * The extension side panel's strip (`chrome.sidePanel`): the panel's own page is a host view
 * placed over the body by the layout reporter; the strip reserves the room beside the page and
 * carries the extension's name and a close button. Plain and functional; its design pass is
 * deferred with the styling hold.
 */
function SidePanelStrip({
  panel,
  bodyRef
}: {
  panel: SidePanelInfo
  bodyRef: RefObject<HTMLDivElement | null>
}): JSX.Element {
  return (
    <aside
      className="flex w-[360px] shrink-0 flex-col border-l border-[var(--zen-border)] bg-[var(--zen-bg)]"
      aria-label={`${panel.name} side panel`}
      // The side panel pane of the F6 rotation (lib/panes.ts): the strip's controls are what
      // the chrome can focus; the panel's own page is a host view.
      data-pane="sidepanel"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-[13px]">
        {panel.icon && <img src={panel.icon} alt="" className="h-4 w-4" draggable={false} />}
        <span className="min-w-0 flex-1 truncate font-medium">{panel.name}</span>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--zen-muted)] hover:bg-[var(--zen-element-bg-hover)] hover:text-[var(--zen-fg)]"
          title="Close side panel"
          onClick={() => run('extension.closeSidePanel', undefined)}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1" />
    </aside>
  )
}

/**
 * Chrome that takes the content area over from the gesture stage (URL bar, panels, a tab drag).
 * The phone's Spaces drawer and the menu sheets are not counted: they open over the overview,
 * which keeps the stage – and the snapshot must not show through the grid behind them.
 */
function overlayCoversContentBesidesStage(ui: UiState): boolean {
  return (
    ui.overlay !== 'none' ||
    ui.urlbar.open ||
    ui.drag !== null ||
    ui.siteInfoOpen ||
    ui.blockedPopupsPanel !== null ||
    ui.securityPromptOpen ||
    ui.permissionPromptOpen ||
    ui.pageDialogOpen ||
    ui.windowPromptOpen ||
    ui.clearBrowsingDataOpen ||
    ui.autofillPrompt !== null
  )
}

/**
 * Zen window sync: a tab selected in two windows keeps a single live page. The window that does
 * not hold it shows a dimmed preview; focusing (or clicking) brings the page over.
 */
function ForeignTabPreview({ tabId }: { tabId: string }): JSX.Element {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const capture = (): void => {
      void cmd('overlay.snapshot', { tabId })
        .then((data) => {
          if (!cancelled && data) setSnapshot(data)
        })
        .catch(() => undefined)
    }
    capture()
    const timer = setInterval(capture, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [tabId])
  return (
    <div
      className="absolute inset-0 z-10 cursor-pointer"
      onClick={() => run('tab.activate', { tabId })}
      title="Click to show this tab here"
    >
      {snapshot && (
        <img
          src={snapshot}
          alt=""
          className="h-full w-full object-cover object-top"
          draggable={false}
        />
      )}
      <div className="absolute inset-0 bg-black/40" />
      <div className="zen-panel zen-animate-in absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 px-4 py-2.5 text-[13px]">
        <MonitorSmartphone className="h-4 w-4 opacity-70" />
        <span>Open in another window</span>
        <span className="text-[var(--zen-muted)]">· click to bring it here</span>
      </div>
    </div>
  )
}

function EmptyState(): JSX.Element {
  // The chord from the active key table (`Ctrl T`, `⌘T`); nothing while New Tab is unbound.
  const chord = useChord('tab.new')?.replace(/\+(?=.)/g, ' ')
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[var(--zen-muted)]">
      <div className="text-lg font-medium text-[var(--zen-fg)]">This space is empty</div>
      <p className="text-[13px]">Open a new tab to start browsing.</p>
      <button
        type="button"
        className="mt-2 inline-flex h-9 items-center gap-2 rounded-full bg-[var(--zen-element-bg)] px-4 text-[13px] text-[var(--zen-fg)] hover:bg-[var(--zen-element-bg-hover)]"
        onClick={() => window.dispatchEvent(new CustomEvent('zen-new-tab'))}
      >
        <Plus className="h-4 w-4" /> New Tab
        {chord && <kbd className="zen-kbd zen-kbd-hint ml-1">{chord}</kbd>}
      </button>
    </div>
  )
}

const ZONE_CLASS =
  'absolute flex items-center justify-center rounded-xl border-2 border-dashed border-white/30 text-[13px] font-medium text-white/80 transition-colors'

/**
 * Zen: drop a dragged tab on an edge of the content area to split it with the active tab (Chrome
 * and Edge's edge drop), or to join the split shown here as a pane on that side. With a split
 * open each pane is a target too (Edge): the dragged tab takes the pane over from the tab shown
 * in it, or – dragged from another pane of the same split – swaps panes with it. The edge zones
 * lie over the panes and win where they overlap.
 */
function SplitDropZones({
  dropKey,
  group,
  area,
  draggedTabId
}: {
  dropKey: string | null
  group: SplitGroup | null
  area: Rect
  draggedTabId: string
}): JSX.Element {
  const { coarse } = useViewport()
  const zone = (key: string, className: string, label: string): JSX.Element => (
    <div
      data-drop={`split:${key}`}
      className={cn(
        ZONE_CLASS,
        'pointer-events-auto',
        className,
        dropKey === `split:${key}` && 'border-white bg-white/20'
      )}
    >
      {label}
    </div>
  )
  const panes = group
    ? splitPaneRects(area, group, coarse ? SPLIT_GAP_TOUCH : SPLIT_GAP).filter(
        (p) => p.tabId !== draggedTabId
      )
    : []
  const swap = group?.tabIds.includes(draggedTabId) ?? false
  return (
    <div className="absolute inset-0 z-20">
      {panes.map((p) => (
        <div
          key={p.tabId}
          data-drop={`pane:${p.tabId}`}
          className={cn(ZONE_CLASS, dropKey === `pane:${p.tabId}` && 'border-white bg-white/20')}
          style={{
            left: p.header.x + PANE_INSET,
            top: p.header.y + PANE_INSET,
            width: Math.max(0, p.header.width - PANE_INSET * 2),
            height: Math.max(0, p.header.height + p.rect.height - PANE_INSET * 2)
          }}
        >
          {swap ? 'Swap panes' : 'Replace this pane'}
        </div>
      ))}
      {/* The zones' frame lets the pointer through to the panes; the zones themselves take it. */}
      <div className="pointer-events-none absolute inset-0 p-4">
        <div className="relative h-full w-full">
          {zone('left', 'left-0 top-[20%] bottom-[20%] w-[22%]', 'Split left')}
          {zone('right', 'right-0 top-[20%] bottom-[20%] w-[22%]', 'Split right')}
          {zone('top', 'top-0 left-[26%] right-[26%] h-[18%]', 'Split top')}
          {zone('bottom', 'bottom-0 left-[26%] right-[26%] h-[18%]', 'Split bottom')}
        </div>
      </div>
    </div>
  )
}

/** A pane's target keeps clear of its edges: the gap beside it and the page's rounded corners. */
const PANE_INSET = 16
