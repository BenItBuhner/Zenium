import type { JSX, PointerEvent as ReactPointerEvent, Ref } from 'react'
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Monitor, ScrollText, SquareDashedMousePointer, TriangleAlert, X } from 'lucide-react'
import { regionFromChrome, type PageCaptureResult } from '@shared/capture'
import { TOAST_SHOW_MS } from '@shared/toastCard'
import type { Rect, UIState } from '@shared/types'
import { usePopover } from '@renderer/hooks/usePopover'
import { cmd } from '@renderer/lib/api'
import {
  captureOpener,
  capturePage,
  captureReducer,
  closeCapture,
  fileNameOf,
  fitPicture,
  labelPlacement,
  marqueeOf,
  marqueeSize,
  nudgePaint,
  pageFrame,
  PAINT_TIMEOUT_MS,
  scrimClipPath,
  SELECTING,
  sizeText,
  type Point
} from '@renderer/lib/captureOverlay'
import { useViewport } from '@renderer/lib/formFactor'
import { SPLIT_GAP, SPLIT_GAP_TOUCH } from '@renderer/lib/layout'
import { holdChromeInert, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, contentAreaStore, uiStore, type UiState } from '@renderer/lib/ui'
import { V2Button, V2IconButton, V2Row, V2TitleBlock } from '../extensions/v2'

const HINT_ID = 'zen-capture-hint'
const TITLE_ID = 'zen-capture-title'
const DESCRIPTION_ID = 'zen-capture-description'

/** The toolbar's distance from the page's top edge, and the result card's picture from its frame. */
const TOOLBAR_INSET = 12
const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 }

/**
 * The desktop's Web capture (Edge's, over services' capture engine: `shared/capture.ts`) in the
 * frame dialog host `TabDialogs` mounts. Up while `uiStore.capture` names a tab
 * (`openCapture`, on the core's `capture.start`: Ctrl+Shift+S in the Chrome preset, the app
 * menu's Web Capture… row, the page menu's Capture Page…, the palette); down again the moment
 * the flag clears. One opening is one `CaptureOverlay` (`seq`), so a later ask starts clean.
 */
export function CaptureLayer(): JSX.Element | null {
  const capture = uiStore.use((s) => s.capture)
  const state = browserStore.use((s) => s.state)
  if (!capture || !state) return null
  return <CaptureOverlay key={capture.seq} capture={capture} state={state} />
}

/**
 * The overlay itself, over the page's picture that stands in for the live view: the §9.5 scrim
 * on the content frame alone (the sidebar and toolbar undimmed and inert), drawn here rather
 * than by the host so the marquee can be a cut-out of it – the selected part of the page shows
 * undimmed inside a 2 px accent outline with its size, in the picture's device pixels, on a 13
 * px label at the marquee's bottom-right corner (above it when there is no room below). A
 * small §9.20 panel at the top centre of the page holds the three ways to capture (§9.3
 * buttons: Free select, on while a drag would draw the marquee – off, at .4, where the host
 * cannot say where the page is scrolled to – then Visible area and Full page, which capture at
 * once) and a Cancel. The cursor is a crosshair over the page. A release maps the marquee's
 * chrome box to the page's document (`regionFromChrome`, §3 of the engine's contract) and asks
 * `page.capture`; the answer is the result card (`ResultCard`), a refusal the failed card
 * (`FailedCard`): the engine's budget refusal in its own sentence, "Nothing to capture" for a
 * page that gave no picture, and the overlay's own words for a paint that never came
 * (`PAINT_TIMEOUT_MS`). While the paint is out the hidden view is nudged into a frame for it
 * (`nudgePaint`) – the page is behind its stand-in, as under every chrome surface, and the
 * engine's debugger paint waits for a frame a hidden view does not give of itself.
 *
 * Keyboard (§9.22): focus lands on the overlay's container; Tab reaches the toolbar's buttons,
 * then the card's, wrapping; Escape closes from any phase at once – the picture is let go, the
 * live page comes back and the focus returns to what asked for the capture (the ⋯ button) or
 * to the page (capture-16: no half state). A scrim press with a card up is Close too. The
 * overlay is the tab's: another tab in front, or the tab gone, takes it down.
 */
function CaptureOverlay({
  capture,
  state
}: {
  capture: NonNullable<UiState['capture']>
  state: UIState
}): JSX.Element {
  const { tabId, viewport } = capture
  const ref = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const [phase, dispatch] = useReducer(captureReducer, SELECTING)
  const [toast, setToast] = useState<{ id: number; text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null)
  const gone = useRef(false)

  // The overlay's own box in window coordinates, for the page's frame and the pointer to be
  // read against (the host's slot fills the content frame's box; the page's area is a part of it).
  const area = contentAreaStore.use((s) => s.area)
  const [box, setBox] = useState<Rect>(EMPTY)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setBox((prev) =>
        prev.x === r.left && prev.y === r.top && prev.width === r.width && prev.height === r.height
          ? prev
          : { x: r.left, y: r.top, width: r.width, height: r.height }
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])
  const gap = useViewport().coarse ? SPLIT_GAP_TOUCH : SPLIT_GAP
  const frame = useMemo<Rect>(() => {
    const page = pageFrame(state, tabId, area ?? box, gap)
    return { x: page.x - box.x, y: page.y - box.y, width: page.width, height: page.height }
  }, [area, box, state, tabId, gap])

  // The chrome is inert while the overlay is up (§9.5, §9.22), as the host would hold it for a
  // dialog with the host's scrim. Declared before `usePopover` so that, as the overlay unmounts,
  // this release runs before the hook's return of the focus: the opener is not inert then.
  useLayoutEffect(() => holdChromeInert(), [])
  useFrameDialog({ ownScrim: true })
  const close = (): void => dispatch({ type: 'escape' })
  usePopover(ref, { onClose: close, initial: 'container', returnTo: captureOpener() })

  // The overlay is the tab's: another tab in front, or the tab gone, takes it down.
  const onScreen = activeTab(state)?.id === tabId || state.glance?.tabId === tabId
  useEffect(() => {
    if (!onScreen) dispatch({ type: 'close' })
  }, [onScreen])

  // Closed, by whichever way: the flag clears (the layer unmounts this), the picture goes.
  useEffect(() => {
    if (phase.kind === 'closed') closeCapture()
  }, [phase.kind])
  useEffect(
    () => () => {
      gone.current = true
      closeCapture()
    },
    []
  )

  // The engine paints: the marquee's box mapped to the page's document, or the mode as picked.
  useEffect(() => {
    if (phase.kind !== 'capturing') return
    let stale = false
    const request =
      phase.mode === 'region'
        ? phase.marquee && viewport
          ? { mode: 'region' as const, region: regionFromChrome(phase.marquee, frame, viewport) }
          : null
        : { mode: phase.mode }
    if (!request || (request.mode === 'region' && !request.region)) {
      dispatch({ type: 'captured', result: null })
      return
    }
    const args =
      request.mode === 'region' && request.region
        ? { tabId, mode: request.mode, region: request.region, format: 'png' as const }
        : { tabId, mode: request.mode, format: 'png' as const }
    // The paint is nudged while it is out (`nudgePaint`: the hidden view paints a frame for the
    // engine's request), and given up on after `PAINT_TIMEOUT_MS` – the failed card, not a wait.
    const stopNudging = nudgePaint(tabId)
    const timeout = setTimeout(() => dispatch({ type: 'timeout' }), PAINT_TIMEOUT_MS)
    capturePage(args).then(
      (result) => {
        if (!stale) dispatch({ type: 'captured', result })
      },
      (error: unknown) => {
        if (!stale) dispatch({ type: 'failed', error })
      }
    )
    return () => {
      stale = true
      stopNudging()
      clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one paint per capturing phase
  }, [phase])

  // The keyboard follows the phase (§9.22): the card's container as a card comes up, the
  // overlay's own as the page is dimmed again for another go.
  useEffect(() => {
    if (phase.kind === 'captured' || phase.kind === 'failed') {
      cardRef.current?.focus({ preventScroll: true })
    } else if (phase.kind === 'selecting') {
      ref.current?.focus({ preventScroll: true })
    }
  }, [phase.kind])

  // The size label sits at the marquee's corner once it has a width to place (`labelPlacement`).
  const marquee =
    phase.kind === 'selecting' && phase.drag
      ? marqueeOf(phase.drag, frame)
      : phase.kind === 'capturing'
        ? phase.marquee
        : null
  useLayoutEffect(() => {
    const el = labelRef.current
    if (!el || !marquee) return
    const { x, y } = labelPlacement(marquee, frame, {
      width: el.offsetWidth,
      height: el.offsetHeight
    })
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [marquee, frame])

  // A toast stands §9.33's 2.8 s, a newer one restarting the clock.
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_SHOW_MS)
    return () => clearTimeout(timer)
  }, [toast])
  const toastSeq = useRef(0)
  const say = (text: string, error = false): void => {
    if (gone.current) return
    setToast({ id: ++toastSeq.current, text, error })
  }

  const selecting = phase.kind === 'selecting'
  const canSelect = selecting && viewport !== null
  const toRoot = (e: ReactPointerEvent): Point => {
    const r = ref.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!canSelect || e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('[data-capture-toolbar]')) return
    e.preventDefault()
    ref.current?.setPointerCapture(e.pointerId)
    dispatch({ type: 'dragStart', at: toRoot(e) })
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (selecting && phase.drag) dispatch({ type: 'dragMove', at: toRoot(e) })
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!(selecting && phase.drag)) return
    dispatch({ type: 'dragMove', at: toRoot(e) })
    dispatch({ type: 'dragEnd', frame })
  }
  const onPointerCancel = (): void => {
    if (selecting && phase.drag) dispatch({ type: 'dragCancel' })
  }

  const copy = async (result: PageCaptureResult): Promise<void> => {
    if (busy) return
    setBusy('copy')
    try {
      const ok = await cmd('capture.copy', { dataUrl: result.dataUrl })
      say(ok ? 'Copied' : 'Couldn’t copy the picture', !ok)
    } catch {
      say('Couldn’t copy the picture', true)
    } finally {
      if (!gone.current) setBusy(null)
    }
  }
  const save = async (result: PageCaptureResult): Promise<void> => {
    if (busy) return
    setBusy('save')
    try {
      const saved = await cmd('capture.save', { dataUrl: result.dataUrl, tabId })
      if (saved) say(`Saved ${fileNameOf(saved.path)}`)
      else say('Couldn’t save the picture', true)
    } catch {
      say('Couldn’t save the picture', true)
    } finally {
      if (!gone.current) setBusy(null)
    }
  }

  const frameStyle = {
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height
  }
  const cardUp = phase.kind === 'captured' || phase.kind === 'failed'
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Web capture"
      aria-describedby={selecting ? HINT_ID : undefined}
      tabIndex={-1}
      className="zen-capture zen-v2"
      // The slot's child that draws the stack's one scrim itself: its own layer to the host,
      // which then never keeps it as a panel on another dialog's way out (`useLeavingPanels`).
      data-sheet-layer="true"
      data-capture={phase.kind}
      data-selecting={canSelect || undefined}
      aria-busy={phase.kind === 'capturing' || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The frame's one dim (§9.5), the marquee cut out of it while one is drawn. */}
      <div
        className="zen-capture-scrim zen-animate-fade"
        style={{ clipPath: scrimClipPath(marquee) }}
        onPointerDown={cardUp ? () => dispatch({ type: 'close' }) : undefined}
      />
      <p id={HINT_ID} className="sr-only">
        {viewport
          ? 'Drag over the page to select an area, or take the visible area or the full page from the toolbar. Escape cancels.'
          : 'Take the visible area or the full page from the toolbar. Escape cancels.'}
      </p>
      {marquee && (
        <>
          <div className="zen-capture-marquee" style={rectStyle(marquee)} data-capture-marquee />
          <div ref={labelRef} className="zen-capture-size zen-v2-panel" data-capture-size>
            {sizeText(marqueeSize(marquee, frame, viewport))}
          </div>
        </>
      )}
      {selecting && (
        <div
          className="zen-capture-toolbar zen-v2-panel zen-animate-pop"
          role="toolbar"
          aria-label="Capture"
          data-capture-toolbar
          style={{ left: frame.x + frame.width / 2, top: frame.y + TOOLBAR_INSET }}
        >
          <button
            type="button"
            className="zen-v2-button zen-capture-mode"
            aria-pressed={canSelect}
            disabled={!viewport}
            title={viewport ? undefined : 'The page’s position could not be read'}
            data-capture-free
          >
            <SquareDashedMousePointer aria-hidden />
            Free select
          </button>
          <button
            type="button"
            className="zen-v2-button zen-capture-mode"
            onClick={() => dispatch({ type: 'pick', mode: 'viewport' })}
            data-capture-visible
          >
            <Monitor aria-hidden />
            Visible area
          </button>
          <button
            type="button"
            className="zen-v2-button zen-capture-mode"
            onClick={() => dispatch({ type: 'pick', mode: 'fullPage' })}
            data-capture-full
          >
            <ScrollText aria-hidden />
            Full page
          </button>
          <span className="zen-capture-toolbar-sep" aria-hidden />
          <V2IconButton
            icon={X}
            label="Cancel capture"
            onClick={() => dispatch({ type: 'close' })}
            data-capture-cancel
          />
        </div>
      )}
      {phase.kind === 'captured' && (
        <div className="zen-capture-stage" style={frameStyle}>
          <ResultCard
            ref={cardRef}
            result={phase.result}
            frame={frame}
            busy={busy}
            onClose={() => dispatch({ type: 'close' })}
            onCopy={() => void copy(phase.result)}
            onSave={() => void save(phase.result)}
          />
        </div>
      )}
      {phase.kind === 'failed' && (
        <div className="zen-capture-stage" style={frameStyle}>
          <FailedCard
            ref={cardRef}
            title={phase.title}
            message={phase.message}
            again={phase.mode === 'region' ? 'Select again' : 'Try again'}
            onClose={() => dispatch({ type: 'close' })}
            onAgain={() => dispatch({ type: 'again' })}
          />
        </div>
      )}
      {toast && (
        <div className="zen-capture-stage" style={frameStyle}>
          <div
            key={toast.id}
            className="zen-message zen-message-toast zen-capture-toast"
            data-surface="page"
            data-kind={toast.error ? 'error' : 'info'}
            role="status"
            data-capture-toast
          >
            <span className="zen-message-text">{toast.text}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The result: a §9.20 dialog at the form width (400: a picture with a caption and three
 * footer buttons is more than a 320 notice and no table), centred over the page as Edge's is
 * – a title block (§9.23) with the picture's size in its own pixels as the description, the
 * picture scaled to fit (never up) on an inner box, a status row when the engine could paint
 * only the visible area (§9.33's anatomy in the warn ink: the user asked for more than they
 * got), then the §9.11 footer: Close, Copy, and Save as the primary. Copy and Save keep the
 * card up and say what they did on a §9.33 toast 8 px inside the page's bottom edge ("Copied";
 * "Saved" with the file's name); the host's downloads bubble shows the file as it would any
 * finished download. Focus lands on the card's container – a `role="dialog"` at `tabIndex`
 * −1, §9.22's form for a container that holds the keyboard, which the chassis paints no ring
 * around (the whole-card ring the `zen-v2-*` rule would give a group) – and Tab reaches Close,
 * Copy, Save.
 */
function ResultCard({
  ref,
  result,
  frame,
  busy,
  onClose,
  onCopy,
  onSave
}: {
  ref: Ref<HTMLDivElement>
  result: PageCaptureResult
  frame: Rect
  busy: 'copy' | 'save' | null
  onClose: () => void
  onCopy: () => void
  onSave: () => void
}): JSX.Element {
  const picture = fitPicture(result, {
    width: POPOVER_WIDTH.form - 2 * 16 - 2,
    height: Math.max(96, Math.round(frame.height * 0.5))
  })
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESCRIPTION_ID}
      tabIndex={-1}
      className="zen-v2 zen-v2-dialog zen-animate-pop zen-capture-card flex max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
      data-capture-result={result.fallback ?? 'ok'}
    >
      <V2TitleBlock
        id={TITLE_ID}
        title="Web capture"
        description={`${sizeText(result)} pixels`}
        descriptionId={DESCRIPTION_ID}
      />
      <div className="zen-capture-picture">
        <div className="zen-capture-picture-box" style={picture}>
          <img
            src={result.dataUrl}
            alt="The captured part of the page"
            width={picture.width}
            height={picture.height}
            draggable={false}
          />
        </div>
      </div>
      {result.fallback === 'viewport' && (
        <V2Row
          className="zen-capture-note"
          label="Visible area captured"
          description="The page couldn’t be captured whole, so this is what was on screen."
          tone="warn"
        >
          <TriangleAlert className="zen-v2-row-trail" aria-hidden />
        </V2Row>
      )}
      <div className="flex justify-end gap-2 px-4 pb-4 pt-4">
        <V2Button onClick={onClose} data-capture-close>
          Close
        </V2Button>
        <V2Button busy={busy === 'copy'} onClick={onCopy} data-capture-copy>
          Copy
        </V2Button>
        <V2Button variant="primary" busy={busy === 'save'} onClick={onSave} data-capture-save>
          Save
        </V2Button>
      </div>
    </div>
  )
}

/**
 * The engine refused or failed: a §9.20 notice at 320 – the title names the case (the budget
 * refusal, a page that gave no picture, anything else), the description is the engine's own
 * sentence (`captureErrorMessage`: complete, with what to do), and the footer offers Close and
 * a way back to the dimmed page for another go. The same `role="dialog"` container as the
 * result's holds the keyboard, ringless.
 */
function FailedCard({
  ref,
  title,
  message,
  again,
  onClose,
  onAgain
}: {
  ref: Ref<HTMLDivElement>
  title: string
  message: string
  again: string
  onClose: () => void
  onAgain: () => void
}): JSX.Element {
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESCRIPTION_ID}
      tabIndex={-1}
      className="zen-v2 zen-v2-dialog zen-animate-pop zen-capture-card flex max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.list }}
      data-capture-failed
    >
      <V2TitleBlock
        id={TITLE_ID}
        title={title}
        description={message}
        descriptionId={DESCRIPTION_ID}
      />
      <div className="flex justify-end gap-2 px-4 pb-4">
        <V2Button onClick={onClose} data-capture-close>
          Close
        </V2Button>
        <V2Button variant="primary" onClick={onAgain} data-capture-again>
          {again}
        </V2Button>
      </div>
    </div>
  )
}

function rectStyle(r: Rect): { left: number; top: number; width: number; height: number } {
  return { left: r.x, top: r.y, width: r.width, height: r.height }
}
