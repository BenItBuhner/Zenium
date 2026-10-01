import type { JSX } from 'react'
import { useId, useRef, useState } from 'react'
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
import { useEscapeUnlessLeaving } from '@renderer/hooks/useEscape'
import { usePopover } from '@renderer/hooks/usePopover'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { SheetPresence, useSheetLeave } from '@renderer/lib/motion/presence'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { answerExternalProtocol, uiStore } from '@renderer/lib/ui'
import { V2Button, V2CheckRow, V2TitleBlock } from '../extensions/v2'
import { Switch } from '../ui/switch'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * A page wants to leave the web – `mailto:`, `tel:`, an `intent://`, a site's own app – and the
 * core asks before it lets go: on the phone a sheet on the menu's chassis with the app that
 * would open, the address, and for the schemes that have one answer ("always allow phone
 * numbers") a toggle to remember it; on a tablet and under a mouse (DeX, a trackpad) the same
 * question as the prompt dialog in the frame's dialog host – §9.20's `zen-v2-dialog` at 400 over
 * §9.5's scrim on the content frame alone (v2 draft §9.36 as the lead amended it on #750: a
 * prompt on the tablet is a dialog, not a sheet, in the coarse pointer's sizes; the split is the
 * form factor's, not the pointer's alone – a tablet's finger gets the dialog, the phone's the
 * sheet). Dismissing either is "not now". Mounted once, above whichever shell is up.
 *
 * The sheet's leave outlives its request (`SheetPresence`, v2 draft §11.1): the core withdraws
 * a question with `externalProtocol.cancel` – the tab closed, its view gone, a newer request
 * from the same page taking the sheet over – and the store's `null` is a leave, the sheet
 * running its own way down before it unmounts; a new request meanwhile is a new sheet above it.
 * The dialog reads no leave and goes with its request, as before: the host keeps its panel
 * through the pop exit (lib/portals.tsx).
 */
export function ExternalProtocolLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.externalProtocol)
  const viewport = useViewport()
  const sheet = viewport.coarse && viewport.formFactor !== 'tablet'
  // A new request is a new sheet: its own toggle state, its own presentation.
  return (
    <SheetPresence>
      {!request ? null : sheet ? (
        <ProtocolSheet key={request.requestId} request={request} />
      ) : (
        <ProtocolDialog key={request.requestId} request={request} />
      )}
    </SheetPresence>
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

/**
 * The description's classes on both chassis: it wraps to two lines and then ends in an ellipsis
 * (design language v2 §9.2, the row growing with it; §9.23 names this sheet's one-line cut as the
 * deviation the Custom Tab's twin corrects), a host with no break in it breaking anywhere rather
 * than overflowing the second line. The title above it stays on one line; the address below it
 * is one line too (§9.23). The full sentence is the element's `title`.
 */
const DESCRIPTION_CLAMP_CLASS = 'line-clamp-2 wrap-anywhere'

// ---------------------------------------------------------------------------
// Shared content
// ---------------------------------------------------------------------------

function Header({
  request,
  phone,
  titleId,
  descriptionId
}: {
  request: ExternalProtocolRequest
  phone: boolean
  /** The title's id, the sheet's or the dialog's `aria-labelledby`. */
  titleId?: string
  /** The dialog's description id, its `aria-describedby`. */
  descriptionId?: string
}): JSX.Element {
  const Icon = wordsFor(request.scheme).icon
  const subtitle = subtitleOf(request)
  if (phone) {
    // A prompt: a title block (design language v2 §9.23), not a bar header.
    return (
      <div className="zen-sheet-title-block">
        <h2 id={titleId}>
          <Icon className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 truncate">{titleOf(request)}</span>
        </h2>
        <p className={DESCRIPTION_CLAMP_CLASS} title={subtitle}>
          {subtitle}
        </p>
      </div>
    )
  }
  // The dialog's title block (§9.23): the scheme's glyph inline at the title's start – sized by
  // the block to `--v2-icon`, 16 under a mouse and 20 on a tablet (extensions.css; no tile) –
  // the title on one line, the sentence as the description wrapping to two.
  return (
    <V2TitleBlock
      id={titleId}
      title={<span className="block truncate">{titleOf(request)}</span>}
      glyph={<Icon aria-hidden />}
      description={
        <span className={DESCRIPTION_CLAMP_CLASS} title={subtitle}>
          {subtitle}
        </span>
      }
      descriptionId={descriptionId}
    />
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
  // The dialog's body runs at the prompt primitive's rhythm (`.zen-confirm-dialog-body`): 16
  // between the address, the remember row and the footer, 16 under the footer; the title block
  // above brings its own 16 (§9.23).
  return (
    <div className={phone ? 'flex flex-col' : 'flex flex-col gap-4 pb-4'}>
      <div
        className={
          phone
            ? 'truncate px-4 pb-2 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]'
            : 'truncate px-4 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]'
        }
        title={request.url}
      >
        {displayAddress(request.url)}
      </div>
      {request.canRemember && phone && (
        <label className="zen-sheet-item zen-sheet-item-two-line cursor-pointer">
          <span className="min-w-0 flex-1">
            <span className="block truncate">Always open {words.plural}</span>
            <span className="zen-sheet-item-secondary block truncate text-[13px] leading-[var(--v2-line-small)]">
              Without asking again
            </span>
          </span>
          <Switch checked={always} onCheckedChange={onAlways} aria-label="Always allow" />
        </label>
      )}
      {request.canRemember && !phone && (
        // §9.23: a prompt's remember-choice is a checkbox row, submitted with Open – edge to
        // edge, its own 16 the prompt's gutter (§9.25), the box 16 under a mouse and 20 on a
        // tablet (`--v2-checkbox`).
        <V2CheckRow
          label={`Always open ${words.plural}`}
          description="Without asking again"
          checked={always}
          onChange={onAlways}
        />
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
        // §9.11: the pair hugs right at the pointer's control height (`--v2-control`: 32 under a
        // mouse, 40 under a finger) with an 8 gap, Open the primary in the v2 inks.
        <div className="flex justify-end gap-2 px-4">
          <V2Button onClick={() => onAnswer(false)}>Not now</V2Button>
          <V2Button variant="primary" data-accept onClick={() => onAnswer(true)}>
            Open
          </V2Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phone: bottom sheet on the menu's chassis
// ---------------------------------------------------------------------------

function ProtocolSheet({ request }: { request: ExternalProtocolRequest }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
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
  useEscapeUnlessLeaving(() => sheet.current?.dismiss(), useSheetLeave()?.leaving)

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => answer(false)}
      contentKey={`${request.requestId}:${request.canRemember}`}
      handleLabel="Dismiss"
      labelledBy={titleId}
    >
      <Header request={request} phone titleId={titleId} />
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
// Tablets and a mouse (DeX, a trackpad): the prompt dialog in the frame's host
// ---------------------------------------------------------------------------

/**
 * The prompt as §9.36 has it on a tablet and under a mouse: §9.20's `zen-v2-dialog` at the form
 * width, 400 – it carries the remember row – placed through the frame's dialog host
 * (lib/portals.tsx, `FrameDialogPortal`: the layer mounts above the shells, outside the host),
 * whose §9.5 scrim dims the content frame alone and leaves the sidebar and the toolbar lit and
 * inert; the host centres the panel, takes the pointer and keeps the panel through its pop exit.
 * The dialog meets §9.23 as the prompt moves onto it: the title block with the scheme's glyph
 * inline at the title's start (`--v2-icon`, 16 under a mouse and 20 on a tablet – the tokens are
 * the form factor's, so DeX keeps the tablet's), the sentence as the description wrapping to two
 * lines, the decoded address 13 at 69 % on one line, the remember choice as a checkbox row
 * submitted with Open, then the §9.11 footer hugging right – Not now, then Open as the primary –
 * at the pointer's control height (`--v2-control`: 32 under a mouse, 40 under a finger). Escape,
 * a press on the scrim and the system back gesture are "not now"; focus lands on Open and Tab
 * wraps (§9.22), and the answer gives the focus back to the page (`answerExternalProtocol`).
 */
function ProtocolDialog({ request }: { request: ExternalProtocolRequest }): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedProtocolDialog request={request} />
    </FrameDialogPortal>
  )
}

function HostedProtocolDialog({ request }: { request: ExternalProtocolRequest }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const titleId = `${id}title`
  const descriptionId = `${id}description`
  const [always, setAlways] = useState(false)
  const answer = (allow: boolean): void =>
    answerExternalProtocol(request.requestId, allow, allow && always)
  useFrameDialog({ onScrimPress: () => answer(false) })
  useBackSurface({ name: 'external-protocol', onCommit: () => answer(false) })
  usePopover(ref, {
    onClose: () => answer(false),
    initial: (root) => root.querySelector<HTMLElement>('[data-accept]'),
    // A page's link raised it: no control of the chrome's to return the focus to (§9.22).
    returnTo: null
  })
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-external-protocol=""
      className="zen-v2 zen-v2-dialog zen-animate-pop flex max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
    >
      <Header request={request} phone={false} titleId={titleId} descriptionId={descriptionId} />
      <Body
        request={request}
        always={always}
        onAlways={setAlways}
        onAnswer={answer}
        phone={false}
      />
    </div>
  )
}
