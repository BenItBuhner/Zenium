import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { CircleAlert, ExternalLink, Lock, RotateCw, Share2 } from 'lucide-react'
import type { PdfFitMode, PdfOutlineItem } from '@shared/pdfViewerProtocol'
import {
  currentOutlineKey,
  flattenOutline,
  formatPdfZoom,
  parsePageNumber,
  PDF_FIT_LABELS,
  PDF_ZOOM_PRESETS,
  pdfCommand,
  pdfViewerStore,
  pdfZoomIs
} from '@renderer/lib/pdfViewer'
import { cn } from '@renderer/lib/utils'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from '../phone/PhoneSheet'
import { V2_GLYPH } from '../v2/controls'

/**
 * The PDF viewer bar's sheets (`PdfViewerBar.tsx`), each a `PhoneSheet` on the hosted chassis:
 * the zoom picker, the document's contents, the overflow, Go to page and the password prompt.
 * Rows are the shared `.zen-v2-row` (§9.34) – a radio row for a choice, a button row for an
 * action – at the sheet's one 16 gutter; forms are the phone panels' (`zen-phone-form`, the
 * bookmark editor's), closed by the chassis footer (§9.11). A pick or an action slides the
 * sheet away first and runs once it has gone, so the pages move in the open.
 */

export type ZoomPick = { kind: 'fit'; mode: PdfFitMode } | { kind: 'zoom'; factor: number }

/** Chrome's zoom menu: the two fits, then its round presets; the one in force is checked. */
export function PdfZoomSheet({
  zoom,
  fit,
  onPick,
  onClose
}: {
  zoom: number
  fit: PdfFitMode | null
  onPick: (pick: ZoomPick) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const pick = (choice: ZoomPick): void => sheet.current?.dismiss(() => onPick(choice))
  const fits: PdfFitMode[] = ['width', 'page']
  return (
    <PhoneSheet name="pdf-zoom" title="Zoom" focus="dialog" onClose={onClose} sheetRef={sheet}>
      <div role="radiogroup" aria-label="Zoom" className="pb-2">
        {fits.map((mode) => (
          <RadioRow
            key={mode}
            label={PDF_FIT_LABELS[mode]}
            checked={fit === mode}
            onSelect={() => pick({ kind: 'fit', mode })}
          />
        ))}
        {PDF_ZOOM_PRESETS.map((factor) => (
          <RadioRow
            key={factor}
            label={formatPdfZoom(factor)}
            checked={fit === null && pdfZoomIs(zoom, factor)}
            onSelect={() => pick({ kind: 'zoom', factor })}
          />
        ))}
      </div>
    </PhoneSheet>
  )
}

/** One §9.14 radio row: the 20 px disc, the label beside it, the whole row the target. */
function RadioRow({
  label,
  checked,
  onSelect
}: {
  label: string
  checked: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="zen-v2-row"
      onClick={onSelect}
    >
      <span className="zen-v2-radio" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate tabular-nums">{label}</span>
    </button>
  )
}

/**
 * The document's outline (Chrome's "Contents" drawer): every entry in reading order, children
 * indented under their parent, the page each leads to trailing in the deemphasised ink; the
 * entry whose page is in view is the selected row. An entry without a page (a destination the
 * viewer could not resolve) is listed but not a target.
 */
export function PdfOutlineSheet({
  outline,
  page,
  onGoTo,
  onClose
}: {
  outline: readonly PdfOutlineItem[]
  page: number
  onGoTo: (page: number) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const rows = flattenOutline(outline)
  const currentKey = currentOutlineKey(rows, page)
  return (
    <PhoneSheet
      name="pdf-outline"
      title="Contents"
      focus="dialog"
      onClose={onClose}
      sheetRef={sheet}
      contentKey={String(rows.length)}
    >
      <div className="pb-2">
        {rows.map(({ item, depth, key }) => {
          const target = item.page
          const current = key === currentKey
          return (
            <button
              key={key}
              type="button"
              className="zen-v2-row"
              style={{
                paddingLeft: 16 + depth * 20,
                background: current ? 'var(--v2-selected)' : undefined
              }}
              aria-current={current ? 'page' : undefined}
              aria-disabled={target === null || undefined}
              aria-label={target === null ? item.title : `${item.title}, page ${target}`}
              onClick={() => {
                if (target !== null) sheet.current?.dismiss(() => onGoTo(target))
              }}
            >
              <span className={cn('min-w-0 flex-1 truncate', target === null && 'opacity-40')}>
                {item.title}
              </span>
              {target !== null && (
                <span className="shrink-0 text-[13px] tabular-nums text-[var(--v2-text-deemphasized)]">
                  {target}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </PhoneSheet>
  )
}

/**
 * The overflow: Share (the system share sheet with the file), Open with (Chrome's way out of the
 * viewer: the system's chooser over the apps that take a PDF) and Rotate (a quarter turn
 * clockwise, Chrome's), named by the document. Rotate needs an open document; the other two only
 * the file, which is there whatever the viewer made of it.
 */
export function PdfMoreSheet({
  title,
  ready,
  onShare,
  onOpenWith,
  onRotate,
  onClose
}: {
  title: string
  ready: boolean
  onShare: () => void
  onOpenWith: () => void
  onRotate: () => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const act = (action: () => void): void => sheet.current?.dismiss(action)
  return (
    <PhoneSheet name="pdf-more" title={title} focus="first" onClose={onClose} sheetRef={sheet}>
      <div className="pb-2">
        <ActionRow icon={<Share2 />} label="Share" onSelect={() => act(onShare)} />
        <ActionRow icon={<ExternalLink />} label="Open with" onSelect={() => act(onOpenWith)} />
        <ActionRow
          icon={<RotateCw />}
          label="Rotate"
          disabled={!ready}
          onSelect={() => act(onRotate)}
        />
      </div>
    </PhoneSheet>
  )
}

/** An action row: the 20 glyph in the leading box, the label; disabled is .4 on its content (§9.30). */
function ActionRow({
  icon,
  label,
  disabled = false,
  onSelect
}: {
  icon: ReactNode
  label: string
  disabled?: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-row"
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onSelect()
      }}
    >
      <span
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center [&>svg]:h-5 [&>svg]:w-5 [&>svg]:stroke-[1.75]',
          disabled && 'opacity-40'
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', disabled && 'opacity-40')}>{label}</span>
    </button>
  )
}

/** "Go to page": one numeric field, Cancel and Go; Go takes only a page the document has. */
export function PdfGoToPageSheet({
  page,
  pageCount,
  onGoTo,
  onClose
}: {
  page: number
  pageCount: number
  onGoTo: (page: number) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const fieldId = 'pdf-goto-page'
  const [text, setText] = useState(String(page))
  const target = parsePageNumber(text, pageCount)
  const invalid = text.trim() !== '' && target === null
  const go = (): void => {
    if (target !== null) sheet.current?.dismiss(() => onGoTo(target))
  }
  return (
    <PhoneSheet
      name="pdf-goto"
      title="Go to page"
      focus="dialog"
      onClose={onClose}
      sheetRef={sheet}
      handleLabel="Dismiss"
    >
      <form
        className="zen-phone-form"
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <div className="zen-phone-form-field">
          <label htmlFor={fieldId} className="zen-phone-field-label">
            Page number (1 to {pageCount})
          </label>
          <span className="zen-phone-field">
            <input
              id={fieldId}
              value={text}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              enterKeyHint="go"
              aria-invalid={invalid || undefined}
              onChange={(e) => setText(e.target.value)}
            />
          </span>
        </div>
        <div className="zen-sheet-footer">
          <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
            Cancel
          </button>
          <button type="submit" className="zen-v2-button" data-primary disabled={target === null}>
            Go
          </button>
        </div>
      </form>
    </PhoneSheet>
  )
}

/**
 * The password prompt for an encrypted document (Chrome's: "This document is password
 * protected"): a title block with the description, the password field, Cancel and Unlock. Unlock
 * hands the password to the viewer and the form goes busy (§9.30: the field read-only, only the
 * primary busy) until the document reports again – open, and the sheet goes; still waiting with
 * the password wrong, and the field says so in the danger ink and takes another try.
 */
export function PdfPasswordSheet({
  tabId,
  fileName,
  onClose
}: {
  tabId: string
  fileName: string
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const fieldId = 'pdf-password'
  const errorId = useId()
  const report = pdfViewerStore.use((s) => s.reports[tabId] ?? null)
  const [password, setPassword] = useState('')
  /** The report as it stood when Unlock was pressed; busy until another comes. */
  const [submitted, setSubmitted] = useState<typeof report | null>(null)
  const busy = submitted !== null && report === submitted
  const wrong = report?.state === 'password' && report.passwordWrong === true && !busy
  const [tried, setTried] = useState(false)

  // The document opened (or failed outright): the prompt has nothing left to ask.
  useEffect(() => {
    if (report && report.state !== 'password' && report.state !== 'loading')
      sheet.current?.dismiss()
  }, [report])

  const unlock = (): void => {
    if (busy || !password) return
    setSubmitted(report)
    setTried(true)
    pdfCommand(tabId, { kind: 'password', password })
  }
  const showError = wrong && tried

  return (
    <PhoneSheet
      name="pdf-password"
      title="Password required"
      prompt={{
        icon: <Lock className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: `${fileName} is password protected. Enter the password to open it.`
      }}
      focus="dialog"
      onClose={onClose}
      sheetRef={sheet}
      handleLabel="Dismiss"
      // The error line makes the form taller: the sheet measures itself again for it.
      contentKey={showError ? 'wrong' : 'asking'}
    >
      <form
        className="zen-phone-form"
        aria-busy={busy || undefined}
        onSubmit={(e) => {
          e.preventDefault()
          unlock()
        }}
      >
        <div className="zen-phone-form-field">
          <label htmlFor={fieldId} className="zen-phone-field-label">
            Password
          </label>
          <span className="zen-phone-field">
            <input
              id={fieldId}
              type="password"
              value={password}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="done"
              readOnly={busy}
              aria-invalid={showError || undefined}
              aria-describedby={showError ? errorId : undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
          </span>
          {showError && (
            // §9.12 validation text: one clause in the danger ink after the alert glyph, as the
            // print column's error lines (Chrome's viewer writes it as one clause too).
            <p
              id={errorId}
              role="alert"
              className="flex items-start gap-2 text-[13px] leading-5 text-[var(--v2-danger)]"
            >
              <CircleAlert
                className={cn(V2_GLYPH, 'mt-[calc((var(--v2-line-body)-var(--v2-icon))/2)]')}
                aria-hidden
              />
              <span>Incorrect password, try again</span>
            </p>
          )}
        </div>
        <div className="zen-sheet-footer">
          <button
            type="button"
            className="zen-v2-button"
            disabled={busy}
            onClick={() => sheet.current?.dismiss()}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="zen-v2-button"
            data-primary
            aria-busy={busy || undefined}
            disabled={!password && !busy}
          >
            {busy ? (
              <>
                <span className="zen-v2-button-label">Unlock</span>
                <span className="zen-v2-spinner" aria-hidden />
              </>
            ) : (
              'Unlock'
            )}
          </button>
        </div>
      </form>
    </PhoneSheet>
  )
}
