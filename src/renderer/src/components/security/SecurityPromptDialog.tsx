import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
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
import { ChromePortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import {
  closeSecurityPrompt,
  currentSecurityPrompt,
  openSecurityPrompt
} from '@renderer/lib/security'
import { cn } from '@renderer/lib/utils'
import { useFocusReach } from '@renderer/hooks/useFocusReach'
import { useEscapeTrap } from '../bookmarks/escape'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { V2_GLYPH, V2Button, V2Checkbox, V2Field, V2Radio } from '../v2/controls'

const SCHEME_NAMES: Record<string, string> = {
  basic: 'Basic',
  digest: 'Digest',
  ntlm: 'NTLM',
  negotiate: 'Negotiate'
}

const REFUSED = 'The username or password was not accepted. Please try again.'

type Respond = (response: SecurityPromptResponse | null) => void

/**
 * HTTP authentication and client-certificate prompts, one at a time, tab-modal: a prompt waits
 * until its tab is the active one. Answers go back to the core, which resumes the request and
 * drops the prompt; the dialog goes with it.
 */
export function SecurityPrompts({ state }: { state: UIState }): JSX.Element | null {
  const prompt = currentSecurityPrompt(state)
  if (!prompt) return null
  return <SecurityPromptDialog key={prompt.id} prompt={prompt} />
}

/**
 * One prompt, one composition on both platforms (§9.23): a title block – glyph, 17/600 title,
 * the description 4 under it – over the form and a §9.11 footer. On desktop a v2 dialog (§2,
 * §3, §9.5) placed through TabDialogs' `FrameDialogHost`, which centres it in the content frame
 * over the scrim that dims only the frame and holds the window chrome inert; the scrim does not
 * answer it (only the buttons and Escape do), and it comes up on the 180 ms pop. Focus moves
 * into the form on open and Tab wraps inside it (§9.22); the page, which raised the prompt, gets
 * the keyboard back when the dialog goes. On a phone the shared bottom sheet, through the chrome
 * layer, whose grip strip, surface, title block and footer are the chassis's; the sheet leaves
 * first and the answer goes once it is gone, and pulling it away, the scrim, back and Escape
 * are Cancel.
 */
function SecurityPromptDialog({ prompt }: { prompt: SecurityPrompt }): JSX.Element {
  const phone = viewportStore.use((s) => s.formFactor === 'phone')
  const answered = useRef(false)
  const sheet = useRef<BottomSheetHandle>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useFocusReach(dialog)

  // The page's views hide under chrome overlays; its snapshot stands in while the dialog is up.
  // (An open still waiting for the snapshot when the dialog is closed, or opened again, gives way.)
  useEffect(() => {
    void openSecurityPrompt(prompt.tabId)
    return closeSecurityPrompt
  }, [prompt.tabId])

  const respond: Respond = (response) => {
    if (answered.current) return
    answered.current = true
    run('security.respond', { id: prompt.id, response })
  }
  // A phone's sheet leaves the screen first, so the host never captures it mid-flight.
  const answer: Respond = (response) => {
    const s = sheet.current
    if (s) s.dismiss(() => respond(response))
    else respond(response)
  }
  const cancel = (): void => answer(null)

  // Escape, and the system back gesture or button on Android, are Cancel; on a phone the gesture
  // pulls the sheet down with the finger first.
  useBackSurface({
    name: 'security-prompt',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => (sheet.current ? sheet.current.commitBack() : cancel()),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscapeTrap(true, cancel)
  useFrameDialog({ active: !phone })

  const form =
    prompt.kind === 'http-auth' ? (
      <HttpAuthForm prompt={prompt} respond={answer} phone={phone} />
    ) : (
      <CertificateChooser prompt={prompt} respond={answer} phone={phone} />
    )

  if (phone) {
    return (
      <ChromePortal>
        <BottomSheet
          ref={sheet}
          onDismissed={() => respond(null)}
          contentKey={prompt.id}
          handleLabel="Dismiss"
        >
          <div ref={dialog} className="contents">
            {form}
          </div>
        </BottomSheet>
      </ChromePortal>
    )
  }

  // In flow in the host's slot, which centres it over the scrim; 400 wide, a form's width
  // (§9.20). A page surface (§9.29): its fields, buttons and radios draw in the page family.
  return (
    <div
      ref={dialog}
      className="zen-animate-pop zen-bm-dialog flex max-w-[calc(100%-24px)] flex-col outline-none"
      style={{ width: POPOVER_WIDTH.form }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${prompt.id}-title`}
      data-surface="page"
      tabIndex={-1}
    >
      {form}
    </div>
  )
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
      <span className="mt-[calc((22px-var(--v2-icon))/2)] flex shrink-0" aria-hidden>
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
    <p className="flex items-start gap-2 rounded-[var(--v2-radius-inner)] border border-[var(--v2-border)] bg-[var(--v2-page)] px-3 py-2 text-[13px] leading-5">
      <TriangleAlert className={cn(V2_GLYPH, 'text-[var(--v2-warn)]')} aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/**
 * The body under the title block: the chassis's form body in a dialog (`.zen-bm-form`: 12 px
 * between its parts, 16 to the sides and below) and, in a sheet, the same parts at the sheet's
 * one 16 px gutter (§9.25) with the footer the chassis's own.
 */
function Body({
  phone,
  onSubmit,
  children
}: {
  phone: boolean
  onSubmit: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <form
      className={phone ? 'flex flex-col gap-3 px-4' : 'zen-bm-form'}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      {children}
    </form>
  )
}

/**
 * Dialog actions (§9.11): on desktop they hug and sit to the right at 32 tall with an 8 px gap,
 * primary last; on a phone the chassis footer (`.zen-sheet-footer`) splits the width between two
 * peers, primary on the trailing side, its own 16 the whole distance from the form's last part
 * (the form's 12 px gap is taken back) and its buttons at the sheet's 16 gutter.
 */
function Actions({ phone, children }: { phone: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className={phone ? 'zen-sheet-footer -mx-4 -mt-3' : 'zen-bm-footer justify-end'}>
      {children}
    </div>
  )
}

/**
 * A form field with its label above it (§9.12): 15/400, 4 px to the field, `<label for>`; an
 * `error` is the field's validation line, 13/20 in danger ink with a row glyph, right under it.
 */
function Field({
  id,
  label,
  error,
  children
}: {
  id: string
  label: string
  error?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[15px] leading-5">
        {label}
      </label>
      {children}
      {error && (
        <p
          id={`${id}-error`}
          className="flex items-start gap-2 text-[13px] leading-5 text-[var(--v2-danger)]"
        >
          <TriangleAlert
            className={cn(V2_GLYPH, 'mt-[calc((var(--v2-line-body)-var(--v2-icon))/2)]')}
            aria-hidden
          />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

function HttpAuthForm({
  prompt,
  respond,
  phone
}: {
  prompt: HttpAuthPrompt
  respond: Respond
  phone: boolean
}): JSX.Element {
  const [username, setUsername] = useState(prompt.username)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  // A refused answer comes back with its username filled in: only the password needs retyping.
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    first.current?.focus()
  }, [])

  const defaultPort = prompt.isProxy ? false : prompt.port === (prompt.secure ? 443 : 80)
  const where = defaultPort || prompt.port <= 0 ? prompt.host : `${prompt.host}:${prompt.port}`
  const scheme = SCHEME_NAMES[prompt.scheme]
  const insecure = !prompt.isProxy && !prompt.secure && prompt.scheme !== 'digest'

  return (
    <>
      <Header
        id={`${prompt.id}-title`}
        icon={<KeyRound className={V2_GLYPH} aria-hidden />}
        title={prompt.isProxy ? 'Proxy Sign-In' : 'Sign In'}
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
        phone={phone}
        onSubmit={() => respond({ kind: 'http-auth', username, password, remember })}
      >
        {insecure && (
          <Notice>
            Your connection to this site is not private. The password travels unencrypted.
          </Notice>
        )}
        <Field id={`${prompt.id}-username`} label="Username">
          <V2Field
            id={`${prompt.id}-username`}
            ref={prompt.username ? undefined : first}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
        </Field>
        {/* A refused answer is the password's validation line (§9.12), not another notice box. */}
        <Field
          id={`${prompt.id}-password`}
          label="Password"
          error={prompt.failedBefore ? REFUSED : undefined}
        >
          <V2Field
            id={`${prompt.id}-password`}
            ref={prompt.username ? first : undefined}
            type="password"
            secret
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-invalid={prompt.failedBefore || undefined}
            aria-describedby={prompt.failedBefore ? `${prompt.id}-password-error` : undefined}
          />
        </Field>
        {/* The checkbox has a row of its own, as in Firefox's dialog: the buttons are 96 px wide at
            the least (v2 button rule) and a label beside them would wrap. On a phone the row is a
            44 px target with the box centred on it. */}
        <V2Checkbox
          className={cn(phone && 'min-h-[var(--v2-row)] items-center')}
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          label="Remember until Zenium quits"
        />
        <Actions phone={phone}>
          <V2Button onClick={() => respond(null)}>Cancel</V2Button>
          <V2Button type="submit" variant="primary">
            Sign in
          </V2Button>
        </Actions>
      </Body>
    </>
  )
}

function CertificateChooser({
  prompt,
  respond,
  phone
}: {
  prompt: ClientCertificatePrompt
  respond: Respond
  phone: boolean
}): JSX.Element {
  const [index, setIndex] = useState(0)
  // Validity is judged once, when the chooser opens.
  const [now] = useState(() => Date.now())
  const group = `${prompt.id}-certificate`
  return (
    <>
      <Header
        id={`${prompt.id}-title`}
        icon={<BadgeCheck className={V2_GLYPH} aria-hidden />}
        title="Select a Certificate"
        phone={phone}
      >
        {prompt.host} wants a certificate to identify you. Zenium never sends one without asking;
        your choice holds for this site until you quit.
      </Header>
      <Body phone={phone} onSubmit={() => respond({ kind: 'client-certificate', index })}>
        {/* Plain radios (§9.14): two-line rows, the circle on the subject's line, no card. */}
        <div className="-my-1 flex max-h-[320px] flex-col overflow-y-auto" role="radiogroup">
          {prompt.certificates.map((cert, i) => {
            const expired = cert.validTo < now
            return (
              <V2Radio
                key={cert.fingerprint}
                name={group}
                checked={i === index}
                onChange={() => setIndex(i)}
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
        <Actions phone={phone}>
          <V2Button onClick={() => respond(null)}>Cancel</V2Button>
          <V2Button type="submit" variant="primary">
            Use certificate
          </V2Button>
        </Actions>
      </Body>
    </>
  )
}
