import type { JSX, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, Languages } from 'lucide-react'
import type { TranslateSelectionResult } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import { cmd } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { activeTab } from '@renderer/lib/selectors'
import { closeTranslateSelection, languageOptions, translateStateOf } from '@renderer/lib/translate'
import {
  browserStore,
  contentAreaStore,
  uiStore,
  type TranslateSelectionRequest
} from '@renderer/lib/ui'
import { cn, formatBytes } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { Menulist, TranslateButton } from './controls'

const PANEL_WIDTH = 360
const MARGIN = 8
/** Gap between the point the user asked at and the panel. */
const GAP = 12

/**
 * Selection translation: the text the user selected, translated into a language they read, as
 * a panel anchored where they asked on the desktop and a sheet on phones. Mounted once above
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

/** The header row: which language the text is in, and the menulist for the one it goes into. */
function LanguagesRow({
  state,
  translation,
  className
}: {
  state: UIState
  translation: Translation
  className?: string
}): JSX.Element {
  const source = translation.result?.source ?? null
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Languages className="zen-translate-glyph" aria-hidden />
      <span className="zen-translate-caption min-w-0 flex-1 truncate">
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
// Desktop and tablet: a panel where the user asked
// ---------------------------------------------------------------------------

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
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * MARGIN)

  useBackSurface({ name: 'translate-selection', onCommit: () => closeTranslateSelection() })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeTranslateSelection()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Below the point the user asked at (above it when there is no room), inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = (): void => {
      const height = el.offsetHeight
      const area = contentAreaStore.get().area ?? {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight
      }
      // Where the user asked, in window pixels; a request without a point sits high in the page.
      const ax = area.x + (request.x ?? area.width / 2)
      const ay = area.y + (request.y ?? area.height / 3)
      let top = ay + GAP
      if (top + height > window.innerHeight - MARGIN) top = ay - GAP - height
      setPos({
        left: Math.max(MARGIN, Math.min(ax - width / 2, window.innerWidth - width - MARGIN)),
        top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN))
      })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [request, width])

  return (
    <div className="fixed inset-0 z-[80]" onMouseDown={() => closeTranslateSelection()}>
      <div
        ref={ref}
        role="dialog"
        aria-label="Translation"
        className="zen-translate-panel zen-animate-pop absolute flex flex-col gap-2"
        style={{
          left: pos?.left ?? MARGIN,
          top: pos?.top ?? MARGIN,
          width,
          visibility: pos ? 'visible' : 'hidden'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <LanguagesRow state={state} translation={translation} />
        <p className="zen-translate-original">{request.text}</p>
        <div className="zen-translate-rule" />
        <ResultText request={request} state={state} translation={translation} />
        <div className="flex justify-end pt-1">
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
        <div className="flex h-11 items-center px-3">
          <span className="zen-translate-title min-w-0 flex-1 truncate">Translation</span>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
        <LanguagesRow state={state} translation={translation} className="min-h-11" />
        <p className="zen-translate-original">{request.text}</p>
        <div className="zen-translate-rule" />
        <ResultText request={request} state={state} translation={translation} />
        <div className="flex justify-end pt-1">
          <TranslateButton disabled={!translation.result} onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </TranslateButton>
        </div>
      </div>
    </BottomSheet>
  )
}
