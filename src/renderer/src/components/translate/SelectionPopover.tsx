import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, Languages } from 'lucide-react'
import type { TranslateSelectionResult } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import { cmd } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { activeTab } from '@renderer/lib/selectors'
import {
  closeTranslateSelection,
  languageOptions,
  placeAtPoint,
  POPOVER_MARGIN,
  translateStateOf
} from '@renderer/lib/translate'
import {
  browserStore,
  contentAreaStore,
  uiStore,
  type TranslateSelectionRequest
} from '@renderer/lib/ui'
import { formatBytes } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { Menulist, TranslateButton } from './controls'
import { wrapTab } from './focus'

/** The popover's fixed width (§9.20: 400 for a row with a menulist and text that wraps). */
const PANEL_WIDTH = 400

/**
 * Selection translation: the text the user selected, translated into a language they read, as
 * a popover anchored where they asked on the desktop and a sheet on phones. Mounted once above
 * whichever shell is up (Root); the core opens it with the `translate.selection` event from
 * the context menu.
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
// Content shared by the panel and the sheet
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
 * phone): which language the text is in, and the menulist for the one it goes into.
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
    <div className="zen-translate-row">
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
    </div>
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

// ---------------------------------------------------------------------------
// Desktop and tablet: a popover where the user asked
// ---------------------------------------------------------------------------

/**
 * The popover (§9.20, §9.23): 400 wide, a title block – glyph and "Translation" – over a body
 * that scrolls under it once the popover reaches 60% of the window, and a footer that hugs its
 * one button. Focus moves onto its menulist when it opens, Tab wraps inside it, Escape closes it
 * and the page gets focus back (§9.22); an outside click closes it too. No X.
 */
function Popover({
  request,
  state
}: {
  request: TranslateSelectionRequest
  state: UIState
}): JSX.Element {
  const translation = useSelectionTranslation(request)
  const { copied, copy } = useCopy(translation.result?.translation ?? null)
  const ref = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [scrolled, setScrolled] = useState(false)

  useBackSurface({ name: 'translate-selection', onCommit: () => closeTranslateSelection() })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // A menulist's list is up over the popover: Escape is the list's (it closes the list).
      if (uiStore.get().menulistOpen) return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeTranslateSelection()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // On open, focus moves into the popover: its first field (the menulist), else the popover.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const field = el.querySelector<HTMLElement>('.zen-v2-menulist:not(:disabled)')
    ;(field ?? el).focus({ preventScroll: true })
  }, [])

  // At the point the user asked at, inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = (): void => {
      const area = contentAreaStore.get().area ?? {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight
      }
      // Where the user asked, in window pixels; a request without a point sits high in the page.
      const ax = area.x + (request.x ?? area.width / 2)
      const ay = area.y + (request.y ?? area.height / 3)
      setPos(
        placeAtPoint(
          ax,
          ay,
          { width: window.innerWidth, height: window.innerHeight },
          { width: PANEL_WIDTH, height: el.offsetHeight }
        )
      )
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [request])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (ref.current) wrapTab(ref.current, e)
  }

  return (
    <div className="fixed inset-0 z-[80]" onMouseDown={() => closeTranslateSelection()}>
      <div
        ref={ref}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="zen-translate-panel zen-animate-pop absolute"
        style={{
          left: pos?.left ?? POPOVER_MARGIN,
          top: pos?.top ?? POPOVER_MARGIN,
          visibility: pos ? 'visible' : 'hidden'
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="zen-translate-title-block" data-scrolled={scrolled || undefined}>
          <Languages aria-hidden />
          <h2 id={titleId} className="zen-translate-title">
            Translation
          </h2>
        </div>
        <div
          ref={body}
          className="zen-translate-panel-body"
          onScroll={() => setScrolled((body.current?.scrollTop ?? 0) > 0)}
        >
          <LanguagesRow state={state} translation={translation} />
          <p className="zen-translate-original">{request.text}</p>
          <div className="zen-translate-rule" />
          <ResultText request={request} state={state} translation={translation} />
        </div>
        <div className="zen-translate-footer">
          <TranslateButton disabled={!translation.result} onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </TranslateButton>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phone: a sheet
// ---------------------------------------------------------------------------

function PhoneSheet({
  request,
  state
}: {
  request: TranslateSelectionRequest
  state: UIState
}): JSX.Element {
  const translation = useSelectionTranslation(request)
  const { copied, copy } = useCopy(translation.result?.translation ?? null)
  const sheet = useRef<BottomSheetHandle>(null)

  useBackSurface({
    name: 'translate-selection',
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

  return (
    <BottomSheet
      ref={sheet}
      className="zen-translate-sheet"
      onDismissed={() => closeTranslateSelection()}
      contentKey={`${request.tabId}:${translation.loading ? 'loading' : 'done'}`}
      header={
        <div className="zen-translate-sheet-header">
          <span className="truncate">Translation</span>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-3 pb-3">
        <LanguagesRow state={state} translation={translation} glyph />
        <p className="zen-translate-original">{request.text}</p>
        <div className="zen-translate-rule" />
        <ResultText request={request} state={state} translation={translation} />
        <div className="zen-translate-footer">
          <TranslateButton disabled={!translation.result} onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </TranslateButton>
        </div>
      </div>
    </BottomSheet>
  )
}
