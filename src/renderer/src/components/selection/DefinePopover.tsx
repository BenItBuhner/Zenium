import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { BookA } from 'lucide-react'
import type { DefineResult } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { closeDefine, defineRefusalMessage, senses } from '@renderer/lib/define'
import { useViewport } from '@renderer/lib/formFactor'
import { commandErrorMessage, pointAnchor, rectAnchor } from '@renderer/lib/selection'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, uiStore, type DefineRequest } from '@renderer/lib/ui'
import { V2Button } from '../extensions/v2'
import { SelectionPopover, SelectionSheet } from './SelectionSurface'

/**
 * The Define surface (CT-39; Edge's mini menu's Define): Wiktionary's definition of the word or
 * short phrase the user selected, as a popover over the selection on the desktop and a sheet on
 * phones (the selection surfaces' chassis, `SelectionSurface.tsx`). Mounted once above
 * whichever shell is up (Root); the core opens it with the `define.show` event from the mini
 * menu's chip or the phone's selection toolbar, and the surface looks the term up itself
 * (`define.lookup`). Either surface holds the page's capture behind it while it is up.
 */
export function DefineLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.define)
  const state = browserStore.use((s) => s.state)
  const viewport = useViewport()
  const tab = request && state ? state.tabs[request.tabId] : undefined
  const active = state ? activeTab(state)?.id : undefined
  // The tab closed, or another tab came to the front: the surface belonged to the first one.
  useEffect(() => {
    if (request && (!tab || active !== request.tabId)) closeDefine()
  }, [request, tab, active])
  if (!request || !tab || !state) return null
  return viewport.formFactor === 'phone' ? (
    <PhoneSheet request={request} />
  ) : (
    <Popover request={request} zoom={tab.zoom} />
  )
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Definition {
  result: DefineResult | null
  /** Why there is none: Wiktionary's refusal, or the command's failure. */
  error: string | null
  loading: boolean
}

/** Look the request's term up, once per request. */
function useDefinition(request: DefineRequest): Definition {
  const [outcome, setOutcome] = useState<(Definition & { key: string }) | null>(null)
  const key = `${request.tabId}|${request.term}`
  useEffect(() => {
    let cancelled = false
    cmd('define.lookup', { term: request.term }).then(
      (lookup) => {
        if (cancelled) return
        setOutcome(
          lookup.ok
            ? { key, result: lookup.result, error: null, loading: false }
            : {
                key,
                result: null,
                error: defineRefusalMessage(lookup.reason, request.term),
                loading: false
              }
        )
      },
      (error: unknown) => {
        if (!cancelled)
          setOutcome({ key, result: null, error: commandErrorMessage(error), loading: false })
      }
    )
    return () => {
      cancelled = true
    }
  }, [key, request.term])
  const settled = outcome?.key === key ? outcome : null
  return {
    result: settled?.result ?? null,
    error: settled?.error ?? null,
    loading: settled === null
  }
}

// ---------------------------------------------------------------------------
// Content shared by the popover and the sheet
// ---------------------------------------------------------------------------

/**
 * The body both surfaces share: for each part of speech its label (§9.27's sub-heading pose at
 * the small size) over the numbered senses (`senses`: the first three across the entries), then
 * a hairline and the attribution the licence asks for; while the answer is on its way, one
 * caption; a refusal in the danger ink.
 */
function Body({
  request,
  definition
}: {
  request: DefineRequest
  definition: Definition
}): JSX.Element {
  let body: ReactNode
  if (definition.loading) {
    body = <span className="zen-translate-caption">{`Looking up “${request.term}”…`}</span>
  } else if (definition.error || !definition.result) {
    body = (
      <span className="zen-translate-danger">
        {definition.error ?? defineRefusalMessage('not-found', request.term)}
      </span>
    )
  } else {
    const parts = senses(definition.result)
    body =
      parts.length === 0 ? (
        <span className="zen-translate-danger">
          {defineRefusalMessage('not-found', request.term)}
        </span>
      ) : (
        parts.map((part, i) => (
          <div key={`${part.partOfSpeech}:${i}`} className="zen-define-entry">
            <p className="zen-define-pos">{part.partOfSpeech}</p>
            <ol className="zen-define-senses">
              {part.definitions.map((d, j) => (
                <li key={j}>{d.text}</li>
              ))}
            </ol>
          </div>
        ))
      )
  }
  return (
    <>
      <div className="zen-define-result" aria-live="polite">
        {body}
      </div>
      {definition.result && (
        <>
          <div className="zen-translate-rule" />
          <p className="zen-define-attribution">
            {`From ${definition.result.attribution.source}, ${definition.result.attribution.licence}`}
          </p>
        </>
      )}
    </>
  )
}

/** The one action: the term's page on Wiktionary, in a new tab; there until the answer has a page. */
function SeeMoreButton({ definition }: { definition: Definition }): JSX.Element {
  const url = definition.result?.attribution.url ?? null
  return (
    <V2Button disabled={!url} onClick={() => url && run('tab.create', { url, active: true })}>
      See more on Wiktionary
    </V2Button>
  )
}

// ---------------------------------------------------------------------------
// Desktop and tablet: a popover over the selection
// ---------------------------------------------------------------------------

/**
 * The chassis popover (`SelectionPopover`) with the title block – the dictionary glyph and the
 * term – over the body and See more in the footer, hanging under the selection's box
 * (`rectAnchor`: above it when the room below is short) or, without a box, from the context
 * menu's click (`pointAnchor`, as the translate popover hangs). Placed once for the request.
 */
function Popover({ request, zoom }: { request: DefineRequest; zoom: number }): JSX.Element | null {
  const definition = useDefinition(request)
  const anchor = useMemo(
    () =>
      request.rect
        ? rectAnchor(request.rect, zoom)
        : pointAnchor(request.at ?? { x: null, y: null }),
    [request, zoom]
  )
  return (
    <SelectionPopover
      name="define"
      anchor={anchor}
      title={definition.result?.term ?? request.term}
      glyph={<BookA aria-hidden />}
      onClose={closeDefine}
      footer={<SeeMoreButton definition={definition} />}
    >
      <Body request={request} definition={definition} />
    </SelectionPopover>
  )
}

// ---------------------------------------------------------------------------
// Phone: a sheet
// ---------------------------------------------------------------------------

/** The chassis sheet (`SelectionSheet`) headed with the term, See more filling the footer. */
function PhoneSheet({ request }: { request: DefineRequest }): JSX.Element | null {
  const definition = useDefinition(request)
  return (
    <SelectionSheet
      name="define"
      title={definition.result?.term ?? request.term}
      onClose={closeDefine}
      contentKey={`${request.tabId}:${definition.loading ? 'loading' : 'done'}`}
      footer={<SeeMoreButton definition={definition} />}
    >
      <Body request={request} definition={definition} />
    </SelectionSheet>
  )
}
