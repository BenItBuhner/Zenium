import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Languages } from 'lucide-react'
import type { TranslateSelectionResult } from '@shared/translate'
import type { UIState } from '@shared/types'
import { languageName } from '@shared/languageNames'
import { useCopy } from '@renderer/hooks/useCopy'
import { cmd } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { commandErrorMessage, pointAnchor } from '@renderer/lib/selection'
import { activeTab } from '@renderer/lib/selectors'
import { closeTranslateSelection, languageOptions, translateStateOf } from '@renderer/lib/translate'
import { browserStore, uiStore, type TranslateSelectionRequest } from '@renderer/lib/ui'
import { formatBytes } from '@renderer/lib/utils'
import { V2Button } from '../extensions/v2'
import { SelectionPopover, SelectionSheet } from '../selection/SelectionSurface'
import { ControlRow } from './ControlRow'
import { Menulist } from './Menulist'

/**
 * Selection translation: the text the user selected, translated into a language they read, as
 * a popover where they asked on the desktop and a sheet on phones (the selection surfaces'
 * chassis, `SelectionSurface.tsx`). Mounted once above whichever shell is up (Root); the core
 * opens it with the `translate.selection` event from the context menu. Either surface holds the
 * page's capture behind it while it is up (`useFloatingChrome`): the popover overhangs the
 * content frame, the sheet stands over it.
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

// ---------------------------------------------------------------------------
// Content shared by the popover and the sheet
// ---------------------------------------------------------------------------

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
 * The chassis popover (`SelectionPopover`) with the title block – glyph and "Translation" –
 * over the body and Copy in the footer; focus moves onto its menulist when it opens. Placed
 * once at the point the user asked (`pointAnchor`).
 */
function Popover({
  request,
  state
}: {
  request: TranslateSelectionRequest
  state: UIState
}): JSX.Element | null {
  const translation = useSelectionTranslation(request)
  const anchor = useMemo(() => pointAnchor(request), [request])
  return (
    <SelectionPopover
      name="translate-selection"
      anchor={anchor}
      title="Translation"
      glyph={<Languages aria-hidden />}
      onClose={closeTranslateSelection}
      footer={<CopyButton translation={translation} />}
    >
      <Body request={request} state={state} translation={translation} />
    </SelectionPopover>
  )
}

// ---------------------------------------------------------------------------
// Phone: a sheet
// ---------------------------------------------------------------------------

/**
 * The chassis sheet (`SelectionSheet`) headed "Translation", the body with its leading glyph
 * where the header has none, Copy filling the footer. The target menulist opens its own sheet
 * over this one (§9.24).
 */
function PhoneSheet({
  request,
  state
}: {
  request: TranslateSelectionRequest
  state: UIState
}): JSX.Element | null {
  const translation = useSelectionTranslation(request)
  return (
    <SelectionSheet
      name="translate-selection"
      title="Translation"
      onClose={closeTranslateSelection}
      contentKey={`${request.tabId}:${translation.loading ? 'loading' : 'done'}`}
      footer={<CopyButton translation={translation} />}
    >
      <Body request={request} state={state} translation={translation} glyph />
    </SelectionSheet>
  )
}
