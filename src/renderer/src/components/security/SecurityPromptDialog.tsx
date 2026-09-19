import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { BadgeCheck, KeyRound, TriangleAlert } from 'lucide-react'
import type {
  ClientCertificatePrompt,
  HttpAuthPrompt,
  SecurityPrompt,
  SecurityPromptResponse,
  UIState
} from '@shared/types'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { viewportStore } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import {
  closeSecurityPrompt,
  currentSecurityPrompt,
  httpAuthSpace,
  openSecurityPrompt,
  SIGN_IN_WAIT_MS
} from '@renderer/lib/security'
import { activeTab } from '@renderer/lib/selectors'
import { cn } from '@renderer/lib/utils'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
import { V2Button, V2Field, V2FormField } from '../extensions/v2'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { GLYPH } from './glyph'

const SCHEME_NAMES: Record<string, string> = {
  basic: 'Basic',
  digest: 'Digest',
  ntlm: 'NTLM',
  negotiate: 'Negotiate'
}

const REFUSED = 'The username or password was not accepted. Please try again.'

type Respond = (response: SecurityPromptResponse | null) => void

/** A sign-in that went to the server: the form stays up, busy, until it hears back (§9.30). */
interface Sent {
  prompt: HttpAuthPrompt
  at: number
  /** Whether the page was loading when the answer went: one that stops loading after was let in. */
  loading: boolean
  /** Taken as accepted; the form is on its way out. */
  done: boolean
}

/** Where the form's busy wait stands: nothing sent, waiting on the server, or accepted. */
type Busy = 'waiting' | 'done' | null

/**
 * HTTP authentication and client-certificate prompts, one at a time, tab-modal: a prompt waits
 * until its tab is the active one. Answers go back to the core, which resumes the request and
 * drops the prompt.
 *
 * A sign-in is the one answer the server judges (§9.30's busy form): the core retries the
 * request with it and, when it is refused, challenges the same protection space again – a new
 * prompt, `failedBefore`, within a round trip. So the form does not go with its prompt: it
 * stays up busy, keyed by its space rather than the prompt's id, and the refusal lands in the
 * same dialog – the password cleared, the validation line under it – while hearing nothing for
 * `SIGN_IN_WAIT_MS`, or the page finishing its load, means the credentials were accepted and
 * the form closes. A certificate choice is taken as given and its dialog goes at once.
 */
export function SecurityPrompts({ state }: { state: UIState }): JSX.Element | null {
  const live = currentSecurityPrompt(state)
  const [sent, setSent] = useState<Sent | null>(null)

  // A prompt arriving takes over from the busy form: the refusal (the same space asked again,
  // which the same dialog answers), or another prompt entirely.
  const liveId = live?.id ?? null
  const [seenId, setSeenId] = useState(liveId)
  if (liveId !== seenId) {
    setSeenId(liveId)
    if (liveId && sent) setSent(null)
  }

  // Nothing refused the answer: the wait ran out, the page finished loading behind the form,
  // or its tab went or was left.
  const tabId = sent?.prompt.tabId ?? null
  const tabGone = tabId !== null && !state.tabs[tabId]
  const loading = (tabId && state.tabs[tabId]?.loading) || false
  const shown = tabId === null || activeTab(state)?.id === tabId
  const settled = sent !== null && (sent.done || tabGone || !shown || (sent.loading && !loading))
  const waiting = !live && sent !== null && !settled
  const at = sent?.at ?? 0
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(
      () => setSent((s) => (s ? { ...s, done: true } : s)),
      Math.max(0, at + SIGN_IN_WAIT_MS - Date.now())
    )
    return () => clearTimeout(timer)
  }, [waiting, at])

  const prompt = live ?? sent?.prompt ?? null
  if (!prompt) return null
  const busy: Busy = live || !sent ? null : settled ? 'done' : 'waiting'
  return (
    <SecurityPromptDialog
      key={prompt.kind === 'http-auth' ? httpAuthSpace(prompt) : prompt.id}
      prompt={prompt}
      busy={busy}
      onSent={(p) =>
        setSent({
          prompt: p,
          at: Date.now(),
          loading: (p.tabId && state.tabs[p.tabId]?.loading) || false,
          done: false
        })
      }
      onGone={() => setSent(null)}
    />
  )
}

/** Desktop first focus: the first empty field – the password when the username came back filled. */
const firstEmptyField = (root: HTMLElement): HTMLElement | null =>
  [...root.querySelectorAll<HTMLInputElement>('input.zen-v2-field')].find((f) => !f.value) ?? null
/** Desktop first focus for a chooser: the option that is checked. */
const checkedOption = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')

/**
 * One prompt, one composition on both platforms (§9.23): a title block – glyph, 17/600 title,
 * the description 4 under it – over the form, ending in its actions (§9.20 footer form (i): the
 * last body element, 16, the buttons, 16 to the edge; no hairline). On desktop a 400 wide v2
 * dialog placed by TabDialogs' `FrameDialogHost`, which centres it in the content frame over the
 * scrim that dims only the frame and holds the window chrome inert; the scrim does not answer
 * it (only the buttons and Escape do), and it comes up on the 180 ms pop. Its keyboard is
 * `usePopover`'s (§9.22): focus starts in the first empty field or on the checked option, Tab
 * wraps, Escape is Cancel; the page, which raised the prompt, gets the keyboard back when the
 * dialog goes. On a phone the shared bottom sheet in the same host, drawing the stack's one
 * scrim itself: the grip strip, surface, title block, footer, the focus on open, the Tab trap,
 * the inert chrome and the lift above the keyboard are the chassis's; the sheet leaves first and
 * a cancel or a certificate choice goes once it is gone; pulling it away, the scrim, back and
 * Escape are Cancel. Both roots are page surfaces (§9.29).
 */
function SecurityPromptDialog({
  prompt,
  busy,
  onSent,
  onGone
}: {
  prompt: SecurityPrompt
  busy: Busy
  onSent: (prompt: HttpAuthPrompt) => void
  onGone: () => void
}): JSX.Element {
  const phone = viewportStore.use((s) => s.formFactor === 'phone')
  const answered = useRef(false)
  const sheet = useRef<BottomSheetHandle>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const ids = useId()
  const titleId = `${ids}-title`
  const formId = `${ids}-form`

  // The page's views hide under chrome overlays; its snapshot stands in while the dialog is up.
  // (An open still waiting for the snapshot when the dialog is closed, or opened again, gives way.)
  useEffect(() => {
    void openSecurityPrompt(prompt.tabId)
    return closeSecurityPrompt
  }, [prompt.tabId])

  // The same space asked again: the refused answer's dialog takes the new prompt.
  const lastId = useRef(prompt.id)
  useEffect(() => {
    if (lastId.current === prompt.id) return
    lastId.current = prompt.id
    answered.current = false
  }, [prompt.id])

  const respond: Respond = (response) => {
    if (answered.current) return
    answered.current = true
    run('security.respond', { id: prompt.id, response })
  }
  // A phone's sheet leaves the screen first, so the host never captures it mid-flight.
  const leaveThen = (then: () => void): void => {
    const s = sheet.current
    if (s) s.dismiss(then)
    else then()
  }
  // An answer that went to the server cannot be taken back (§9.30: the secondary sits at .4).
  const cancel = (): void => {
    if (answered.current) return
    leaveThen(() => respond(null))
  }
  const submit = (response: SecurityPromptResponse): void => {
    if (answered.current) return
    if (response.kind === 'http-auth' && prompt.kind === 'http-auth') {
      respond(response)
      onSent(prompt)
    } else {
      leaveThen(() => respond(response))
    }
  }
  // Accepted: the form closes with its values still shown (§9.30), the sheet on its own motion.
  useEffect(() => {
    if (busy === 'done') leaveThen(onGone)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the wait ends
  }, [busy])

  // Escape, and the system back gesture or button on Android, are Cancel; on a phone the gesture
  // pulls the sheet down with the finger first. Desktop focus and the Tab wrap are usePopover's
  // too; on a phone the sheet's own (`active: false` leaves it Escape only).
  useBackSurface({
    name: 'security-prompt',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => (sheet.current ? sheet.current.commitBack() : cancel()),
    onCancel: () => sheet.current?.cancelBack()
  })
  usePopover(dialog, {
    onClose: cancel,
    active: !phone,
    initial: prompt.kind === 'http-auth' ? firstEmptyField : checkedOption,
    returnTo: null
  })
  useFrameDialog({ ownScrim: phone, onScrimPress: phone ? cancel : undefined })

  const parts: FormParts = { titleId, formId, phone, busy, submit, cancel }
  const form =
    prompt.kind === 'http-auth' ? (
      <HttpAuthForm {...parts} prompt={prompt} />
    ) : (
      <CertificateChooser {...parts} prompt={prompt} />
    )

  if (phone) {
    // The sheet's layer is the host slot's own child: the host lets the pointer through to a
    // sheet on its own chassis by that layer (`[data-sheet-layer]`), not to a box around it.
    return (
      <BottomSheet
        ref={sheet}
        hosted
        // Dragged or tapped away: a question still open is declined; a sent answer stands.
        onDismissed={() => (answered.current ? onGone() : respond(null))}
        contentKey={`${prompt.id}|${busy ?? ''}`}
        handleLabel="Dismiss"
        labelledBy={titleId}
        footer={
          prompt.kind === 'http-auth' ? (
            <SignInActions formId={formId} busy={busy !== null} cancel={cancel} />
          ) : (
            <ChooserActions formId={formId} cancel={cancel} />
          )
        }
      >
        {form}
      </BottomSheet>
    )
  }

  // In flow in the host's slot, which centres it over the scrim; 400 wide, a form's width
  // (§9.20), no taller than the frame (a long certificate list scrolls inside it).
  return (
    <div
      ref={dialog}
      className="zen-animate-pop zen-bm-dialog flex max-h-[calc(100%-24px)] max-w-[calc(100%-24px)] flex-col outline-none"
      style={{ width: POPOVER_WIDTH.form }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-surface="page"
      tabIndex={-1}
    >
      {form}
    </div>
  )
}

interface FormParts {
  titleId: string
  formId: string
  phone: boolean
  busy: Busy
  submit: (response: SecurityPromptResponse) => void
  cancel: () => void
}

/**
 * The prompt's title block (§9.23): a 17/600 title at line-height 22 with a row glyph on its
 * start 8 px before it, a 15 px deemphasised description 4 px under it, and 16 px to the form.
 * The chassis draws it – `.zen-bm-title-block` in a dialog, `.zen-sheet-title-block` in a sheet
 * (the glyph 20 there, inside the title's line). `id` names the dialog (`aria-labelledby`).
 */
function Header({
  id,
  icon,
  title,
  phone,
  children
}: {
  id: string
  icon: JSX.Element
  title: string
  phone: boolean
  children: ReactNode
}): JSX.Element {
  if (phone) {
    return (
      <div className="zen-sheet-title-block">
        <h2 id={id}>
          {icon}
          <span className="min-w-0 truncate">{title}</span>
        </h2>
        <p>{children}</p>
      </div>
    )
  }
  return (
    <div className="zen-bm-title-block flex items-start gap-2">
      <span
        className="mt-[calc((var(--v2-line-heading)-var(--v2-icon))/2)] flex shrink-0"
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="zen-bm-title">
          {title}
        </h2>
        <p className="zen-bm-title-desc">{children}</p>
      </div>
    </div>
  )
}

/** An inner box (radius 6, own hairline) carrying a warning in ink only; never a filled surface. */
function Notice({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="flex items-start gap-2 rounded-[var(--v2-radius-inner)] border border-[var(--v2-border)] bg-[var(--v2-page)] px-3 py-2 text-[length:var(--v2-font-small)] leading-[var(--v2-line-small)]">
      <TriangleAlert
        className={cn(
          GLYPH,
          'mt-[calc((var(--v2-line-small)-var(--v2-icon))/2)] text-[var(--v2-warn)]'
        )}
        aria-hidden
      />
      <span>{children}</span>
    </p>
  )
}

/**
 * The body under the title block: the chassis's form body in a dialog (`.zen-bm-form`: 12 px
 * between its parts, 16 to the sides and below, its footer inside it) and, in a sheet, the same
 * parts at the sheet's one 16 px gutter (§9.25), the footer the chassis's own outside the
 * scroller (`footer` of the sheet; the buttons submit this form by its id).
 */
function Body({
  id,
  phone,
  busy,
  onSubmit,
  children
}: {
  id: string
  phone: boolean
  busy: boolean
  onSubmit: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <form
      id={id}
      className={phone ? 'flex flex-col gap-3 px-4' : 'zen-bm-form'}
      aria-busy={busy || undefined}
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) onSubmit()
      }}
    >
      {children}
    </form>
  )
}

/**
 * The sign-in's actions (§9.11): Cancel and Sign in, the primary last. While the credentials
 * are with the server (§9.30) only Sign in is busy – full opacity, a spinner for its label,
 * `aria-busy` – and Cancel sits disabled at .4. On desktop they hug the right edge at an 8 px
 * gap inside the form; on a phone the chassis footer splits the width between them.
 */
function SignInActions({
  formId,
  busy,
  cancel
}: {
  formId: string
  busy: boolean
  cancel: () => void
}): JSX.Element {
  return (
    <>
      <V2Button disabled={busy} onClick={cancel}>
        Cancel
      </V2Button>
      <V2Button type="submit" form={formId} variant="primary" busy={busy}>
        Sign in
      </V2Button>
    </>
  )
}

function ChooserActions({ formId, cancel }: { formId: string; cancel: () => void }): JSX.Element {
  return (
    <>
      <V2Button onClick={cancel}>Cancel</V2Button>
      <V2Button type="submit" form={formId} variant="primary">
        Use certificate
      </V2Button>
    </>
  )
}

/**
 * The site's standing answer to remember the credentials: a checkbox on desktop (the shared
 * `.zen-v2-checkbox`, on its own row – v2 buttons are 96 wide at the least and a label beside
 * them would wrap), a switch row on a phone (§10.4: checkboxes are desktop only), the row
 * running edge to edge with its text at the gutter. Read-only with the form (§9.30): the
 * control keeps its value at full opacity and does not toggle.
 */
function RememberControl({
  phone,
  checked,
  readOnly,
  onChange
}: {
  phone: boolean
  checked: boolean
  readOnly: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  const label = 'Remember until Zenium quits'
  if (phone) {
    return (
      // The row takes the form's gutter back: it carries its own 16 and runs edge to edge.
      <div className="-mx-4">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-disabled={readOnly || undefined}
          className="zen-v2-row"
          onClick={() => !readOnly && onChange(!checked)}
        >
          <span className="min-w-0 flex-1">{label}</span>
          <span className="zen-v2-switch" aria-hidden />
        </button>
      </div>
    )
  }
  return (
    <label className="flex min-w-0 cursor-default items-start gap-2.5 text-[length:var(--v2-font-body)] leading-[var(--v2-line-body)]">
      <input
        type="checkbox"
        className="zen-v2-checkbox"
        checked={checked}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        onChange={(e) => !readOnly && onChange(e.target.checked)}
      />
      <span className="min-w-0">{label}</span>
    </label>
  )
}

/**
 * The sign-in form: username and password (§9.12 fields, label above, `<label for>`), the
 * remember control, the actions. A refused answer comes back as a new prompt with its username
 * filled in: the password clears, takes the focus (on a phone the keyboard comes up and the
 * chassis lifts the sheet) and shows its validation line (§9.12, §9.30) – no second notice box.
 * While the answer is with the server the fields are read-only with the typed values in place,
 * the password masked (§9.30).
 */
function HttpAuthForm({
  prompt,
  titleId,
  formId,
  phone,
  busy,
  submit,
  cancel
}: FormParts & { prompt: HttpAuthPrompt }): JSX.Element {
  const [username, setUsername] = useState(prompt.username)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const passwordField = useRef<HTMLInputElement>(null)
  const sending = busy !== null

  // The refusal: the same dialog, the next prompt (a new id, `failedBefore`) – the password
  // clears and, once the form has drawn it empty, takes the focus.
  const [seenId, setSeenId] = useState(prompt.id)
  const [refusedId, setRefusedId] = useState<string | null>(null)
  if (prompt.id !== seenId) {
    setSeenId(prompt.id)
    if (prompt.failedBefore) {
      setRefusedId(prompt.id)
      setPassword('')
      if (!username) setUsername(prompt.username)
    }
  }
  useEffect(() => {
    if (refusedId) passwordField.current?.focus({ preventScroll: true })
  }, [refusedId])

  const defaultPort = prompt.isProxy ? false : prompt.port === (prompt.secure ? 443 : 80)
  const where = defaultPort || prompt.port <= 0 ? prompt.host : `${prompt.host}:${prompt.port}`
  const scheme = SCHEME_NAMES[prompt.scheme]
  const insecure = !prompt.isProxy && !prompt.secure && prompt.scheme !== 'digest'
  const refused = prompt.failedBefore && !sending

  return (
    <>
      <Header
        id={titleId}
        icon={<KeyRound className={GLYPH} aria-hidden />}
        title={prompt.isProxy ? 'Proxy sign-in' : 'Sign in'}
        phone={phone}
      >
        {prompt.isProxy
          ? `The proxy ${where} asks for a username and password before it forwards your traffic.`
          : prompt.realm
            ? `${where} asks for a username and password. The site says: “${prompt.realm}”.`
            : `${where} asks for a username and password.`}
        {scheme && ` ${scheme} authentication.`}
      </Header>
      <Body
        id={formId}
        phone={phone}
        busy={sending}
        onSubmit={() => submit({ kind: 'http-auth', username, password, remember })}
      >
        {insecure && (
          <Notice>
            Your connection to this site is not private. The password travels unencrypted.
          </Notice>
        )}
        <V2FormField id={`${formId}-username`} label="Username">
          {(field) => (
            <V2Field
              {...field}
              value={username}
              readOnly={sending}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          )}
        </V2FormField>
        <V2FormField
          id={`${formId}-password`}
          label="Password"
          error={refused ? REFUSED : undefined}
        >
          {(field) => (
            <V2Field
              {...field}
              ref={passwordField}
              type="password"
              value={password}
              readOnly={sending}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          )}
        </V2FormField>
        <RememberControl
          phone={phone}
          checked={remember}
          readOnly={sending}
          onChange={setRemember}
        />
        {!phone && (
          <div className="zen-bm-footer justify-end">
            <SignInActions formId={formId} busy={sending} cancel={cancel} />
          </div>
        )}
      </Body>
    </>
  )
}

/**
 * One certificate as a plain radio row (§9.14, §9.34): the shared `.zen-v2-row` – the whole row
 * the target, edge to edge with its text at the gutter – with the shared `.zen-v2-radio` on the
 * subject's line (§9.2), the issuer and validity 13 px deemphasised under it. The rows are a
 * radio group with one tab stop – the checked row – and the arrow keys move the choice.
 */
function CertificateRow({
  label,
  description,
  checked,
  onSelect
}: {
  label: string
  description: ReactNode
  checked: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      className="zen-v2-row"
      onClick={onSelect}
      onFocus={onSelect}
    >
      <span className="zen-v2-radio" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate">{label}</span>
        <span className="min-w-0 text-[length:var(--v2-font-small)] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]">
          {description}
        </span>
      </span>
    </button>
  )
}

function CertificateChooser({
  prompt,
  titleId,
  formId,
  phone,
  submit,
  cancel
}: FormParts & { prompt: ClientCertificatePrompt }): JSX.Element {
  const [index, setIndex] = useState(0)
  // Validity is judged once, when the chooser opens.
  const [now] = useState(() => Date.now())
  const group = useRef<HTMLDivElement>(null)
  useArrowKeys(group, '[role="radio"]')
  return (
    <>
      <Header
        id={titleId}
        icon={<BadgeCheck className={GLYPH} aria-hidden />}
        title="Select a certificate"
        phone={phone}
      >
        {prompt.host} wants a certificate to identify you. Zenium never sends one without asking;
        your choice holds for this site until you quit.
      </Header>
      <Body
        id={formId}
        phone={phone}
        busy={false}
        onSubmit={() => submit({ kind: 'client-certificate', index })}
      >
        {/* The rows take the form's gutter back (they carry their own 16) and their own row pad. */}
        <div
          ref={group}
          role="radiogroup"
          aria-labelledby={titleId}
          className="-mx-4 -my-[var(--v2-row-pad)] flex min-h-0 flex-col overflow-y-auto"
        >
          {prompt.certificates.map((cert, i) => {
            const expired = cert.validTo < now
            return (
              <CertificateRow
                key={cert.fingerprint}
                checked={i === index}
                onSelect={() => setIndex(i)}
                label={cert.subject || cert.serialNumber}
                description={
                  <>
                    Issued by {cert.issuer || 'an unknown authority'}
                    {' · '}
                    {expired ? (
                      <span className="text-[var(--v2-warn)]">Expired </span>
                    ) : (
                      'Valid until '
                    )}
                    {new Date(cert.validTo).toLocaleDateString()}
                  </>
                }
              />
            )
          })}
        </div>
        {!phone && (
          <div className="zen-bm-footer justify-end">
            <ChooserActions formId={formId} cancel={cancel} />
          </div>
        )}
      </Body>
    </>
  )
}
