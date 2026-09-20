import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Copy, Languages } from 'lucide-react'
import type { TranslateSelectionResult } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { usePopover } from '@renderer/hooks/usePopover'
import { placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { cmd } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import {
  ChromePortal,
  FrameDialogPortal,
  POPOVER_WIDTH,
  popoverStyle,
  useFrameDialog,
  useLightDismiss
} from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { closeTranslateSelection, languageOptions, translateStateOf } from '@renderer/lib/translate'
import {
  browserStore,
  contentAreaStore,
  uiStore,
  type TranslateSelectionRequest
} from '@renderer/lib/ui'
import { formatBytes } from '@renderer/lib/utils'
import { V2Button, V2TitleBlock } from '../extensions/v2'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { ControlRow } from './ControlRow'
import { Menulist } from './Menulist'

/**
 * Selection translation: the text the user selected, translated into a language they read, as
 * a popover where they asked on the desktop and a sheet on phones. Mounted once above whichever
 * shell is up (Root); the core opens it with the `translate.selection` event from the context
 * menu. Either surface holds the page's capture behind it while it is up (`useFloatingChrome`):
 * the popover overhangs the content frame, the sheet stands over it.
 */
export function TranslateSelectionLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.translateSelection)
  const state = browserStore.use((s) => s.state)
  const viewport = useViewport()
  const tab = request && state ? state.tabs[request.tabId] : undefined
  const active = state ? activeTab(state)?.id : undefined
  // The tab closed, or another tab came to the front: the popover belonged to the first one.
  useEffect(() => {
    if (request && (!tab || active !== request.tabId)) closeTranslateSelection()
  }, [request, tab, active])
  if (!request || !tab || !state) return null
  return viewport.formFactor === 'phone' ? (
    <PhoneSheet request={request} state={state} />
  ) : (
    <Popover request={request} state={state} />
  )
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Outcome {
  key: string
  result: TranslateSelectionResult | null
  error: string | null
}

interface Translation {
  result: TranslateSelectionResult | null
  error: string | null
  loading: boolean
  /** The language the translation goes into: the user's pick, else the result's. */
  target: string | null
  setTarget: (code: string) => void
}

/** Translate the request's text, again whenever the target changes. */
function useSelectionTranslation(request: TranslateSelectionRequest): Translation {
  const [target, setTarget] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const key = `${request.tabId}|${request.text}|${target ?? ''}`
  useEffect(() => {
    let cancelled = false
    cmd('translate.selection', {
      tabId: request.tabId,
      text: request.text,
      target: target ?? undefined
    }).then(
      (result) => {
        if (!cancelled)
          setOutcome({ key, result, error: result ? null : 'There is nothing to translate.' })
      },
      (error: unknown) => {
        if (!cancelled) setOutcome({ key, result: null, error: commandErrorMessage(error) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [key, request.tabId, request.text, target])
  const settled = outcome?.key === key ? outcome : null
  return {
    result: settled?.result ?? null,
    error: settled?.error ?? null,
    loading: settled === null,
    target: target ?? outcome?.result?.target ?? null,
    setTarget
  }
}

/** The message of a failed command, without the host's IPC wrapping. */
function commandErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

// ---------------------------------------------------------------------------
// Content shared by the popover and the sheet
// ---------------------------------------------------------------------------

function useCopy(text: string | null): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return {
    copied,
    copy: () => {
      if (!text) return
      void navigator.clipboard?.writeText(text).then(
        () => setCopied(true),
        () => undefined
      )
    }
  }
}

/**
 * The languages row (§9.21: 40 tall around its 32 px menulist on the desktop, 48 around 40 on a
 * phone, the primitive's `data-control`): which language the text is in, and the menulist for
 * the one it goes into. Not a target itself – the menulist is – so it is the shared row's
 * static form (§9.34), at the surface's gutter.
 */
function LanguagesRow({
  state,
  translation,
  glyph
}: {
  state: UIState
  translation: Translation
  /** A leading glyph, where the surface's header has none (the phone sheet). */
  glyph?: boolean
}): JSX.Element {
  const source = translation.result?.source ?? null
  return (
    <ControlRow>
      {glyph && <Languages className="zen-translate-glyph" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">
        {source ? `${languageName(source)} to` : 'Translate to'}
      </span>
      <Menulist
        value={translation.target}
        options={languageOptions(state.translate.languages, source)}
        onChange={translation.setTarget}
        label="Translate to"
        placeholder="Choose a language"
      />
    </ControlRow>
  )
}

/** The translation, or what stands in for it while it is on its way. */
function ResultText({
  request,
  state,
  translation
}: {
  request: TranslateSelectionRequest
  state: UIState
  translation: Translation
}): JSX.Element {
  const download = translateStateOf(state, request.tabId)?.download ?? null
  let body: ReactNode
  if (translation.loading) {
    body = (
      <span className="zen-translate-caption">
        {download && download.total > 0
          ? `Getting the translation model… ${formatBytes(download.received)} of ${formatBytes(download.total)}`
          : 'Translating…'}
      </span>
    )
  } else if (translation.error) {
    body = <span className="zen-translate-danger">{translation.error}</span>
  } else {
    body = translation.result?.translation
  }
  return (
    <div className="zen-translate-result" aria-live="polite">
      {body}
    </div>
  )
}

/** The body both surfaces share: the languages row, the original, a hairline, the translation. */
function Body({
  request,
  state,
  translation,
  glyph
}: {
  request: TranslateSelectionRequest
  state: UIState
  translation: Translation
  glyph?: boolean
}): JSX.Element {
  return (
    <>
      <LanguagesRow state={state} translation={translation} glyph={glyph} />
      <p className="zen-translate-original">{request.text}</p>
      <div className="zen-translate-rule" />
      <ResultText request={request} state={state} translation={translation} />
    </>
  )
}

/** The one action: copy the translation; "Copied" with a check for a moment after. */
function CopyButton({ translation }: { translation: Translation }): JSX.Element {
  const { copied, copy } = useCopy(translation.result?.translation ?? null)
  return (
    <V2Button disabled={!translation.result} onClick={copy}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </V2Button>
  )
}

// ---------------------------------------------------------------------------
// Desktop and tablet: a popover where the user asked
// ---------------------------------------------------------------------------

/**
 * Where the user asked, in window pixels, as a point anchor for the chrome layer's placement
 * (§9.20: a right-click has no control to hang from – the popover's start edge aligns with the
 * point and flips to end there when the window's edge is near). A request without a point sits
 * high in the page's middle.
 */
function pointAnchor(request: TranslateSelectionRequest): Anchor {
  const area = contentAreaStore.get().area ?? {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight
  }
  return {
    x: area.x + (request.x ?? area.width / 2),
    y: area.y + (request.y ?? area.height / 3),
    width: 0,
    height: 0
  }
}

/**
 * The popover (§9.20, §9.23): 400 wide – a row with a control and text that wraps – through the
 * chrome layer, placed once at the point the user asked and held to the layer's height cap (60%
 * of the window), its body scrolling under the title block; a title block – glyph and
 * "Translation" – over the body and a footer that hugs its one button. Focus moves onto its
 * menulist when it opens, Tab wraps inside it, Escape closes it and the page gets focus back
 * (§9.22); the chrome layer's light dismiss closes it otherwise (§9.20 amended: a press outside
 * it, consumed; a scroll; a resize, which makes the point stale). No X.
 */
function Popover({
  request,
  state
}: {
  request: TranslateSelectionRequest
  state: UIState
}): JSX.Element | null {
  const translation = useSelectionTranslation(request)
  const ready = useFloatingChrome()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [scrolled, setScrolled] = useState(false)
  // Placed once for the request (§9.20: never re-fitted to its content); a resize closes it.
  const { anchor, box } = useMemo(() => {
    const anchor = pointAnchor(request)
    return { anchor, box: placeUnder(anchor, POPOVER_WIDTH.form) }
  }, [request])

  // The page had focus (the request came from its context menu) and gets it back on release
  // (`useFloatingChrome`); no chrome control opened the popover for focus to return to.
  usePopover(ref, { onClose: closeTranslateSelection, active: ready, returnTo: null })
  useLightDismiss(ref, closeTranslateSelection)
  // A tablet's system back gesture closes it as Escape does.
  useBackSurface({ name: 'translate-selection', onCommit: () => closeTranslateSelection() })

  if (!ready) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        role="dialog"
        aria-labelledby={titleId}
        className="zen-v2 zen-v2-panel zen-translate-panel zen-animate-pop fixed"
        style={{ ...popoverStyle(box), transformOrigin: popOrigin(anchor, box) }}
      >
        <V2TitleBlock
          id={titleId}
          title="Translation"
          glyph={<Languages aria-hidden />}
          scrolled={scrolled}
        />
        <div
          className="zen-translate-panel-body"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          <Body request={request} state={state} translation={translation} />
        </div>
        <div className="zen-translate-footer">
          <CopyButton translation={translation} />
        </div>
      </div>
    </ChromePortal>
  )
}

// ---------------------------------------------------------------------------
// Phone: a sheet
// ---------------------------------------------------------------------------

/**
 * The phone's surface is a modal dialog, so it mounts in the frame's dialog host
 * (lib/portals.tsx, `FrameDialogPortal`) on the shared `BottomSheet`, once the page's capture
 * is in place (`useFloatingChrome`); focus, Tab, the inert chrome behind the scrim and the
 * return of focus are the chassis's (#172).
 */
function PhoneSheet(props: {
  request: TranslateSelectionRequest
  state: UIState
}): JSX.Element | null {
  const ready = useFloatingChrome()
  if (!ready) return null
  return (
    <FrameDialogPortal>
      <HostedSheet {...props} />
    </FrameDialogPortal>
  )
}

/**
 * The sheet (§9.16, §9.25): the grip strip and the 48 header – "Translation" centred, no
 * description, so no title block (§9.23) – over a body at the sheet's one 16 gutter, and the
 * chassis footer with Copy filling the width (§9.11). The target menulist opens its own sheet
 * over this one (§9.24: depth two, the chassis receding this sheet under the top one's scrim);
 * Escape, the scrim and the back gesture close the top sheet only.
 */
function HostedSheet({
  request,
  state
}: {
  request: TranslateSelectionRequest
  state: UIState
}): JSX.Element {
  const translation = useSelectionTranslation(request)
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: 'translate-selection',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)

  return (
    <BottomSheet
      ref={sheet}
      hosted
      className="zen-translate-sheet"
      labelledBy={titleId}
      onDismissed={() => closeTranslateSelection()}
      contentKey={`${request.tabId}:${translation.loading ? 'loading' : 'done'}`}
      header={
        <h2 id={titleId} className="zen-sheet-title">
          Translation
        </h2>
      }
      footer={<CopyButton translation={translation} />}
    >
      <div className="zen-v2 zen-translate-sheet-body">
        <Body request={request} state={state} translation={translation} glyph />
      </div>
    </BottomSheet>
  )
}
