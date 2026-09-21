import type { FocusEvent as ReactFocusEvent, JSX, ReactNode } from 'react'
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { CreditCard, Fingerprint, KeyRound, MapPin, type LucideIcon } from 'lucide-react'
import type {
  AutofillPrompt,
  AutofillPromptResponse,
  PasskeyAccountPrompt,
  Rect,
  SaveAddressPrompt,
  SaveCardPrompt,
  SaveLoginPrompt,
  UIState
} from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { cn } from '@renderer/lib/utils'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  placePopover,
  popoverStyle,
  toRect,
  useFrameDialog,
  useLightDismiss,
  viewportSize
} from '@renderer/lib/portals'
import {
  addressTitle,
  answerAutofillPrompt,
  cardTitle,
  closeAutofillPrompt,
  currentAutofillPrompt,
  enterAutofillPrompt,
  expiryLabel,
  openAutofillPrompt,
  type AutofillPromptSurface
} from '@renderer/lib/autofill'
import { LEAK_HOLD_MS, savePromptHold } from '@renderer/lib/credentialLeak'
import { uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import {
  Btn,
  Field,
  Footer,
  InSheet,
  Labelled,
  SheetTitleBlock,
  TitleBlock,
  useEscape,
  useScrolled,
  wrapTab
} from './controls'

/** How long a prompt waits for the page it follows to finish loading before it shows anyway. */
const PAGE_WAIT_MS = 1500
/** How long a prompt raised by a submit gives the navigation that submit starts to begin. */
const SUBMIT_GRACE_MS = 400
/** The chip in the URL pill a desktop prompt hangs from (`NavRow`). */
export const CHIP_SELECTOR = '[data-af-chip]'
/** The prompt popover's pop, in and out (§9.20; `zen-animate-pop`'s 180). */
const PROMPT_POP_MS = 180

/**
 * The prompts of `UIState.autofill.prompts`, one at a time, for the active tab: save / update a
 * login, save an address or a card, choose a passkey account. On desktop the save prompts are
 * popovers under the URL bar (v2 §9.20: 400 wide, end-aligned with the key chip in the pill,
 * §9.23 title block with the site's favicon as its glyph, no scrim), put away behind the chip
 * by Escape or a press outside and brought back by it (Chrome's key icon); the passkey chooser
 * is a modal dialog in the frame (`FrameDialogHost`). On phones every one is a sheet on the
 * `BottomSheet` chassis, hosted by the same frame dialog host (`useFrameDialog` with
 * `ownScrim`: the sheet draws the stack's scrim and recedes the page itself): the same
 * composition as the desktop surface in a sheet's chrome (§9.23 – grip strip, the title block
 * with its 20 px glyph and the description, the body, the full-width footer actions of §9.11,
 * no 48 header); dragging it away is "not now". Answers go to the core (`autofill.respond`),
 * which saves and moves on to the next prompt.
 *
 * A sign-in that is also a known leak raises Chrome's "Change your password" warning beside
 * the save prompt (`LeakWarning.tsx`, ID-31), and Chrome shows the warning first. On a mouse
 * that falls out of the chassis: the warning is a frame dialog, and a dialog opening puts the
 * popover away behind its chip (§9.20), where the chip brings it back once the warning is
 * answered. On a phone both are sheets, so the order is kept here: a save sheet that has not
 * risen yet waits while a warning is up for its tab, and while the tab's leak check is still
 * running – for `LEAK_HOLD_MS` at most (`savePromptHeld`, lib/credentialLeak.ts) – and a warning
 * finding the save sheet already up waits for it (`LeakWarnings`); two sheets never stack for
 * this.
 */
export function AutofillPrompts({ state }: { state: UIState }): JSX.Element | null {
  const prompt = currentAutofillPrompt(state)
  const collapsed = uiStore.use((s) => s.autofillPromptCollapsed)
  const phone = useViewport().formFactor === 'phone'
  if (!prompt) return null
  const surface: AutofillPromptSurface = phone
    ? 'sheet'
    : prompt.kind === 'passkey-account'
      ? 'dialog'
      : 'popover'
  if (surface === 'popover' && collapsed === prompt.id) return null
  const tab = prompt.tabId ? state.tabs[prompt.tabId] : undefined
  return (
    <PromptHost
      key={prompt.id}
      prompt={prompt}
      surface={surface}
      loading={Boolean(tab?.loading)}
      favicon={tab?.favicon ?? null}
      state={state}
    />
  )
}

/**
 * A save prompt follows the navigation that confirmed the sign-in, and the page's picture stands
 * in under the prompt: wait for the page to finish loading (not for long) before capturing it.
 * A checkout's card and address prompts come up on the submit itself, before the navigation it
 * starts: those get a moment for it to begin, so the picture is of the page that follows.
 * A phone sheet that has not come up yet holds for a leak warning on its tab, or for the tab's
 * check while it runs (`savePromptHeld`); one that is up stays up (its username may have been
 * edited), and the warning waits for it instead.
 */
function PromptHost({
  prompt,
  surface,
  loading,
  favicon,
  state
}: {
  prompt: AutofillPrompt
  surface: AutofillPromptSurface
  loading: boolean
  favicon: string | null
  state: UIState
}): JSX.Element | null {
  const [settled, setSettled] = useState(prompt.kind === 'passkey-account')
  const sawLoad = useRef(false)
  // The hold for a running check runs out on its own clock: a slow lookup never keeps the sheet.
  const [holdOver, setHoldOver] = useState(false)
  const hold = surface === 'sheet' ? savePromptHold(state, prompt.tabId) : null
  useEffect(() => {
    if (hold !== 'check' || holdOver || settled) return
    const timer = window.setTimeout(() => setHoldOver(true), LEAK_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [hold, holdOver, settled])
  const held = hold === 'warning' || (hold === 'check' && !holdOver)
  useEffect(() => {
    if (settled) return
    if (loading) sawLoad.current = true
    if (held) return
    // Once the load ends the wait is over on the next tick; otherwise it runs out on its own.
    const followsSubmit = prompt.kind === 'save-card' || prompt.kind === 'save-address'
    const wait = loading ? PAGE_WAIT_MS : followsSubmit && !sawLoad.current ? SUBMIT_GRACE_MS : 0
    const timer = window.setTimeout(() => setSettled(true), wait)
    return () => window.clearTimeout(timer)
  }, [loading, settled, held, prompt.kind])
  if (!settled) return null
  return <Prompt prompt={prompt} surface={surface} favicon={favicon} />
}

type Respond = (response: AutofillPromptResponse | null) => void

function Prompt({
  prompt,
  surface,
  favicon
}: {
  prompt: AutofillPrompt
  surface: AutofillPromptSurface
  favicon: string | null
}): JSX.Element {
  const answered = useRef(false)

  // The page's views hide under chrome that overlaps them; its snapshot stands in meanwhile.
  useEffect(() => {
    let gone = false
    void openAutofillPrompt(prompt.tabId, surface).then(() => {
      if (gone) closeAutofillPrompt()
    })
    return () => {
      gone = true
      closeAutofillPrompt()
    }
  }, [prompt.tabId, surface])

  const respond: Respond = (response) => {
    if (answered.current) return
    answered.current = true
    answerAutofillPrompt(prompt.id, response)
  }

  switch (surface) {
    case 'popover':
      // The chooser is never a popover (`AutofillPrompts` makes it a dialog); a sheet on phones.
      if (prompt.kind === 'passkey-account')
        return <PromptDialog prompt={prompt} respond={respond} />
      return <PromptPopover prompt={prompt} favicon={favicon} respond={respond} />
    case 'dialog':
      return <PromptDialog prompt={prompt} respond={respond} />
    case 'sheet':
      return <PromptSheet prompt={prompt} favicon={favicon} respond={respond} />
  }
}

// ---------------------------------------------------------------------------
// Copy and bodies, shared by the surfaces
// ---------------------------------------------------------------------------

interface PromptCopy {
  /** The title block's glyph when the site has no favicon to show. */
  icon: LucideIcon
  /** Whether the site's favicon stands in for the glyph (the login prompts are about the site). */
  favicon: boolean
  title: string
  description: string
}

/** The prompt's title and one short line under it (§9.23): what happens if you say yes. */
function copyFor(prompt: AutofillPrompt): PromptCopy {
  switch (prompt.kind) {
    case 'save-login':
      return {
        icon: KeyRound,
        favicon: true,
        title: `Save password for ${prompt.site}?`,
        description: 'Zenium fills it in the next time you sign in.'
      }
    case 'update-login':
      return {
        icon: KeyRound,
        favicon: true,
        title: `Update password for ${prompt.site}?`,
        description: 'The saved password changes to the one you just signed in with.'
      }
    case 'save-address':
      return {
        icon: MapPin,
        favicon: false,
        title: 'Save address?',
        description: 'Zenium fills it into forms on any site.'
      }
    case 'save-card':
      return {
        icon: CreditCard,
        favicon: false,
        title: 'Save card?',
        description:
          'Filled into checkouts after you verify it is you. The security code is never saved.'
      }
    case 'passkey-account':
      return {
        icon: Fingerprint,
        favicon: false,
        title: 'Choose a passkey',
        description: `Sign in to ${prompt.rpId} with one of the passkeys saved for it.`
      }
  }
}

/** The site's favicon as the title block's 16 px glyph, when the prompt is about a site and it has one. */
function titleGlyph(copy: PromptCopy, favicon: string | null): ReactNode {
  if (!copy.favicon || !favicon) return undefined
  return <img src={favicon} alt="" draggable={false} />
}

/**
 * A static row showing what would be saved – or, in the leak warning, the account the sign-in
 * was for: glyph, title line, description line (§9.2) – the shared row, no target, so
 * `data-static` (§9.34).
 */
export function PreviewRow({
  icon: Icon,
  title,
  subtitle
}: {
  icon: LucideIcon
  title: string
  subtitle: string
}): JSX.Element {
  return (
    <div className="zen-v2-row zen-v2-af-row zen-v2-af-preview" data-static="">
      <span className="zen-v2-af-row-icon">
        <Icon aria-hidden />
      </span>
      <span className="zen-v2-af-row-text">
        <span className="zen-v2-af-row-title">{title}</span>
        {subtitle && <span className="zen-v2-af-row-desc">{subtitle}</span>}
      </span>
    </div>
  )
}

/** One action of a prompt's footer. */
interface Action {
  label: string
  variant?: 'primary' | 'secondary'
  response: AutofillPromptResponse | null
  /** The action leaves the prompt collapsed instead of answered (the desktop "Not now"). */
  collapse?: boolean
}

/**
 * The form of a save / update prompt: the username to file the password under (editable, as in
 * Chrome's bubble), then the actions. Save, Never (save prompts only) and Not now; on a phone
 * two peers share the footer and "not now" is the dismissal of the sheet.
 */
function LoginBody({
  prompt,
  phone,
  focusOnOpen = false,
  render
}: {
  prompt: SaveLoginPrompt
  phone: boolean
  /** The field takes the focus as the prompt opens: a popover the user opened (§9.22), not a phone sheet or a notice. */
  focusOnOpen?: boolean
  render: (form: ReactNode, actions: Action[], submit: () => AutofillPromptResponse) => JSX.Element
}): JSX.Element {
  const [username, setUsername] = useState(prompt.username)
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusOnOpen && !phone) field.current?.focus()
  }, [focusOnOpen, phone])
  const save = (): AutofillPromptResponse => ({
    action: 'save',
    username: username.trim() === prompt.username ? undefined : username.trim()
  })
  const primary = prompt.kind === 'save-login' ? 'Save' : 'Update'
  const actions: Action[] =
    prompt.kind === 'save-login'
      ? phone
        ? [
            { label: 'Never', response: { action: 'never' } },
            { label: 'Save', variant: 'primary', response: save() }
          ]
        : [
            { label: 'Never', response: { action: 'never' } },
            { label: 'Not now', response: null, collapse: true },
            { label: 'Save', variant: 'primary', response: save() }
          ]
      : [
          { label: 'Not now', response: null, collapse: !phone },
          { label: primary, variant: 'primary', response: save() }
        ]
  const form = (
    <Labelled label="Username" htmlFor={id}>
      <Field
        ref={field}
        id={id}
        value={username}
        autoComplete="username"
        spellCheck={false}
        onChange={(e) => setUsername(e.target.value)}
      />
    </Labelled>
  )
  return render(form, actions, save)
}

function addressBody(prompt: SaveAddressPrompt): { body: ReactNode; actions: Action[] } {
  return {
    body: (
      <PreviewRow icon={MapPin} title={addressTitle(prompt.address)} subtitle={prompt.preview} />
    ),
    actions: [
      { label: 'Not now', response: null },
      { label: 'Save', variant: 'primary', response: { action: 'save' } }
    ]
  }
}

function cardBody(prompt: SaveCardPrompt): { body: ReactNode; actions: Action[] } {
  const expiry = `expires ${expiryLabel(prompt.expMonth, prompt.expYear)}`
  return {
    body: (
      <PreviewRow
        icon={CreditCard}
        title={cardTitle({ network: prompt.network, last4: prompt.last4, nickname: '' })}
        subtitle={[prompt.name, expiry].filter(Boolean).join(', ')}
      />
    ),
    actions: [
      { label: 'Not now', response: null },
      { label: 'Save', variant: 'primary', response: { action: 'save' } }
    ]
  }
}

/**
 * The passkey chooser's rows: one per account. The first (most recently used) is active and takes
 * the focus as the chooser opens (§9.22: a panel of rows focuses its first row). In the desktop
 * dialog that is this component's own rule – `FrameDialogHost` moves no focus; in the phone
 * sheet the chassis does it (#172: the selected option takes the focus as the sheet opens), so
 * the sheet's rows leave it to the chassis.
 */
function PasskeyRows({
  prompt,
  respond
}: {
  prompt: PasskeyAccountPrompt
  respond: Respond
}): JSX.Element {
  const [active, setActive] = useState(0)
  const first = useRef<HTMLButtonElement>(null)
  const sheet = useContext(InSheet)
  useEffect(() => {
    if (!sheet) first.current?.focus({ preventScroll: true })
  }, [sheet])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const count = prompt.accounts.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next =
        active < 0
          ? e.key === 'ArrowDown'
            ? 0
            : count - 1
          : e.key === 'ArrowDown'
            ? (active + 1) % count
            : (active - 1 + count) % count
      setActive(next)
      const rows = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')
      rows[next]?.focus()
    }
  }
  return (
    <div role="listbox" aria-label="Passkeys" className="zen-v2-af-list" onKeyDown={onKeyDown}>
      {prompt.accounts.map((account, i) => (
        <button
          key={account.credentialId}
          ref={i === 0 ? first : undefined}
          type="button"
          role="option"
          aria-selected={active === i}
          data-active={active === i || undefined}
          className="zen-v2-row zen-v2-af-row"
          tabIndex={active === i || (active < 0 && i === 0) ? 0 : -1}
          onPointerEnter={() => setActive(i)}
          onFocus={() => setActive(i)}
          onClick={() => respond({ action: 'pick', credentialId: account.credentialId })}
        >
          <span className="zen-v2-af-row-icon">
            <Fingerprint aria-hidden />
          </span>
          <span className="zen-v2-af-row-text">
            <span className="zen-v2-af-row-title">{account.userName}</span>
            <span className="zen-v2-af-row-desc">{prompt.rpId}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Desktop popover (§9.20) under the URL bar, hanging from the key chip
// ---------------------------------------------------------------------------

interface ChipRects {
  /** The key chip in the pill (`AutofillChip`); null when the pill is not on screen. */
  chip: Rect | null
  /** The address pill the chip sits in: the popover's top edge is the pill's bottom edge. */
  pill: Rect | null
}

/**
 * The viewport rects of the key chip and its pill, measured after layout and again when either
 * or the window resizes. The chip renders in the same commit as the prompt (both follow the
 * pending prompt), so it is in the document by the time this measures.
 */
function useChipRects(): ChipRects {
  const [rects, setRects] = useState<ChipRects>({ chip: null, pill: null })
  useLayoutEffect(() => {
    const chip = document.querySelector<HTMLElement>(CHIP_SELECTOR)
    if (!chip) return
    const pill = chip.closest<HTMLElement>('.zen-pill')
    const measure = (): void =>
      setRects({
        chip: toRect(chip.getBoundingClientRect()),
        pill: pill ? toRect(pill.getBoundingClientRect()) : null
      })
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(chip)
    if (pill) observer?.observe(pill)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [])
  return rects
}

function PromptPopover({
  prompt,
  favicon,
  respond
}: {
  prompt: Exclude<AutofillPrompt, PasskeyAccountPrompt>
  favicon: string | null
  respond: Respond
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolled = useScrolled(bodyRef)
  const titleId = useId()
  const copy = copyFor(prompt)
  const { chip, pill } = useChipRects()
  // Whether the chip brought the prompt back by hand (`toggleAutofillPrompt`), read as it opens.
  const [byHand] = useState(() => uiStore.get().autofillPromptByHand === prompt.id)
  const [closing, setClosing] = useState(false)

  // "Not now", Escape and the chrome layer's light dismiss – a press outside (the focus stays
  // where it landed), the chip's own press (the layer hands it the focus and consumes the press,
  // so the chip does not reopen it), a scroll, a resize, another popover or a frame dialog
  // opening – put the prompt away behind its chip: the pop reversed towards the chip, 180 ms,
  // opacity with it (§9.20), the chip lit to bring it back, and the focus on the chip when the
  // keyboard put it away (§9.22). With no chip on screen (compact mode has no pill) there would
  // be no way back, so the prompt is dismissed instead ("not now").
  const collapse = (toChip: boolean): void => {
    if (closing) return
    const chipEl = document.querySelector<HTMLElement>(CHIP_SELECTOR)
    if (!chipEl) {
      respond(null)
      return
    }
    if (toChip) chipEl.focus({ preventScroll: true })
    if (reducedMotion()) {
      uiStore.set({ autofillPromptCollapsed: prompt.id })
      return
    }
    setClosing(true)
    window.setTimeout(() => uiStore.set({ autofillPromptCollapsed: prompt.id }), PROMPT_POP_MS)
  }
  useEscape(() => collapse(true))
  useBackSurface({ name: 'autofill-prompt', onCommit: () => collapse(false) })
  useLightDismiss(panelRef, () => collapse(false), {
    anchor: () => document.querySelector(CHIP_SELECTOR),
    disabled: closing
  })

  const act = (action: Action): void => {
    if (closing) return
    if (action.collapse) collapse(true)
    else respond(action.response)
  }

  // Focus (§9.22). Raised by the page – the user just submitted a form and is reading the page –
  // the prompt is a notice: it takes no focus and moves none, announces itself as a
  // `role="status"` region, and the keyboard reaches it with Tab from its chip (`AutofillChip`
  // steps into `enterAutofillPrompt`) or by a click into it, which is when its field takes the
  // focus. Brought back by hand from the chip it is a popover the user opened: the login prompts
  // focus their username field, the address and card prompts (a title and a notice with actions,
  // no field) their container, named by the title. Inside, Tab wraps; Escape returns to the chip.
  const notice = prompt.kind === 'save-address' || prompt.kind === 'save-card'
  useEffect(() => {
    if (byHand && notice) panelRef.current?.focus({ preventScroll: true })
  }, [byHand, notice])
  const onPanelFocus = (e: ReactFocusEvent<HTMLDivElement>): void => {
    // The container itself took the focus (a click on the panel's text, `enterAutofillPrompt`):
    // a prompt with a field hands it on to the field.
    if (e.target === e.currentTarget) enterAutofillPrompt(e.currentTarget)
  }

  // With no pill on screen (compact mode) the prompt stands in the window's top trailing corner.
  const viewport = viewportSize()
  const anchor = chip ?? {
    x: viewport.width - POPOVER_MARGIN - 28,
    y: 28,
    width: 28,
    height: 28
  }
  const box = placePopover(anchor, pill ?? anchor, viewport, POPOVER_WIDTH.form)
  // The pop grows from the chip and collapses back into it: its origin is the chip's centre on
  // the popover's edge that faces the pill (§9.20).
  const originX = Math.round(anchor.x + anchor.width / 2 - box.left)
  const transformOrigin = `${originX}px ${box.side === 'below' ? '0' : '100%'}`

  const footer = (actions: Action[]): JSX.Element => (
    <Footer count={actions.length}>
      {actions.map((a) => (
        <Btn key={a.label} variant={a.variant} onClick={() => act(a)}>
          {a.label}
        </Btn>
      ))}
    </Footer>
  )

  const preview = (body: ReactNode, actions: Action[]): JSX.Element => (
    <div className="zen-v2-af-form">
      {body}
      {footer(actions)}
    </div>
  )
  let content: JSX.Element
  switch (prompt.kind) {
    case 'save-address': {
      const { body, actions } = addressBody(prompt)
      content = preview(body, actions)
      break
    }
    case 'save-card': {
      const { body, actions } = cardBody(prompt)
      content = preview(body, actions)
      break
    }
    default:
      content = (
        <LoginBody
          prompt={prompt}
          phone={false}
          focusOnOpen={byHand}
          render={(form, actions, submit) => (
            <form
              className="zen-v2-af-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (!closing) respond(submit())
              }}
            >
              {form}
              {footer(actions)}
            </form>
          )}
        />
      )
  }

  return (
    <ChromePortal>
      <div
        ref={panelRef}
        role={byHand ? 'dialog' : 'status'}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-af-prompt=""
        data-closing={closing || undefined}
        className={cn(
          'zen-v2-af zen-v2-af-popover fixed z-[70]',
          closing ? 'zen-v2-af-pop-out' : 'zen-animate-pop'
        )}
        data-surface="page"
        style={{ ...popoverStyle(box), transformOrigin }}
        onFocus={onPanelFocus}
        onKeyDown={(e) => wrapTab(e, panelRef.current)}
      >
        <TitleBlock
          id={titleId}
          icon={copy.icon}
          glyph={titleGlyph(copy, favicon)}
          title={copy.title}
          description={copy.description}
          scrolled={scrolled}
        />
        <div ref={bodyRef} className="zen-v2-af-body">
          {content}
        </div>
      </div>
    </ChromePortal>
  )
}

// ---------------------------------------------------------------------------
// Desktop dialog (§9.5) in the frame: the passkey chooser
// ---------------------------------------------------------------------------

function PromptDialog({
  prompt,
  respond
}: {
  prompt: AutofillPrompt
  respond: Respond
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolled = useScrolled(bodyRef)
  const titleId = useId()
  const copy = copyFor(prompt)
  // The page waits on the answer: only the buttons, Escape and back answer it (cancel).
  useFrameDialog()
  useEscape(() => respond(null))
  useBackSurface({ name: 'autofill-prompt', onCommit: () => respond(null) })
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="zen-v2-af zen-v2-af-dialog zen-animate-pop"
      data-surface="page"
      onKeyDown={(e) => wrapTab(e, panelRef.current)}
    >
      <TitleBlock
        id={titleId}
        icon={copy.icon}
        title={copy.title}
        description={copy.description}
        scrolled={scrolled}
      />
      <div ref={bodyRef} className="zen-v2-af-body">
        {prompt.kind === 'passkey-account' && (
          <div className="zen-v2-af-form">
            <PasskeyRows prompt={prompt} respond={respond} />
            <Footer count={1}>
              <Btn onClick={() => respond(null)}>Cancel</Btn>
            </Footer>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phone sheet (§9.11, §9.23) on the BottomSheet chassis
// ---------------------------------------------------------------------------

/**
 * A prompt sheet (§9.23): no 48 header – the grip strip, then the chassis' title block first in
 * the body (its glyph the site's favicon for the login prompts, 20 px on the phone; the
 * description 15 at 69% 4 under the title), the body, the §9.11 footer whose peers share the
 * width. A modal dialog of the frame: it mounts in `FrameDialogHost`'s slot as the sheet on the
 * chassis (`hosted`, `useFrameDialog` with `ownScrim` – the sheet's scrim is the stack's, its
 * press the dismissal), and the chassis owns the focus on open (the selected passkey row, else
 * the first control), the Tab trap, the inert chrome and the keyboard lift under the username.
 */
function PromptSheet({
  prompt,
  favicon,
  respond
}: {
  prompt: AutofillPrompt
  favicon: string | null
  respond: Respond
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const copy = copyFor(prompt)
  // What the sheet answers is decided by how it leaves: a button dismisses it with its answer
  // in hand; a drag, the scrim, back or Escape leave it with none ("not now").
  const answer = useRef<AutofillPromptResponse | null>(null)
  const leave = (response: AutofillPromptResponse | null): void => {
    answer.current = response
    sheet.current?.dismiss()
  }
  useFrameDialog({ onScrimPress: () => leave(null), ownScrim: true })
  useBackSurface({
    name: 'autofill-prompt',
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())

  const footer = (actions: Action[]): JSX.Element => (
    <Footer count={actions.length}>
      {actions.map((a) => (
        <Btn key={a.label} variant={a.variant} onClick={() => leave(a.response)}>
          {a.label}
        </Btn>
      ))}
    </Footer>
  )

  let content: JSX.Element
  switch (prompt.kind) {
    case 'save-login':
    case 'update-login':
      content = (
        <LoginBody
          prompt={prompt}
          phone
          render={(form, actions, submit) => (
            <form
              className="zen-v2-af-form"
              onSubmit={(e) => {
                e.preventDefault()
                leave(submit())
              }}
            >
              {form}
              {footer(actions)}
            </form>
          )}
        />
      )
      break
    case 'save-address':
    case 'save-card': {
      const { body, actions } =
        prompt.kind === 'save-address' ? addressBody(prompt) : cardBody(prompt)
      content = (
        <div className="zen-v2-af-form">
          {body}
          {footer(actions)}
        </div>
      )
      break
    }
    case 'passkey-account':
      content = (
        <>
          <PasskeyRows prompt={prompt} respond={(r) => leave(r)} />
          <div className="zen-v2-af-form">{footer([{ label: 'Cancel', response: null }])}</div>
        </>
      )
      break
  }

  // The sheet's layer is the host slot's child itself (`data-sheet-layer`).
  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={() => respond(answer.current)}
      handleLabel="Dismiss"
      labelledBy={titleId}
      className="zen-v2-af zen-v2-af-sheet"
      fitContent
    >
      <InSheet.Provider value>
        <div className="zen-v2-af" data-surface="page">
          <SheetTitleBlock
            id={titleId}
            icon={copy.icon}
            glyph={titleGlyph(copy, favicon)}
            title={copy.title}
            description={copy.description}
          />
          {content}
        </div>
      </InSheet.Provider>
    </BottomSheet>
  )
}
