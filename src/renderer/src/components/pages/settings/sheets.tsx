import type { JSX, ReactNode, RefObject } from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SheetBody } from '@renderer/lib/motion/sheet'
import { cn } from '@renderer/lib/utils'
import { PhoneSheet, type SheetFocus, type SheetTitle } from '../../phone/PhoneSheet'
import type { BottomSheetHandle } from '../../sheet/BottomSheet'
import { RadioOption, SheetActions, ValidationMessage } from './blocks'
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
  SheetDismissContext,
  SheetFooterContext,
  SheetRelayoutContext,
  useSheetDismiss,
  useSheetFooterSlot
} from './sheetContext'

/**
 * The sheets a phone Settings row opens (v2 §9.13, §9.23–9.25, §10.4): a value row's picker, a
 * field row's one-field form, a destructive action's confirmation, an action's small form, an
 * item's rows and a detail row's level of them. The page keeps a stack of at most two requests
 * (§9.24: a sheet may open one sheet, and that one opens nothing) and resolves each to its row
 * again on every render, so a sheet always shows the row's current value and closes by itself
 * when its row is gone.
 *
 * Every sheet is the phone's shared `PhoneSheet` (components/phone/PhoneSheet.tsx): a modal
 * dialog in the frame's dialog host, over the content frame, which recedes under a sheet and
 * would shrink a sheet inside it, drawing its scrim itself, its title in the chassis's two poses
 * – the 48 header for a picker, a form or a sheet of rows, the §9.23 title block when the sheet
 * carries a description – and answering the system back and Escape (a sheet under another
 * leaves the key to the one on top). The stack and the keyboard are the chassis's
 * (`BottomSheet`, §9.22, §9.24, §11.2): focus moves into a sheet as it opens (the checked option
 * of a picker, else the first row or button – a form's Cancel, since a text field would bring
 * the keyboard up with the sheet), Tab wraps inside it, the chrome behind the scrim is inert; a
 * sheet that opens over a sheet recedes the one beneath and makes it `inert`, the lower scrim
 * fades out as the upper comes in – one scrim, the top sheet's, above the page and the lower
 * sheet alike – and when the upper leaves, focus returns to the row of the lower sheet that
 * opened it. Nothing here does any of that itself; what is the Settings tab's is the body: its
 * rows, its forms and the two contexts they reach the sheet through – and, for a confirmation,
 * the desktop prompt primitive's default key on the held container (`ConfirmSheet`).
 */

/** Every open sheet, lowest first; each resolves its row in `groups`. */
export function SheetStack({
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
          <RowSheet
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

function RowSheet({
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
  // The row a sheet was opened for is gone (its item was deleted, its list changed): the sheet
  // has nothing to show and leaves.
  const orphan = row === null || !fits(request, row)
  useEffect(() => {
    if (orphan) close()
  }, [orphan, close])
  if (orphan) return null
  switch (request.kind) {
    case 'options':
      return <OptionsSheet row={row as ValueRow} under={under} close={close} />
    case 'field':
      return <FieldSheet row={row as FieldRow} under={under} close={close} />
    case 'confirm':
      return <ConfirmRowSheet row={row as ActionRow} under={under} close={close} />
    case 'form':
      return <FormSheet row={row as ActionRow} under={under} close={close} />
    case 'item':
      return <ItemSheet row={row as ItemRow} under={under} ctx={ctx} close={close} />
    case 'detail':
      return <ItemSheet row={row as DetailRow} under={under} ctx={ctx} close={close} />
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
// The sheet chassis
// ---------------------------------------------------------------------------

interface SheetProps {
  /** For the back registry's logs. */
  name: string
  title: string
  /**
   * With a description the sheet opens on the §9.23 title block instead of the 48 px header
   * (`PhoneSheet`'s two poses): a prompt's paragraph, a form's or an item sheet's introduction.
   */
  description?: string
  /** A description that reports a status (an extension's load error): the §1 status ink. */
  descriptionTone?: 'warn' | 'danger'
  /** Another sheet is open over this one: Escape is that sheet's until it leaves. */
  under: boolean
  onClose(): void
  children: ReactNode
  /** Change it when the body is swapped, so the detents are measured again. */
  contentKey?: string
  /**
   * What takes the focus as the sheet opens (§9.22); omitted, the chassis's own order – the
   * checked option, else the first row or button. A confirmation passes `dialog`: the sheet
   * itself, named by its title and described by its paragraph – the prompt primitive's held
   * container, no verb preselected (`ConfirmSheet`).
   */
  focus?: SheetFocus
  /**
   * The sheet is a confirmation (§9.23): the desktop prompt primitive's default key
   * (components/dialogs/ConfirmDialog.tsx, §9.22 as amended on #392) on the held container –
   * Enter from it activates the verb on a prompt that is not `destructive`, and is inert on
   * one that is, since a destructive prompt has no default. A focused button keeps its own Enter.
   */
  defaultAction?: SheetDefaultAction
  /** The title element's id, for a field the header labels (§9.12's one-field sheet). */
  titleId?: string
  /**
   * The body is a list of rows (a picker's options, an item's rows, a list form): the sheet
   * stands at most 80 % of the frame and the list scrolls under the title (§9.20); a form or a
   * prompt stands as tall as it is.
   */
  body?: SheetBody
  /**
   * A §9.13 picker passes `'overflow'` (`PhoneSheet`'s `openExpanded`): rows that exceed the
   * peek open the sheet expanded and scrolled to the checked option; rows that fit keep the peek.
   */
  openExpanded?: boolean | 'overflow'
  sheetRef?: RefObject<BottomSheetHandle | null>
}

/**
 * One Settings sheet: the shared `PhoneSheet` with the Settings tab's class on the panel
 * (`.zen-settings-sheet`, main.css: the page's type, §9.25's edge that takes no layout so a
 * row's 16 gutter is 16 from the outer edge) and its body, which gives the rows and forms
 * inside it the sheet's dismiss, a way to ask for the detents again and the footer slot
 * (§9.11) – the chassis's `.zen-sheet-footer` under the body, drawn while a form claims it
 * through `SheetFooter`, and part of the content the detents are measured on. The footer is
 * measured once it has content: the chassis draws the footer element on the claim and
 * `SheetFooter`'s portal fills it a render later, so the detents taken on the claim are short
 * by the buttons; the element is watched (`ResizeObserver`, else one frame after it mounts)
 * and the detents asked for again when it has grown.
 */
export function SettingsSheet({
  name,
  title,
  description,
  descriptionTone,
  under,
  onClose,
  children,
  contentKey,
  focus,
  defaultAction,
  titleId,
  body,
  openExpanded,
  sheetRef
}: SheetProps): JSX.Element {
  const own = useRef<BottomSheetHandle>(null)
  const sheet = sheetRef ?? own
  const dismiss = (after?: () => void): void => sheet.current?.dismiss(after)
  const bodyRef = useRef<HTMLDivElement>(null)
  useDefaultAction(bodyRef, defaultAction, under)
  // A body that changes height once the sheet is up (a form shows more rows, a field appears)
  // asks for its detents again through `useSheetRelayout`: the chassis measures on a new key.
  const [relayouts, setRelayouts] = useState(0)
  const relayout = useCallback((): void => setRelayouts((n) => n + 1), [])
  const {
    slot: footerSlot,
    claimed: footerClaimed,
    setElement: setFooterElement
  } = useSheetFooterSlot()
  const footerWatch = useRef<(() => void) | null>(null)
  const footerRef = useCallback(
    (element: HTMLElement | null): void => {
      footerWatch.current?.()
      footerWatch.current = element ? watchFooter(element, relayout) : null
      setFooterElement(element)
    },
    [relayout, setFooterElement]
  )
  const pose: SheetTitle =
    description === undefined
      ? { pose: 'header', text: title }
      : { pose: 'block', text: title, description, tone: descriptionTone }
  return (
    <PhoneSheet
      name={name}
      title={pose}
      focus={focus}
      titleId={titleId}
      body={body}
      under={under}
      onClose={onClose}
      contentKey={`${contentKey ?? ''}|${relayouts}|${footerClaimed ? 'footer' : ''}`}
      openExpanded={openExpanded}
      className="zen-settings-sheet"
      sheetRef={sheet}
      footer={
        footerClaimed ? (
          <div
            ref={footerRef}
            className="zen-settings-sheet-actions zen-settings-sheet-footer"
            data-testid="settings-sheet-footer"
          />
        ) : undefined
      }
    >
      <div ref={bodyRef} className="zen-settings-sheet-body">
        <SheetDismissContext.Provider value={dismiss}>
          <SheetRelayoutContext.Provider value={relayout}>
            <SheetFooterContext.Provider value={footerSlot}>{children}</SheetFooterContext.Provider>
          </SheetRelayoutContext.Provider>
        </SheetDismissContext.Provider>
      </div>
    </PhoneSheet>
  )
}

/**
 * Ask for the detents again whenever the footer element changes height – its first fill by
 * `SheetFooter`'s portal above all, which lands a render after the element is drawn – so the
 * sheet stands tall enough for its buttons (the #322 review's Required 3: measured over the
 * empty footer, the viewer's sheet clipped its empty line to a sliver). A `ResizeObserver`
 * where the engine has one; else one frame after the element mounts, by when the portal has
 * filled it. Returns the function that stops watching.
 */
function watchFooter(element: HTMLElement, relayout: () => void): () => void {
  if (typeof ResizeObserver === 'function') {
    let last = element.offsetHeight
    const observer = new ResizeObserver(() => {
      const height = element.offsetHeight
      if (height === last) return
      last = height
      relayout()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }
  const frame = requestAnimationFrame(relayout)
  return () => cancelAnimationFrame(frame)
}

/** A confirmation sheet's verb, for the keyboard: whether the prompt is destructive, and the verb's action. */
export interface SheetDefaultAction {
  destructive: boolean
  onConfirm(): void
}

/** The control an Enter belongs to rather than to the prompt: a button answers its own Enter. */
const OWN_ENTER = 'button, a[href], [role="button"], select, textarea'

/**
 * The prompt primitive's default key (components/dialogs/ConfirmDialog.tsx; §9.22 as amended by
 * the design lead on #392) on the sheet's held container, in the primitive's own shape: an Enter
 * with no modifier, not a held key's repeat and not one composing text, from anything but a
 * control that answers its own Enter (`OWN_ENTER`), is the prompt's – consumed, so nothing
 * beneath answers it – and activates the verb on a prompt whose verb is the primary; a
 * DESTRUCTIVE prompt has no default (§6 draws it with no primary because the app recommends
 * neither answer, and a default key is a recommendation as much as a fill), so the key is inert.
 * Tab and Escape are the chassis's (`BottomSheet`'s wrap, `PhoneSheet`'s Escape). The listener
 * is a native one on the sheet's dialog root – the chassis's element, found up from the body –
 * because a focus held on the root stands above the body where the Settings tab's own markup
 * begins. A sheet under another leaves the key alone. The primitive exports its container's
 * keyboard as no hook or headless piece yet; until the desktop does, this is the phone's one
 * copy of the rule, kept word for word to the primitive's.
 */
function useDefaultAction(
  body: RefObject<HTMLElement | null>,
  action: SheetDefaultAction | undefined,
  under: boolean
): void {
  const latest = useRef({ action, under })
  useLayoutEffect(() => {
    latest.current = { action, under }
  })
  const wanted = action !== undefined
  useEffect(() => {
    if (!wanted) return
    const root = body.current?.closest<HTMLElement>('[role="dialog"]')
    if (!root) return
    const onKey = (e: KeyboardEvent): void => {
      const { action, under } = latest.current
      if (!action || under) return
      if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.repeat || e.isComposing) return
      if (e.target instanceof Element && e.target.closest(OWN_ENTER)) return
      e.preventDefault()
      e.stopPropagation()
      if (action.destructive) return
      action.onConfirm()
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [body, wanted])
}

// ---------------------------------------------------------------------------
// The five sheets
// ---------------------------------------------------------------------------

/**
 * §9.13 on a phone: the options as 44 px radio rows, the current one marked (and, by the
 * chassis, focused as the sheet opens); a pick closes it. Rows that exceed the peek open the
 * sheet expanded and scrolled to the checked option (`openExpanded: 'overflow'`); rows that fit
 * keep the peek. Exported for a form that keeps a value row of its own (Clear browsing data's
 * time range) and opens its picker over itself. Options under a heading (the search engine
 * picker's "Recently visited") follow the ungrouped ones, each set under its §10.3 heading.
 */
export function OptionsSheet({
  row,
  under,
  close
}: {
  row: ValueRow
  under: boolean
  close(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  return (
    <SettingsSheet
      name={`settings-options:${row.id}`}
      title={row.label}
      description={row.sheetDescription}
      under={under}
      body="list"
      onClose={close}
      openExpanded="overflow"
      sheetRef={sheet}
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
                  sheet.current?.dismiss()
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </SettingsSheet>
  )
}

/**
 * A desktop input as a sheet: the one field (§9.12), its validation message, Cancel and Save.
 * The sheet's header reads the field's name, so the field draws no label of its own (§9.12: a
 * one-field sheet whose title is the field's name – the title is the label, `aria-labelledby`
 * on the field – and the field starts at §9.16's 68, straight under the header); the row's
 * description, or the validation message, keeps its place under the field.
 * A commit that takes time (a key tried against its API, a resolver asked a question) makes it
 * the §9.30 busy form: the field read-only with the typed value at full opacity, Save busy with
 * the spinner in place of its label, Cancel at .4; a refusal clears the field, gives it the
 * focus and shows the message under it; acceptance closes the sheet with the value still shown.
 */
function FieldSheet({
  row,
  under,
  close
}: {
  row: FieldRow
  under: boolean
  close(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = `settings-field-${row.id.replace(/[^a-z0-9-]/gi, '-')}`
  const titleId = `${id}-title`
  // The line under the field – the error while one shows, the row's description otherwise – is
  // the field's description (`aria-describedby`), so a reader on the field hears it.
  const errorId = `${id}-error`
  const descriptionId = `${id}-description`
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
      outcome
        .catch((e: unknown) => (e instanceof Error && e.message) || 'The check did not finish')
        .then((message) => {
          setBusy(false)
          if (message) refuse(message)
          else sheet.current?.dismiss()
        })
      return
    }
    if (outcome) {
      setError(outcome)
      return
    }
    sheet.current?.dismiss()
  }
  return (
    <SettingsSheet
      name={`settings-field:${row.id}`}
      title={row.label}
      titleId={titleId}
      under={under}
      onClose={close}
      sheetRef={sheet}
    >
      <div className="zen-settings-form" aria-busy={busy || undefined}>
        <div className="zen-settings-field-block">
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
            aria-labelledby={titleId}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : row.description ? descriptionId : undefined}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          {error ? (
            <ValidationMessage id={errorId} message={error} />
          ) : (
            row.description && (
              <span id={descriptionId} className="zen-settings-description">
                {row.description}
              </span>
            )
          )}
        </div>
        <SheetActions
          action="Save"
          busy={busy}
          onCancel={() => sheet.current?.dismiss()}
          onAction={save}
        />
      </div>
    </SettingsSheet>
  )
}

/** A row's confirmation (`ActionRow.confirm`): the question, its paragraph (the confirmation's own, else the row's) and the row's verb. */
function ConfirmRowSheet({
  row,
  under,
  close
}: {
  row: ActionRow
  under: boolean
  close(): void
}): JSX.Element {
  const confirm = row.confirm!
  return (
    <ConfirmSheet
      name={`settings-confirm:${row.id}`}
      title={confirm.title}
      description={confirm.description ?? row.description}
      action={confirm.action}
      destructive={row.destructive}
      under={under}
      onClose={close}
      onConfirm={() => row.onPress?.()}
    />
  )
}

/**
 * The confirmation sheet (§9.23, §10.4): the desktop prompt primitive (`ConfirmDialog`,
 * components/dialogs) in the sheet's form – its words, `name`, `title`, `description`,
 * `action`, `destructive`, `onConfirm`, and its focus shape on the phone's chassis. The sheet
 * stays a sheet: the peek detent (a prompt stands as tall as its content, §9.20), the register
 * name for the back surface, `under`, the §9.23 title block over the one paragraph and
 * `SheetActions`' split footer (§9.11: the danger verb with no primary for a destructive
 * prompt, the accent primary otherwise) – nothing of the desktop's visuals comes over. A
 * confirmation with no paragraph would open on the 48 header (§9.23: the block is for a sheet
 * that carries a description), so every one in the model brings its own.
 *
 * The keyboard is the primitive's (§9.22 as amended on #392): the container holds the focus as
 * the sheet opens (`focus="dialog"`: `tabIndex -1`, the chassis draws no ring on it, no verb
 * preselected); Tab enters the sheet's own order and reaches Cancel, then the verb – the verb
 * never first – and Shift+Tab reaches the verb (the chassis's wrap, which on a sheet also holds
 * the grabber first in the order, as it does on every sheet); Enter from the held container
 * activates the verb as the default on a prompt that is not destructive and is inert on one
 * that is (`defaultAction`); Escape, the scrim and the back gesture are Cancel. The verb runs
 * once the sheet has gone (`dismiss(after)`: the row acts, or opens what it opens, over a page
 * with no sheet on it), and the focus goes back to the row that opened the sheet (§9.24, the
 * chassis's return). The same rules as the desktop's, so the two hosts land on one shape; the
 * lead's two: a confirmation over a sheet does not grow for its content – the sheet's width is
 * the sheet's, and its body is the block and the two buttons whatever it is asked – and a
 * destructive prompt has no default.
 */
export function ConfirmSheet({
  name,
  title,
  description,
  action,
  destructive = false,
  under,
  onClose,
  onConfirm
}: {
  /** The sheet's register name (`settings-confirm:<row>`): the back surface's and the harness's. */
  name: string
  /** The question, 17/600. */
  title: string
  /** The one paragraph (§9.23), under the title. */
  description?: string
  /** The verb's label: Clear, Delete, Remove, Reset. Cancel is always Cancel. */
  action: string
  /** The verb destroys something: the danger ink and no primary (§6), and no default key. */
  destructive?: boolean
  /** Another sheet stands over this one (§9.24): Escape and Enter are that sheet's. */
  under: boolean
  /** The sheet has left the screen. */
  onClose(): void
  /**
   * The verb: its button, and – on a prompt that is not `destructive` – Enter from the held
   * container; runs once the sheet has gone.
   */
  onConfirm(): void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const confirm = (): void => sheet.current?.dismiss(onConfirm)
  return (
    <SettingsSheet
      name={name}
      title={title}
      description={description}
      under={under}
      focus="dialog"
      defaultAction={{ destructive, onConfirm: confirm }}
      onClose={onClose}
      sheetRef={sheet}
    >
      <SheetActions
        action={action}
        destructive={destructive}
        onCancel={() => sheet.current?.dismiss()}
        onAction={confirm}
      />
    </SettingsSheet>
  )
}

/**
 * A small form (add a route, create a container): the form draws its own footer. A form whose
 * body is a picker of the row's current value (`body: 'picker'`, the Standard font's list of
 * families) is a §9.13 picker sheet: it opens expanded and scrolled to the checked option when
 * its rows exceed the peek.
 */
function FormSheet({
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
    <SettingsSheet
      name={`settings-form:${row.id}`}
      title={form.title}
      description={form.description}
      under={under}
      // A picker's list of options is a list body here too: the same 80 % cap (§9.20).
      body={form.body && 'list'}
      onClose={close}
      openExpanded={form.body === 'picker' ? 'overflow' : undefined}
    >
      <FormBody render={form.render} />
    </SettingsSheet>
  )
}

/** The form's element, given the sheet's own dismiss as its `close`. */
function FormBody({ render }: { render: (close: () => void) => ReactNode }): JSX.Element {
  const dismiss = useSheetDismiss()
  return <>{render(dismiss)}</>
}

/**
 * One thing of a list and the rows that act on it (the chassis focuses the first row as the
 * sheet opens); its value and detail rows open the second sheet. A detail row's level is the
 * same sheet of rows, one deeper (§9.24), so nothing in it opens another.
 */
function ItemSheet({
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
    <SettingsSheet
      name={`settings-${row.kind}:${row.id}`}
      title={row.sheet.title}
      description={row.sheet.description}
      descriptionTone={row.sheet.descriptionTone}
      under={under}
      body="list"
      onClose={close}
      contentKey={String(row.sheet.groups.reduce((n, g) => n + g.rows.length, 0))}
    >
      <GroupList groups={row.sheet.groups} ctx={ctx} className="zen-settings-sheet-rows" />
    </SettingsSheet>
  )
}
