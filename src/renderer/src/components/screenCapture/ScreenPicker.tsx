import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AppWindow, Globe, Monitor } from 'lucide-react'
import type { ScreenCaptureRequest, ScreenCaptureSource, UIState } from '@shared/types'
import { useChromeSurface } from '@renderer/hooks/useChromeSurface'
import { activeTab } from '@renderer/lib/selectors'
import { usePopover } from '@renderer/hooks/usePopover'
import { run } from '@renderer/lib/api'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import {
  PICKER_TITLE,
  type PickerPane,
  closeScreenPicker,
  currentScreenCaptureRequest,
  effectiveSelection,
  emptyPaneText,
  gridMove,
  initialPane,
  openScreenPicker,
  paneColumns,
  panesOf,
  pickerDescription,
  sourcesIn
} from '@renderer/lib/screenPicker'
import { useThumbnail } from '@renderer/lib/thumbnails'
import { cn } from '@renderer/lib/utils'
import { ExtensionIcon } from '../extensions/ExtensionIcon'
import { V2Button, V2TitleBlock } from '../extensions/v2'

const TITLE_ID = 'zen-scpick-title'
const DESCRIPTION_ID = 'zen-scpick-description'

/**
 * The screen-capture picker (MW-19) in the frame dialog host `TabDialogs` mounts: the
 * `screenCapture` surface (`ChromeSurface`) of a host whose pages can capture – the core holds a
 * page's `getDisplayMedia` for a window only while this is up, and refuses it as Chrome's cancel
 * would while it is not – so the layer registers on those hosts alone. A page's request is
 * tab-modal like Chrome's: the request of the window's active tab shows; another tab in front
 * hides it until its tab is back, and a closed or navigated tab takes its request with it (the
 * core answers the page). An extension's request is modal to its window, over whichever tab is
 * active there (Chrome's `chooseDesktopMedia` picker is modal to the target's browser window).
 */
export function ScreenPickerLayer({ state }: { state: UIState }): JSX.Element | null {
  const capable = state.capabilities.screenCapture
  useChromeSurface('screenCapture', capable)
  const request = capable ? currentScreenCaptureRequest(state) : null
  const under = activeTab(state)?.id ?? request?.tabId
  return request ? <ScreenPicker key={request.id} request={request} under={under} /> : null
}

/**
 * Chrome's "Choose what to share" as a `--v2-dialog` at the table width (§9.20) over the host's
 * scrim, which does not answer it (Chrome's picker stays up until Cancel, Share or Escape): a
 * title block (§9.23) naming the site, then the three panes on the shared segment – Zenium tab,
 * Window, Entire screen, in Chrome's order – each a grid of image radio cards (§9.34: the 2 px
 * accent outline on the picked one) with the source's picture over its icon and name, the
 * calling tab first; the Window and Entire screen panes are busy (§9.30) until the OS's list is
 * in and say so when it holds nothing. One pick per pane; the only screen there is comes picked.
 * The §9.11 footer hugs and right-aligns Cancel and the one primary (§9.33) Share, which needs a
 * pick and goes busy once pressed; a double-click or Enter on the picked card is Share too. On
 * the Entire screen pane, where the OS can hand its sound along (Windows), "Also share system
 * audio" leads the footer when the page asked for audio. Arrow keys move the pick in a pane and
 * switch panes on the segment; focus starts on the calling tab's card, Tab wraps (§9.22), Escape
 * is Cancel. Cancel is the page's refusal (NotAllowedError), as Chrome's.
 *
 * An extension's request (`chrome.desktopCapture.chooseDesktopMedia`) is the same dialog with
 * the extension's icon at the title's start and its name where the site's goes – "with
 * <site>" when it captures for a site's tab – and only the panes it asked for: one pane stands
 * alone, with no segment over it, as Chrome's does. `under` is the tab whose page the dialog
 * covers: the calling tab, or for an extension's window-modal request the window's active tab.
 */
function ScreenPicker({
  request,
  under = request.tabId
}: {
  request: ScreenCaptureRequest
  under?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const answered = useRef(false)
  const [busy, setBusy] = useState(false)
  const panes = panesOf(request)
  const [pane, setPane] = useState<PickerPane>(() => initialPane(request))
  const [chosen, setChosen] = useState<Record<PickerPane, string | null>>({
    tab: null,
    window: null,
    screen: null
  })
  const [audio, setAudio] = useState(true)
  // The keyboard's place in the pane's grid (roving tabindex), by source id.
  const [focused, setFocused] = useState<string | null>(null)
  // The cards have scrolled under the segment (§9.7: its hairline shows then, not at rest).
  const [scrolled, setScrolled] = useState(false)
  const list = useRef<HTMLDivElement>(null)

  // The list box is one element across the panes: a new pane starts at its top (the scroll
  // back to 0 reports through onScroll, which puts the hairline away).
  const switchPane = (id: PickerPane): void => {
    setPane(id)
    if (list.current) list.current.scrollTop = 0
  }

  // The page's view hides under chrome overlays; its snapshot stands in while the picker is up –
  // and is the calling tab's own card picture. A window-modal picker follows the active tab.
  useEffect(() => {
    let gone = false
    void openScreenPicker(under).then(() => {
      if (gone) closeScreenPicker()
    })
    return () => {
      gone = true
      closeScreenPicker()
    }
  }, [under])

  const sources = sourcesIn(request, pane)
  const selected = effectiveSelection(pane, sources, chosen[pane])
  const columns = paneColumns(pane, sources.length)
  const loading = request.loading && pane !== 'tab'
  const offerAudio = pane === 'screen' && request.audio && request.systemAudio

  const answer = (sourceId: string | null): void => {
    if (answered.current) return
    answered.current = true
    if (sourceId) setBusy(true)
    run('screenCapture.respond', {
      id: request.id,
      sourceId,
      audio: Boolean(sourceId && offerAudio && audio)
    })
  }
  const cancel = (): void => answer(null)
  const share = (): void => {
    if (selected) answer(selected)
  }

  const pick = (id: string): void => {
    setChosen((c) => ({ ...c, [pane]: id }))
    setFocused(id)
  }

  const onGridKey = (e: ReactKeyboardEvent<HTMLElement>, index: number): void => {
    if (e.key === 'Enter') {
      const id = sources[index]?.id
      if (!id) return
      e.preventDefault()
      if (id === selected) share()
      else pick(id)
      return
    }
    const next = gridMove(e.key, index, sources.length, columns)
    if (next === null) return
    e.preventDefault()
    const id = sources[next]!.id
    pick(id)
    ref.current
      ?.querySelector<HTMLElement>(`[role="radio"][data-source-id="${cssEscape(id)}"]`)
      ?.focus()
  }

  const onSegmentKey = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const index = panes.findIndex((p) => p.id === pane)
    const next = gridMove(e.key, index, panes.length, 1)
    if (next === null) return
    e.preventDefault()
    const id = panes[next]!.id
    switchPane(id)
    ref.current?.querySelector<HTMLElement>(`[role="tab"][data-pane="${id}"]`)?.focus()
  }

  useFrameDialog()
  usePopover(ref, {
    onClose: cancel,
    initial: (root) => root.querySelector<HTMLElement>('[role="radio"]'),
    returnTo: null
  })

  // The roving stop: the pick, else the card the keyboard was last on, else the first card.
  const stop =
    (selected && sources.some((s) => s.id === selected) ? selected : null) ??
    (focused && sources.some((s) => s.id === focused) ? focused : null) ??
    sources[0]?.id ??
    null

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESCRIPTION_ID}
      data-screen-picker={pane}
      className="zen-v2 zen-v2-dialog zen-animate-pop zen-scpick flex max-h-[calc(100%-32px)] max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.table }}
    >
      <V2TitleBlock
        id={TITLE_ID}
        title={PICKER_TITLE}
        scrolled={panes.length === 1 && scrolled}
        glyph={
          request.extension ? (
            <ExtensionIcon icon={request.extension.icon} size={16} box={16} />
          ) : undefined
        }
        description={<span id={DESCRIPTION_ID}>{pickerDescription(request)}</span>}
      />
      {panes.length > 1 && (
        <div
          role="tablist"
          aria-label="What to share"
          className="zen-v2-segment zen-scpick-panes"
          data-scrolled={scrolled || undefined}
          onKeyDown={onSegmentKey}
        >
          {panes.map((p) => (
            <button
              key={p.id}
              id={`zen-scpick-tab-${p.id}`}
              type="button"
              role="tab"
              aria-selected={pane === p.id}
              aria-controls={`zen-scpick-pane-${p.id}`}
              tabIndex={pane === p.id ? 0 : -1}
              data-pane={p.id}
              onClick={() => switchPane(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div
        ref={list}
        id={`zen-scpick-pane-${pane}`}
        role={panes.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={panes.length > 1 ? `zen-scpick-tab-${pane}` : undefined}
        aria-label={panes.length > 1 ? undefined : panes[0]?.label}
        className="zen-scpick-list"
        data-alone={panes.length > 1 ? undefined : ''}
        aria-busy={loading || undefined}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {loading ? (
          <div className="zen-scpick-state" data-busy="">
            <span className="zen-v2-spinner" aria-hidden />
          </div>
        ) : sources.length === 0 ? (
          <div className="zen-scpick-state">{emptyPaneText(pane)}</div>
        ) : (
          <div
            role="radiogroup"
            aria-label={panes.find((p) => p.id === pane)?.label}
            className="zen-scpick-grid"
            data-columns={columns}
          >
            {sources.map((source, index) => (
              <SourceTile
                key={source.id}
                source={source}
                current={source.id === `tab:${request.tabId}`}
                checked={source.id === selected}
                tabStop={source.id === stop}
                onPick={() => pick(source.id)}
                onOpen={() => {
                  pick(source.id)
                  answer(source.id)
                }}
                onKeyDown={(e) => onGridKey(e, index)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="zen-scpick-footer">
        {offerAudio && (
          <label className="zen-scpick-audio">
            <input
              type="checkbox"
              className="zen-v2-checkbox"
              checked={audio}
              onChange={(e) => setAudio(e.target.checked)}
            />
            Also share system audio
          </label>
        )}
        <V2Button disabled={busy} onClick={cancel}>
          Cancel
        </V2Button>
        <V2Button
          variant="primary"
          data-share=""
          disabled={!selected && !busy}
          busy={busy}
          onClick={share}
        >
          Share
        </V2Button>
      </div>
    </div>
  )
}

const KIND_GLYPH = { screen: Monitor, window: AppWindow, tab: Globe } as const

/**
 * One source as an image radio card: its picture – the OS's still for a screen or window, the
 * tab's own card picture for a tab – letterboxed in a 16:9 box (a tab's page picture, cropped
 * from its top instead), the kind's glyph in its place while there is none; under it the
 * owning app's icon or the tab's favicon at 16 and the name on one line. An icon that fails to
 * load gives way to the kind's glyph too (as the app title bar's icon does), so the caption never
 * carries an empty slot.
 */
function SourceTile({
  source,
  current,
  checked,
  tabStop,
  onPick,
  onOpen,
  onKeyDown
}: {
  source: ScreenCaptureSource
  current: boolean
  checked: boolean
  tabStop: boolean
  onPick: () => void
  onOpen: () => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
}): JSX.Element {
  const tabId = source.kind === 'tab' ? source.id.slice(4) : null
  const cover = useThumbnail(tabId, { cover: true })
  const picture = source.kind === 'tab' ? cover : source.thumbnail
  const [iconBroken, setIconBroken] = useState(false)
  const icon = source.icon && !iconBroken ? source.icon : null
  const Glyph = KIND_GLYPH[source.kind]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={tabStop ? 0 : -1}
      data-source-id={source.id}
      data-current={current || undefined}
      className="zen-v2-card-radio zen-scpick-tile"
      onClick={onPick}
      onDoubleClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <span className="zen-scpick-thumb" data-kind={source.kind} aria-hidden>
        {picture ? <img src={picture} alt="" draggable={false} /> : <Glyph />}
      </span>
      <span className="zen-scpick-caption">
        {icon ? (
          <img
            className="zen-scpick-icon"
            src={icon}
            alt=""
            draggable={false}
            onError={() => setIconBroken(true)}
          />
        ) : (
          <Glyph className="zen-scpick-icon" />
        )}
        <span className={cn('zen-scpick-name', 'truncate')}>{source.name}</span>
      </span>
    </button>
  )
}

/** A source id inside an attribute selector (`CSS.escape` is not in every test DOM). */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}
