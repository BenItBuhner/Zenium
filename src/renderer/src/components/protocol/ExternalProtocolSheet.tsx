import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  AppWindow,
  ExternalLink,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Store,
  type LucideIcon
} from 'lucide-react'
import type { ExternalProtocolRequest } from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { answerExternalProtocol, uiStore } from '@renderer/lib/ui'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * A page wants to leave the web – `mailto:`, `tel:`, an `intent://`, a site's own app – and the
 * core asks before it lets go: a sheet on the menu's chassis with the app that would open, the
 * address, and for the schemes that have one answer ("always allow phone numbers") a toggle to
 * remember it. Dismissing the sheet is "not now". Mounted once, above whichever shell is up.
 */
export function ExternalProtocolLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.externalProtocol)
  const viewport = useViewport()
  if (!request) return null
  // A new request is a new sheet: its own toggle state, its own presentation.
  return viewport.coarse ? (
    <ProtocolSheet key={request.requestId} request={request} />
  ) : (
    <ProtocolPanel key={request.requestId} request={request} />
  )
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

interface SchemeWords {
  /** What the link is, with its article: "an email address". */
  object: string
  /** The same in the plural, for the remembered choice: "email addresses". */
  plural: string
  icon: LucideIcon
}

const SCHEME_WORDS: Record<string, SchemeWords> = {
  mailto: { object: 'an email address', plural: 'email addresses', icon: Mail },
  tel: { object: 'a phone number', plural: 'phone numbers', icon: Phone },
  sms: { object: 'a text message', plural: 'text messages', icon: MessageSquare },
  smsto: { object: 'a text message', plural: 'text messages', icon: MessageSquare },
  mms: { object: 'a text message', plural: 'text messages', icon: MessageSquare },
  mmsto: { object: 'a text message', plural: 'text messages', icon: MessageSquare },
  market: { object: 'a Play Store listing', plural: 'Play Store listings', icon: Store },
  geo: { object: 'a map location', plural: 'map locations', icon: MapPin },
  intent: { object: 'an app', plural: 'app links', icon: AppWindow },
  'android-app': { object: 'an app', plural: 'app links', icon: AppWindow }
}

function wordsFor(scheme: string): SchemeWords {
  return (
    SCHEME_WORDS[scheme] ?? {
      object: `a ${scheme}: link`,
      plural: `${scheme}: links`,
      icon: ExternalLink
    }
  )
}

function titleOf(request: ExternalProtocolRequest): string {
  return request.appName ? `Open in ${request.appName}?` : 'Open in another app?'
}

function subtitleOf(request: ExternalProtocolRequest): string {
  const site = request.site || 'This page'
  // A web address here is a site's own app offering to open it: the page loads regardless.
  if (request.scheme === 'http' || request.scheme === 'https')
    return `This link can also open in ${request.appName ?? 'an app'}`
  return `${site} wants to open ${wordsFor(request.scheme).object}`
}

/** The address as the page gave it, readable: percent-escapes undone where that is safe. */
function displayAddress(url: string): string {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Shared content
// ---------------------------------------------------------------------------

function Header({
  request,
  phone
}: {
  request: ExternalProtocolRequest
  phone: boolean
}): JSX.Element {
  const Icon = wordsFor(request.scheme).icon
  if (phone) {
    // A prompt: a title block (design language v2 §9.23), not a bar header.
    return (
      <div className="zen-sheet-title-block">
        <h2>
          <Icon className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 truncate">{titleOf(request)}</span>
        </h2>
        <p className="truncate">{subtitleOf(request)}</p>
      </div>
    )
  }
  return (
    <div className="flex h-14 items-center gap-3 px-3">
      <span
        className="zen-sheet-badge flex h-10 w-10 shrink-0 items-center justify-center"
        aria-hidden
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[17px] font-semibold leading-tight tracking-[-0.012em]">
          {titleOf(request)}
        </div>
        <div className="truncate text-[13px] leading-snug text-[var(--zen-muted)]">
          {subtitleOf(request)}
        </div>
      </div>
    </div>
  )
}

function Body({
  request,
  always,
  onAlways,
  onAnswer,
  phone
}: {
  request: ExternalProtocolRequest
  always: boolean
  onAlways: (always: boolean) => void
  onAnswer: (allow: boolean) => void
  phone: boolean
}): JSX.Element {
  const words = wordsFor(request.scheme)
  return (
    <div className={phone ? 'flex flex-col pb-1' : 'flex flex-col gap-4 pb-1 pt-1'}>
      <div
        className={
          phone
            ? 'truncate px-4 pb-2 text-[13px] leading-5 text-[var(--v2-text-deemphasized)]'
            : 'truncate px-3 text-[13px] leading-snug text-[var(--zen-muted)]'
        }
        title={request.url}
      >
        {displayAddress(request.url)}
      </div>
      {request.canRemember && (
        <label className="zen-sheet-item zen-sheet-item-two-line cursor-pointer">
          <span className="min-w-0 flex-1">
            <span className="block truncate">Always open {words.plural}</span>
            <span className="zen-sheet-item-secondary block truncate text-[13px] leading-5">
              {request.appName ? `In ${request.appName}, without asking` : 'Without asking again'}
            </span>
          </span>
          <Switch checked={always} onCheckedChange={onAlways} aria-label="Always allow" />
        </label>
      )}
      {phone ? (
        // §9.11: two peers split the width, the primary trailing.
        <div className="zen-sheet-footer">
          <button type="button" className="zen-v2-button" onClick={() => onAnswer(false)}>
            Not now
          </button>
          <button
            type="button"
            className="zen-v2-button"
            data-primary
            onClick={() => onAnswer(true)}
          >
            Open
          </button>
        </div>
      ) : (
        <div className="flex justify-end gap-2 px-3">
          <Button variant="secondary" onClick={() => onAnswer(false)}>
            Not now
          </Button>
          <Button variant="default" onClick={() => onAnswer(true)}>
            Open
          </Button>
        </div>
      )}
    </div>
  )
}

/** Escape answers "not now" (hardware keyboards exist on tablets and DeX too). */
function useEscape(close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

// ---------------------------------------------------------------------------
// Phone: bottom sheet on the menu's chassis
// ---------------------------------------------------------------------------

function ProtocolSheet({ request }: { request: ExternalProtocolRequest }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [always, setAlways] = useState(false)
  const answer = (allow: boolean): void =>
    answerExternalProtocol(request.requestId, allow, allow && always)

  // The system back gesture pulls the sheet down like a drag; commit or the back button slides it
  // away, which is "not now" (`onDismissed`).
  useBackSurface({
    name: 'external-protocol',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => answer(false)}
      contentKey={`${request.requestId}:${request.canRemember}`}
      handleLabel="Dismiss"
    >
      <Header request={request} phone />
      <Body
        request={request}
        always={always}
        onAlways={setAlways}
        // The sheet leaves first, so the host never captures it when the other app comes up.
        onAnswer={(allow) => sheet.current?.dismiss(() => answer(allow))}
        phone
      />
    </BottomSheet>
  )
}

// ---------------------------------------------------------------------------
// Mouse (DeX, tablets with a trackpad): a centred panel
// ---------------------------------------------------------------------------

function ProtocolPanel({ request }: { request: ExternalProtocolRequest }): JSX.Element {
  const [always, setAlways] = useState(false)
  const answer = (allow: boolean): void =>
    answerExternalProtocol(request.requestId, allow, allow && always)
  useBackSurface({ name: 'external-protocol', onCommit: () => answer(false) })
  useEscape(() => answer(false))
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
      <div className="zen-sheet-scrim absolute inset-0" onClick={() => answer(false)} />
      <div
        role="dialog"
        aria-label={titleOf(request)}
        className="zen-panel zen-animate-pop relative w-full max-w-[400px] px-3 pb-3 pt-2"
      >
        <Header request={request} phone={false} />
        <Body
          request={request}
          always={always}
          onAlways={setAlways}
          onAnswer={answer}
          phone={false}
        />
      </div>
    </div>
  )
}
