import type { JSX, ReactNode } from 'react'
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useEscape } from '@renderer/hooks/useEscape'
import { returnFocusTo, wrapTab } from '@renderer/lib/popover'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { ConfirmDialog } from '../../dialogs/ConfirmDialog'
import { V2TitleBlock } from '../../extensions/v2'
import { Field, RadioOption, SheetActions, ValidationMessage } from './blocks'
import type {
  ActionRow,
  DetailRow,
  FieldRow,
  ItemRow,
  RowGroup,
  SettingsRow,
  ValueRow
} from './model'
import { findRow, optionGroups } from './model'
import { GroupList, type RowContext, type SheetRequest } from './rows'
import {
  SheetCoveredContext,
  SheetDismissContext,
  SheetFooterContext,
  useSheetFooterSlot,
  type SheetDismiss
} from './sheetContext'

/**
 * The dialogs a desktop Settings row opens (v2 §9.5, §9.22–9.24, §10.5): the same six requests
 * the phone's sheets answer (`sheets.tsx`) – a value row's picker where a row has no room for
 * its menulist (a search result's), a field row's one-field form, a destructive action's
 * confirmation, an action's small form, an item's rows and a detail row's second level. Five
 * are the shared `.zen-v2-dialog` at the form width (`SettingsDialog`), centred over the content
 * frame by the frame's dialog host (lib/portals.tsx), which draws the §9.5 scrim, makes the
 * chrome inert and takes the pointer; the confirmation is the program's one prompt primitive
 * (`ConfirmDialog`, components/dialogs: the §9.23 notice at §9.20's 320, whose keyboard and
 * width are its own), which the page's rows and `SiteDataPrompt` consume alike. The stack is
 * the page's (`useSheetStack`, at most two deep, §9.24): a dialog under another is `inert` and
 * leaves Escape to the one on top – the popup stack's rule (`useEscape`: the most recently
 * opened answers), which a menulist's popover or a prompt a form opens over its dialog joins
 * too; each resolves its row again on every render, so it always shows the row's current value
 * and closes by itself when its row is gone. A prompt a form renders inside a dialog (the
 * site-data viewer's Clear all) covers its host the same way: `SheetCoveredContext`.
 *
 * Keyboard (§9.22): focus moves into a dialog as it opens – the checked option of a picker, the
 * field of a form, the first row of an item's rows; a prompt's is the primitive's: its container
 * – Tab wraps inside it, from the container too, Escape and the scrim close it, and when it
 * leaves the focus returns to the control that opened it: the page's row, or the lower dialog's
 * control for one that opened over a dialog (§9.24) – one hop down the stack at a time, and a
 * return the lower dialog's `inert` still refuses waits for that `inert` to go. Titles are the
 * rows' own and sentence case (§9.1).
 */

/** Every open dialog, lowest first; each resolves its row in `groups`. */
export function DialogStack({
  requests,
  groups,
  ctx,
  closeTop
}: {
  requests: readonly SheetRequest[]
  groups: readonly RowGroup[]
  ctx: RowContext
  closeTop(): void
}): JSX.Element | null {
  if (requests.length === 0) return null
  return (
    <>
      {requests.map((request, index) => {
        const row = findRow(groups, request.rowId)
        const top = index === requests.length - 1
        return (
          <RowDialog
            key={`${request.kind}:${request.rowId}`}
            request={request}
            row={row}
            under={!top}
            ctx={ctx}
            close={closeTop}
          />
        )
      })}
    </>
  )
}

function RowDialog({
  request,
  row,
  under,
  ctx,
  close
}: {
  request: SheetRequest
  row: SettingsRow | null
  under: boolean
  ctx: RowContext
  close(): void
}): JSX.Element | null {
  // The row a dialog was opened for is gone (its item was deleted, its list changed): the
  // dialog has nothing to show and leaves.
  const orphan = row === null || !fits(request, row)
  useEffect(() => {
    if (orphan) close()
  }, [orphan, close])
  if (orphan) return null
  switch (request.kind) {
    case 'options':
      return <OptionsDialog row={row as ValueRow} under={under} close={close} />
    case 'field':
      return <FieldDialog row={row as FieldRow} under={under} close={close} />
    case 'confirm':
      // A prompt opens nothing (§9.24), so it is never `under`: the stack's `under` is the
      // lower dialog's to wear.
      return <ConfirmRowDialog row={row as ActionRow} close={close} />
    case 'form':
      return <FormDialog row={row as ActionRow} under={under} close={close} />
    case 'item':
      return <ItemDialog row={row as ItemRow} under={under} ctx={ctx} close={close} />
    case 'detail':
      return <ItemDialog row={row as DetailRow} under={under} ctx={ctx} close={close} />
  }
}

function fits(request: SheetRequest, row: SettingsRow): boolean {
  switch (request.kind) {
    case 'options':
      return row.kind === 'value'
    case 'field':
      return row.kind === 'field'
    case 'confirm':
      return row.kind === 'action' && row.confirm !== undefined
    case 'form':
      return row.kind === 'action' && row.form !== undefined
    case 'item':
      return row.kind === 'item'
    case 'detail':
      return row.kind === 'detail'
  }
}

// ---------------------------------------------------------------------------
// The dialog chassis
// ---------------------------------------------------------------------------

interface DialogProps {
  /** The dialog's `data-dialog`, for the tests and the harness. */
  name: string
  title: string
  description?: string
  /** A description that reports a status (an extension's load error): the §1 status ink. */
  descriptionTone?: 'warn' | 'danger'
  /** Another dialog is open over this one: it is inert, and Escape is that dialog's. */
  under: boolean
  onClose(): void
  children: ReactNode
  /**
   * Where the focus goes as the dialog opens: the element this finds in the dialog, else the
   * first tabbable control, else the root itself (a dialog with nothing tabbable holds the
   * focus on its container, as the prompt primitive does).
   */
  initial?(root: HTMLElement): HTMLElement | null
  /**
   * `list` when the body is a list of rows: the dialog stands at most 80% of the frame and the
   * list scrolls under the title block, and a footer the body claims takes §9.20's list-body
   * form (the hairline in the gutter, the buttons at 12) – `.zen-settings-dialog[data-body]`.
   */
  body?: 'list'
  className?: string
}

const TABBABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * One v2 dialog in the frame's dialog host: the shared `.zen-v2-dialog` (the neutral panel,
 * radius 12, a hairline, the sheet shadow) at §9.20's form width (a confirmation is not one of
 * these: it is the `ConfirmDialog` primitive at the notice width), a §9.23 title block with the
 * hairline once the body has scrolled, the body scrolling between the title and whatever footer
 * its content draws (§9.11: the buttons hug the end) – in the body for a form's own actions, or
 * in the dialog's footer slot under the body for actions a form puts there through
 * `SheetFooter`, drawn only while claimed (§9.20's list-body footer form when the body is a
 * list). Escape (on top of the popup stack only) and the scrim close it; the focus moves in as
 * it opens and back out to its opener as it leaves. The title labels the dialog and its
 * description describes it (`aria-describedby`), so a dialog that holds its container is
 * announced whole.
 */
export function SettingsDialog(props: DialogProps): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedDialog {...props} />
    </FrameDialogPortal>
  )
}

function HostedDialog({
  name,
  title,
  description,
  descriptionTone,
  under,
  onClose,
  children,
  initial,
  body,
  className
}: DialogProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [scrolled, setScrolled] = useState(false)
  useFrameDialog({ onScrimPress: onClose })
  // Escape is the top popup's (§9.24): the stack `useEscape` keeps, so a dialog under another,
  // under a menulist's popover or under a prompt a form opened over it waits for its turn.
  useEscape(onClose)
  // A dialog rendered inside this one's body – a form's prompt (`SiteDataPrompt`, through
  // `useCoversSheet`), a dialog nested in a dialog – covers it while it stands, as the page's
  // stack covers a dialog under another; this dialog tells its own host the same.
  const [covered, setCovered] = useState(false)
  const coverHost = useContext(SheetCoveredContext)
  useEffect(() => {
    if (!coverHost) return
    coverHost(true)
    return () => coverHost(false)
  }, [coverHost])
  const {
    slot: footerSlot,
    claimed: footerClaimed,
    setElement: setFooterElement
  } = useSheetFooterSlot()
  // The sheet's dismiss as the forms and rows inside know it (`useSheetDismiss`): the dialog has
  // no motion to wait for, so `after` – an action that opens a surface of its own once the
  // dialog is gone (`ActionRow.closesSheet`, a form's Cancel), a prompt's confirmed action –
  // runs at once. Only a function runs: a caller that bound the dismiss straight to a button
  // hands it the click's event, and the phone sheet's landing threw calling one (#145); the two
  // hosts take the same guard.
  const dismiss = useCallback<SheetDismiss>(
    (after) => {
      onClose()
      if (typeof after === 'function') after()
    },
    [onClose]
  )
  // Focus in as the dialog opens (§9.22), and back to the opener as it leaves (§9.24) – the
  // page's control, or the lower dialog's for a dialog that opened over one – unless the user
  // has already put it somewhere else outside the dialog host.
  const initialRef = useRef(initial)
  useLayoutEffect(() => {
    initialRef.current = initial
  }, [initial])
  useEffect(() => {
    const root = ref.current
    if (!root) return
    // The opener is whatever held the focus as this dialog came: a row of the page, or – for a
    // detail dialog over an item dialog – the item dialog's row, so the return goes one hop down
    // the stack (this dialog to that row, the item dialog in its turn to its own), never past
    // the lower dialog to the page. A prompt over a dialog returns the same way, by the
    // primitive's own hop (`ConfirmDialog`).
    const active = document.activeElement
    const opener = active instanceof HTMLElement && !root.contains(active) ? active : null
    const target = initialRef.current?.(root) ?? root.querySelector<HTMLElement>(TABBABLE) ?? root
    target.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      const lost = !now || now === document.body || now.closest('.zen-frame-dialogs') !== null
      // The stack drops the lower dialog's `inert` in the commit that removes this one, so the
      // control takes the focus at once; a control still under an `inert` as this runs (a cover
      // its host drops on its next render) takes it as that `inert` goes (`returnFocusTo`).
      if (lost && opener?.isConnected) returnFocusTo(opener)
    }
  }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-dialog={name}
      data-surface="page"
      data-body={body}
      inert={under || covered || undefined}
      tabIndex={-1}
      className={cn('zen-v2-dialog zen-settings-dialog zen-animate-pop', className)}
      style={{ width: POPOVER_WIDTH.form }}
      // The shared wrap (§9.22, lib/popover): Tab at the last control goes to the first,
      // Shift+Tab at the first to the last – and from the container itself, which holds the
      // focus in a form whose first control is a field (and in any dialog with nothing
      // tabbable), Tab enters at the first control and Shift+Tab at the last, never leaving for
      // whatever stands before the host in the document.
      onKeyDown={(e) => {
        if (ref.current) wrapTab(ref.current, e.nativeEvent)
      }}
    >
      <V2TitleBlock
        id={titleId}
        title={title}
        descriptionId={descriptionId}
        description={
          description && descriptionTone ? (
            <span data-tone={descriptionTone}>{description}</span>
          ) : (
            description
          )
        }
        scrolled={scrolled}
      />
      <div
        className="zen-settings-dialog-body"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <SheetDismissContext.Provider value={dismiss}>
          <SheetFooterContext.Provider value={footerSlot}>
            <SheetCoveredContext.Provider value={setCovered}>
              {children}
            </SheetCoveredContext.Provider>
          </SheetFooterContext.Provider>
        </SheetDismissContext.Provider>
      </div>
      {footerClaimed && (
        <div
          ref={setFooterElement}
          className="zen-settings-sheet-actions zen-settings-dialog-footer"
          data-testid="settings-dialog-footer"
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The five dialogs
// ---------------------------------------------------------------------------

/**
 * §9.13 as a dialog: the options as radio rows, the current one marked and focused as it opens;
 * a pick closes it. A value row in the content column trails its menulist and never opens this;
 * a search result's does (`rows.tsx`).
 */
function OptionsDialog({
  row,
  under,
  close
}: {
  row: ValueRow
  under: boolean
  close(): void
}): JSX.Element {
  return (
    <SettingsDialog
      name={`options:${row.id}`}
      title={row.label}
      description={row.sheetDescription}
      under={under}
      onClose={close}
      initial={(root) => root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')}
    >
      <div role="radiogroup" aria-label={row.label} className="zen-settings-sheet-rows">
        {optionGroups(row.options).map((group) => (
          <Fragment key={group.heading ?? ''}>
            {group.heading !== null && (
              <h3 className="zen-v2-heading zen-settings-heading">{group.heading}</h3>
            )}
            {group.options.map((option) => (
              <RadioOption
                key={option.value}
                label={option.label}
                description={option.description}
                leading={option.leading}
                checked={option.value === row.value}
                onSelect={() => {
                  if (option.value !== row.value) row.onChange(option.value)
                  close()
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </SettingsDialog>
  )
}

/**
 * The one field (§9.12), focused and selected as the dialog opens, its validation, Cancel and
 * Save. A commit that takes time (a key tried against its API) makes it the §9.30 busy form, as
 * the phone's sheet is: the field read-only with the typed value, Save busy, a refusal clearing
 * the field and showing the message, acceptance closing the dialog.
 */
function FieldDialog({
  row,
  under,
  close
}: {
  row: FieldRow
  under: boolean
  close(): void
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = `settings-field-${row.id.replace(/[^a-z0-9-]/gi, '-')}`
  const refuse = (message: string): void => {
    setError(message)
    setValue('')
    input.current?.focus()
  }
  const save = (): void => {
    if (busy) return
    const outcome = row.onCommit(value)
    if (outcome instanceof Promise) {
      setBusy(true)
      setError(null)
      void outcome
        .catch((e: unknown) => (e instanceof Error && e.message) || 'The check did not finish')
        .then((message) => {
          setBusy(false)
          if (message) refuse(message)
          else close()
        })
      return
    }
    if (outcome) {
      setError(outcome)
      return
    }
    close()
  }
  return (
    <SettingsDialog
      name={`field:${row.id}`}
      title={row.label}
      under={under}
      onClose={close}
      initial={(root) => {
        const field = root.querySelector<HTMLInputElement>('input')
        field?.select()
        return field
      }}
    >
      <div className="zen-settings-form" aria-busy={busy || undefined}>
        <Field id={id} label={row.label} description={error ? undefined : row.description}>
          <input
            ref={input}
            id={id}
            className={cn('zen-settings-input zen-v2-field', row.secret && 'zen-settings-secret')}
            type={row.input === 'number' ? 'number' : 'text'}
            inputMode={row.input === 'number' ? 'numeric' : row.input === 'url' ? 'url' : 'text'}
            min={row.min}
            max={row.max}
            placeholder={row.placeholder}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            readOnly={busy}
            aria-invalid={error ? true : undefined}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          {error && <ValidationMessage message={error} />}
        </Field>
        <SheetActions action="Save" busy={busy} onCancel={close} onAction={save} />
      </div>
    </SettingsDialog>
  )
}

/**
 * A row's confirmation (§9.23) on the program's prompt primitive (`ConfirmDialog`, W4-1): the
 * question as the title block over its one line (the confirmation's own, else the row's
 * description), Cancel and the verb – the danger verb with no primary for a destructive row,
 * the accent primary otherwise – and nothing else, at §9.20's 320 whatever it covers (§9.5: a
 * Remove prompt over an item's 400 dialog reads as a prompt, not a band across it; the #324
 * lead check). The keyboard is the primitive's (§9.22 as amended on #392): the container holds
 * the focus as the prompt opens, Tab enters at Cancel and Shift+Tab at the verb, Enter from the
 * container is the verb on a prompt that is not destructive and inert on one that is, Escape
 * and the scrim are Cancel. The way back (§9.5, one hop) is the row's own control – found by
 * its `data-row` as the prompt leaves, so a row re-rendered under the prompt is still found, and
 * a row the verb removed (with its item dialog, whose own return then governs) is not; never
 * Cancel. The `data-dialog` handle the stack's drives and smoke read (`confirm:<row>`) rides on
 * the root beside the primitive's `data-confirm`.
 */
function ConfirmRowDialog({ row, close }: { row: ActionRow; close(): void }): JSX.Element {
  const confirm = row.confirm!
  return (
    <ConfirmDialog
      name={row.id}
      title={confirm.title}
      description={confirm.description ?? row.description}
      action={confirm.action}
      destructive={row.destructive}
      onCancel={close}
      onConfirm={() => {
        close()
        row.onPress?.()
      }}
      returnFocus={() => rowControl(row.id)}
      data={{ 'data-dialog': `confirm:${row.id}` }}
    />
  )
}

/**
 * The control of the row `id` names (`data-row`, rows.tsx), wherever it stands – the page or an
 * item dialog: the `[data-row]` element itself when it is the control (a pressable row is one
 * button), else the control inside it – a control row's `data-row` sits on its static `div`
 * (`ControlRow`) and the 32 px button trails in it. The `div` itself is no place for the focus
 * (a `.focus()` on it is a no-op and the way back would fall to `body`).
 */
function rowControl(id: string): HTMLElement | null {
  const row = document.querySelector<HTMLElement>(`[data-row="${id.replace(/["\\]/g, '\\$&')}"]`)
  if (!row) return null
  return row.matches(TABBABLE) ? row : row.querySelector<HTMLElement>(TABBABLE)
}

/**
 * A small form (add a route, create a container): the form draws its own footer. A form whose
 * body is a list (`FormSheet.body`: the site-data viewer) is the list-bodied dialog – capped at
 * 80% of the frame, the list scrolling under the title block, its claimed footer in §9.20's
 * list-body form.
 */
function FormDialog({
  row,
  under,
  close
}: {
  row: ActionRow
  under: boolean
  close(): void
}): JSX.Element {
  const form = row.form!
  return (
    <SettingsDialog
      name={`form:${row.id}`}
      title={form.title}
      description={form.description}
      under={under}
      onClose={close}
      // A picker's list of options is a list body here: the same dialog, the same footer form.
      body={form.body && 'list'}
      initial={(root) => root.querySelector<HTMLElement>('input, textarea')}
    >
      {form.render(close)}
    </SettingsDialog>
  )
}

/**
 * One thing of a list and the rows that act on it, in the desktop vocabulary (a value row
 * trails its menulist, a boolean is a check row); its rows may open the second dialog – a
 * detail row's level (§10.4), the same shape one dialog deeper.
 */
function ItemDialog({
  row,
  under,
  ctx,
  close
}: {
  row: ItemRow | DetailRow
  under: boolean
  ctx: RowContext
  close(): void
}): JSX.Element {
  return (
    <SettingsDialog
      name={`${row.kind}:${row.id}`}
      title={row.sheet.title}
      description={row.sheet.description}
      descriptionTone={row.sheet.descriptionTone}
      under={under}
      onClose={close}
    >
      <GroupList
        groups={row.sheet.groups}
        ctx={ctx}
        variant="desktop"
        className="zen-settings-sheet-rows"
      />
    </SettingsDialog>
  )
}
