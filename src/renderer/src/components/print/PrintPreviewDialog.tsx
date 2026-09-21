import type { ChangeEvent, JSX, KeyboardEvent, ReactNode } from 'react'
import { useCallback, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, CircleAlert } from 'lucide-react'
import type { KeyBinding, UIState } from '@shared/types'
import {
  PRINT_LABELS,
  PRINT_MESSAGES,
  primaryLabel,
  type PrintCustomMargins,
  type PrintDuplexEdge,
  type PrintLayout,
  type PrintMarginsMode,
  type PrintPagesMode,
  type PrintScaleMode
} from '@shared/print'
import { formatBinding } from '@shared/shortcuts'
import type { DataAttributes } from '@renderer/lib/surfaces'
import { closePrintPreview, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { V2_GLYPH, V2Button } from '../v2/controls'
import {
  BusyButton,
  Checkbox,
  ChoiceRow,
  DesktopDialog,
  Field,
  Footer,
  ListRow,
  RowValue,
  TitleBlock,
  type DialogApi
} from '../siteControls/primitives'
import { PreviewPane } from './PreviewPane'
import {
  COLOR_OPTIONS,
  DUPLEX_OPTIONS,
  LAYOUT_OPTIONS,
  MARGINS_OPTIONS,
  MARGIN_SIDES,
  MARGIN_SIDE_LABELS,
  PAGES_OPTIONS,
  PAPER_OPTIONS,
  SCALE_OPTIONS,
  destinationFromValue,
  destinationOptions,
  destinationValue,
  showsPrinterOnly
} from './printForm'
import { usePrintPreview, type PrintPreviewForm } from './usePrintPreview'

/**
 * The print preview on a mouse (Chrome's `chrome://print` in the design language v2 draft: §9.5,
 * §9.11–§9.14, §9.20, §9.23, §9.30): the one `frame` dialog through the frame dialog host –
 * Chrome's constrained window, the content frame less a 32 px margin – with the rendered pages
 * on the start side (`PreviewPane`: the paper as it prints, paging under it) and Chrome's option
 * column at the 400 form width on the end side. The column is a title block ("Print", the total
 * under it), then Chrome's rows in Chrome's order and wording (`shared/print.ts`): Destination
 * as a menulist with the system's printers and Save as PDF, Pages (a range field appears for
 * Custom, with Chrome's validation text), Copies and Colour for a printer only, Layout, then a
 * "More settings" disclosure row that opens Paper size, Margins (four fields for Custom, in the
 * locale's unit), Scale (a field for Custom), Print on both sides where the printer prints them,
 * and the Options checkboxes; Chrome's "Print using system dialog…" row closes this and opens the
 * engine's own. The footer is the panel form – a hairline over Cancel and the primary, which says
 * Save for the PDF destination and Print for a printer (§9.11). The primary is disabled while a
 * render is behind the settings or a field is in error, as Chrome greys its Print; pressing it
 * makes the form busy (§9.30): every field read-only at full opacity, the menulists opening
 * nothing, Cancel at .4, the primary alone busy; a refused job says why over the footer and
 * the form comes back. Escape and the scrim are Cancel. Mounted by `TabDialogs` while
 * `ui.printPreview` names a tab.
 */
export function PrintPreviewDialog({ state }: { state: UIState }): JSX.Element | null {
  const open = uiStore.use((s) => s.printPreview)
  if (!open) return null
  return <PrintDialog key={open.tabId} tabId={open.tabId} state={state} />
}

function PrintDialog({ tabId, state }: { tabId: string; state: UIState }): JSX.Element {
  const titleId = useId()
  const api = useRef<DialogApi | null>(null)
  const form = usePrintPreview(tabId)
  const [scrolled, setScrolled] = useState(false)
  // Cancel closes through the dialog, which hands focus back to the page (§9.22); Escape does
  // the same inside it, and the scrim press comes straight to the store.
  const cancel = useCallback((): void => {
    if (api.current) api.current.close()
    else closePrintPreview()
  }, [])
  const systemDialogKey = state.shortcuts.find((s) => s.id === 'printSystemKb')?.binding ?? null
  const description =
    form.summary ?? (form.phase === 'failed' ? PRINT_MESSAGES.previewFailed : PRINT_LABELS.loading)

  return (
    <DesktopDialog
      labelledBy={titleId}
      onCancel={closePrintPreview}
      api={api}
      width="frame"
      // Focus opens on Destination, the first field, as in Chrome (§9.22); until the session
      // brings the rows, on the dialog itself rather than on Cancel (the Destination menulist
      // then takes the keyboard as it mounts, `autoFocus` below).
      initialFocus={firstControl}
      className="flex-row-reverse"
      data-testid="print-preview"
      data-busy={form.running ? '' : undefined}
      data-phase={form.phase}
    >
      {/* The column comes first in the tree so Tab walks it before the pane, as in Chrome; the
          row is reversed so the pages sit on the start side, as Chrome draws them. */}
      <div className="flex w-[400px] shrink-0 flex-col" data-testid="print-options">
        <TitleBlock
          id={titleId}
          title={PRINT_LABELS.title}
          description={
            <span className="[font-variant-numeric:tabular-nums]" data-testid="print-summary">
              {description}
            </span>
          }
          scrolled={scrolled}
        />
        {/* The rows keep their height whatever the column holds (§9.21): a column taller than
            the dialog scrolls here, under the sticky title block and over the pinned footer,
            rather than pressing its rows together. The scrollbar's gutter is reserved whether
            or not the column overflows (as the pane's is), so the controls' right edge holds
            at one x as rows appear – picking Custom in Pages does not step every menulist. */}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 [&>*]:shrink-0"
          style={{ scrollbarGutter: 'stable' }}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          {form.session && <Options form={form} systemDialogKey={systemDialogKey} state={state} />}
        </div>
        <Footer count={2}>
          <V2Button onClick={cancel} disabled={form.running} data-testid="print-cancel">
            {PRINT_LABELS.cancel}
          </V2Button>
          <BusyButton
            variant="primary"
            busy={form.running}
            disabled={!form.canSubmit}
            onClick={form.submit}
            data-testid="print-submit"
          >
            {primaryLabel(form.settings.destination)}
          </BusyButton>
        </Footer>
      </div>
      <PreviewPane
        className="min-w-0 flex-1"
        document={form.document}
        pages={form.shownPages}
        phase={form.phase}
        rendering={form.rendering}
        error={form.phase === 'failed' ? form.error : null}
      />
    </DesktopDialog>
  )
}

/**
 * The dialog's first field once the rows are up – the Destination menulist, the column's first
 * control in the tree – or nothing while the session loads (the dialog takes the focus then).
 */
function firstControl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.zen-v2-menulist')
}

/**
 * One width for every control the column's rows trail (§9.13, as Chrome's column): 160, the
 * 400 form's two fifths, on the menulists and the numeric fields alike, so their edges line up.
 * A modifier beside the primitives' rules (`main.css`, §9.34): the unlayered `.zen-v2-menulist`
 * and `.zen-v2-field` set their own width, which a width utility would lose to.
 */
const CONTROL_WIDTH = 'zen-print-control'

/** The column's rows: Chrome's settings, in its order, with the disclosure over the rest. */
function Options({
  form,
  systemDialogKey,
  state
}: {
  form: PrintPreviewForm
  systemDialogKey: KeyBinding | null
  state: UIState
}): JSX.Element {
  const { settings, texts, errors, running: busy } = form
  const printers = form.session?.printers ?? []
  const printerOnly = showsPrinterOnly(settings)
  const moreId = useId()
  // Enter in a field is Print, as in Chrome, when the form would take the press.
  const submitOnEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && form.canSubmit) form.submit()
  }
  // A busy form's checkbox keeps its state and takes no press (§9.30).
  const check = (set: (checked: boolean) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    if (busy) return
    set(e.currentTarget.checked)
  }

  return (
    <>
      <ChoiceRow<string>
        label={PRINT_LABELS.destination}
        value={destinationValue(settings.destination)}
        options={destinationOptions(printers)}
        onChange={(value) => form.setDestination(destinationFromValue(value))}
        readOnly={busy}
        autoFocus
        controlClassName={CONTROL_WIDTH}
      />
      <ChoiceRow<PrintPagesMode>
        label={PRINT_LABELS.pages}
        value={settings.pages.mode}
        options={PAGES_OPTIONS}
        onChange={form.setPagesMode}
        readOnly={busy}
        controlClassName={CONTROL_WIDTH}
      />
      {settings.pages.mode === 'custom' && (
        <FieldBlock
          label={PRINT_LABELS.pagesCustom}
          hideLabel
          error={errors.pages}
          testId="print-pages-field"
        >
          {(id, describedBy) => (
            <Field
              id={id}
              value={texts.pages}
              placeholder={PRINT_LABELS.pagesPlaceholder}
              autoFocus
              readOnly={busy}
              spellCheck={false}
              aria-label={PRINT_LABELS.pages}
              aria-invalid={errors.pages ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => form.setPagesText(e.currentTarget.value)}
              onKeyDown={submitOnEnter}
            />
          )}
        </FieldBlock>
      )}
      {printerOnly && (
        <>
          <ListRow
            label={PRINT_LABELS.copies}
            control
            trailing={
              <Field
                className={CONTROL_WIDTH}
                value={texts.copies}
                inputMode="numeric"
                readOnly={busy}
                aria-label={PRINT_LABELS.copies}
                aria-invalid={errors.copies ? true : undefined}
                aria-describedby={errors.copies ? 'print-copies-error' : undefined}
                onChange={(e) => form.setCopiesText(e.currentTarget.value)}
                onKeyDown={submitOnEnter}
                data-testid="print-copies"
              />
            }
          />
          {errors.copies && <ErrorLine id="print-copies-error">{errors.copies}</ErrorLine>}
          {settings.copies > 1 && (
            <CheckRow
              label={PRINT_LABELS.collate}
              checked={settings.collate}
              busy={busy}
              onChange={check((collate) => form.update({ collate }))}
              data-testid="print-collate"
            />
          )}
        </>
      )}
      <ChoiceRow<PrintLayout>
        label={PRINT_LABELS.layout}
        value={settings.layout}
        options={LAYOUT_OPTIONS}
        onChange={(layout) => form.update({ layout })}
        readOnly={busy}
        controlClassName={CONTROL_WIDTH}
      />
      {printerOnly && (
        <ChoiceRow
          label={PRINT_LABELS.color}
          value={settings.color}
          options={COLOR_OPTIONS}
          onChange={(color) => form.update({ color })}
          readOnly={busy}
          controlClassName={CONTROL_WIDTH}
        />
      )}
      <ListRow
        label={PRINT_LABELS.moreSettings}
        onClick={() => form.setMore(!form.more)}
        trailing={
          form.more ? (
            <ChevronUp className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')} aria-hidden />
          ) : (
            <ChevronDown
              className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')}
              aria-hidden
            />
          )
        }
        aria-expanded={form.more}
        aria-controls={moreId}
        data-testid="print-more"
      />
      {form.more && (
        <div id={moreId} className="flex flex-col" data-testid="print-more-settings">
          <ChoiceRow<string>
            label={PRINT_LABELS.paperSize}
            value={settings.paperSize}
            options={PAPER_OPTIONS}
            onChange={(paperSize) => form.update({ paperSize })}
            readOnly={busy}
            controlClassName={CONTROL_WIDTH}
          />
          <ChoiceRow<PrintMarginsMode>
            label={PRINT_LABELS.margins}
            value={settings.margins.mode}
            options={MARGINS_OPTIONS}
            onChange={(mode) => form.update({ margins: { ...settings.margins, mode } })}
            readOnly={busy}
            controlClassName={CONTROL_WIDTH}
          />
          {settings.margins.mode === 'custom' && (
            <MarginFields form={form} onEnter={submitOnEnter} />
          )}
          <ChoiceRow<PrintScaleMode>
            label={PRINT_LABELS.scale}
            value={settings.scale.mode}
            options={SCALE_OPTIONS}
            onChange={(mode) => form.update({ scale: { ...settings.scale, mode } })}
            readOnly={busy}
            controlClassName={CONTROL_WIDTH}
          />
          {settings.scale.mode === 'custom' && (
            <FieldBlock
              label={PRINT_LABELS.scale}
              hideLabel
              error={errors.scale}
              testId="print-scale-field"
            >
              {(id, describedBy) => (
                <div className="flex items-center gap-2">
                  <Field
                    id={id}
                    className={CONTROL_WIDTH}
                    value={texts.scale}
                    inputMode="numeric"
                    readOnly={busy}
                    aria-label={`${PRINT_LABELS.scale} (%)`}
                    aria-invalid={errors.scale ? true : undefined}
                    aria-describedby={describedBy}
                    onChange={(e) => form.setScaleText(e.currentTarget.value)}
                    onKeyDown={submitOnEnter}
                    data-testid="print-scale"
                  />
                  <span className="text-[15px] leading-5 text-[var(--v2-text-deemphasized)]">
                    %
                  </span>
                </div>
              )}
            </FieldBlock>
          )}
          {form.twoSided && (
            <>
              <CheckRow
                label={PRINT_LABELS.twoSided}
                checked={settings.twoSided}
                busy={busy}
                onChange={check((twoSided) => form.update({ twoSided }))}
                data-testid="print-two-sided"
              />
              {settings.twoSided && (
                <ChoiceRow<PrintDuplexEdge>
                  label="Two-sided"
                  value={settings.duplexEdge}
                  options={DUPLEX_OPTIONS}
                  onChange={(duplexEdge) => form.update({ duplexEdge })}
                  readOnly={busy}
                  controlClassName={CONTROL_WIDTH}
                />
              )}
            </>
          )}
          <SubHeading>{PRINT_LABELS.options}</SubHeading>
          <CheckRow
            label={PRINT_LABELS.headerFooter}
            checked={settings.headerFooter}
            busy={busy}
            onChange={check((headerFooter) => form.update({ headerFooter }))}
            data-testid="print-header-footer"
          />
          <CheckRow
            label={PRINT_LABELS.background}
            checked={settings.background}
            busy={busy}
            onChange={check((background) => form.update({ background }))}
            data-testid="print-background"
          />
        </div>
      )}
      <ListRow
        label="Print using system dialog…"
        trailing={
          systemDialogKey ? (
            <RowValue>{formatBinding(systemDialogKey, state.platform)}</RowValue>
          ) : undefined
        }
        onClick={form.systemDialog}
        disabled={busy}
        data-testid="print-system-dialog"
      />
      {form.phase !== 'failed' && form.error && (
        <ErrorLine id="print-run-error">{form.error}</ErrorLine>
      )}
    </>
  )
}

/** Chrome's four custom margins as fields, top / right / bottom / left, in the locale's unit. */
function MarginFields({
  form,
  onEnter
}: {
  form: PrintPreviewForm
  onEnter: (e: KeyboardEvent) => void
}): JSX.Element {
  const base = useId()
  return (
    <div className="flex flex-col px-4 pt-1 pb-2" data-testid="print-margin-fields">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {MARGIN_SIDES.map((side: keyof PrintCustomMargins) => {
          const id = `${base}-${side}`
          return (
            <div key={side} className="flex min-w-0 flex-col">
              <label htmlFor={id} className="text-[15px] leading-5">
                {MARGIN_SIDE_LABELS[side]} ({form.unit})
              </label>
              <Field
                id={id}
                className="mt-1"
                value={form.texts.margins[side]}
                inputMode="decimal"
                readOnly={form.running}
                aria-invalid={
                  form.errors.margins && !form.texts.margins[side].trim() ? true : undefined
                }
                aria-describedby={form.errors.margins ? `${base}-error` : undefined}
                onChange={(e) => form.setMarginText(side, e.currentTarget.value)}
                onKeyDown={onEnter}
                data-margin={side}
              />
            </div>
          )
        })}
      </div>
      {form.errors.margins && (
        <ErrorLine id={`${base}-error`} inset={false}>
          {form.errors.margins}
        </ErrorLine>
      )}
    </div>
  )
}

/** A field under a row (Chrome's range and scale fields): 16 gutter, its validation text under it. */
function FieldBlock({
  label,
  hideLabel = false,
  error,
  testId,
  children
}: {
  label: string
  hideLabel?: boolean
  error: string | null
  testId?: string
  children: (id: string, describedBy: string | undefined) => ReactNode
}): JSX.Element {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col px-4 pt-1 pb-2" data-testid={testId}>
      {!hideLabel && (
        <label htmlFor={id} className="mb-1 text-[15px] leading-5">
          {label}
        </label>
      )}
      {children(id, error ? errorId : undefined)}
      {error && (
        <ErrorLine id={errorId} inset={false}>
          {error}
        </ErrorLine>
      )}
    </div>
  )
}

/** §9.12 validation text: 13 in the danger ink after the alert glyph, 4 under its field. */
function ErrorLine({
  id,
  inset = true,
  children
}: {
  id: string
  inset?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <p
      id={id}
      role="alert"
      className={cn(
        'flex items-start gap-2 pt-1 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-danger)]',
        inset && 'px-4 pb-1'
      )}
    >
      <CircleAlert className={cn(V2_GLYPH, 'mt-0.5')} aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** A one-line checkbox row at the row height (§9.2, §9.21): the box, its label, the 16 gutter. */
function CheckRow({
  label,
  checked,
  busy,
  onChange,
  ...data
}: {
  label: string
  checked: boolean
  busy: boolean
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
} & DataAttributes): JSX.Element {
  return (
    <Checkbox
      className="min-h-[var(--v2-row)] px-4 py-[var(--v2-row-pad)]"
      checked={checked}
      aria-readonly={busy || undefined}
      onChange={onChange}
      label={label}
      {...data}
    />
  )
}

/** A sub-heading over rows (§9.27): 15/600, the row's 16 gutter, 8 to the first row's box. */
function SubHeading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <h3 className="px-4 pt-3 pb-2 text-[15px] leading-5 font-semibold text-[var(--v2-text)]">
      {children}
    </h3>
  )
}
