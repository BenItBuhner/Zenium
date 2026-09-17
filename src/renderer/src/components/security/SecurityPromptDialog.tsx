import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, KeyRound, ShieldAlert } from 'lucide-react'
import type {
  ClientCertificatePrompt,
  HttpAuthPrompt,
  SecurityPrompt,
  SecurityPromptResponse,
  UIState
} from '@shared/types'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import {
  closeSecurityPrompt,
  currentSecurityPrompt,
  openSecurityPrompt
} from '@renderer/lib/security'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'

const SCHEME_NAMES: Record<string, string> = {
  basic: 'Basic',
  digest: 'Digest',
  ntlm: 'NTLM',
  negotiate: 'Negotiate'
}

/**
 * HTTP authentication and client-certificate prompts, one at a time, tab-modal: a prompt waits
 * until its tab is the active one. Answers go back to the core, which resumes the request.
 */
export function SecurityPrompts({ state }: { state: UIState }): JSX.Element | null {
  const prompt = currentSecurityPrompt(state)
  if (!prompt) return null
  return <SecurityPromptDialog key={prompt.id} prompt={prompt} />
}

function SecurityPromptDialog({ prompt }: { prompt: SecurityPrompt }): JSX.Element {
  const answered = useRef(false)

  // The page's views hide under chrome overlays; its snapshot stands in while the dialog is up.
  useEffect(() => {
    let gone = false
    void openSecurityPrompt(prompt.tabId).then(() => {
      if (gone) closeSecurityPrompt()
    })
    return () => {
      gone = true
      closeSecurityPrompt()
    }
  }, [prompt.tabId])

  const respond = (response: SecurityPromptResponse | null): void => {
    if (answered.current) return
    answered.current = true
    run('security.respond', { id: prompt.id, response })
  }

  // Escape, and the system back gesture or button on Android, are Cancel.
  useBackSurface({ name: 'security-prompt', onCommit: () => respond(null) })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      respond(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center" role="presentation">
      <div
        className={cn(
          'zen-panel zen-animate-pop w-[440px] max-w-[calc(100%-32px)] overflow-hidden'
        )}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {prompt.kind === 'http-auth' ? (
          <HttpAuthForm prompt={prompt} respond={respond} />
        ) : (
          <CertificateChooser prompt={prompt} respond={respond} />
        )}
      </div>
    </div>
  )
}

function HttpAuthForm({
  prompt,
  respond
}: {
  prompt: HttpAuthPrompt
  respond: (response: SecurityPromptResponse | null) => void
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
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault()
        respond({ kind: 'http-auth', username, password, remember })
      }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--zen-element-bg)]">
          <KeyRound className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">
            {prompt.isProxy ? 'The proxy needs you to sign in' : `Sign in to ${where}`}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-[var(--zen-muted)]">
            {prompt.isProxy
              ? `${where} asks for a username and password before it forwards your traffic.`
              : prompt.realm
                ? `The site says: “${prompt.realm}”`
                : 'This site asks for a username and password.'}
            {scheme && (
              <span className="ml-1.5 rounded-md bg-[var(--zen-element-bg)] px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide">
                {scheme}
              </span>
            )}
          </p>
        </div>
      </div>
      {(prompt.failedBefore || insecure) && (
        <div className="flex flex-col gap-1.5">
          {prompt.failedBefore && (
            <p className="flex items-start gap-2 rounded-xl bg-[var(--zen-element-bg)] px-3 py-2 text-[12.5px]">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>The username or password was not accepted. Please try again.</span>
            </p>
          )}
          {insecure && (
            <p className="flex items-start gap-2 rounded-xl bg-[var(--zen-element-bg)] px-3 py-2 text-[12.5px]">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>
                Your connection to this site is not private. The password travels unencrypted.
              </span>
            </p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--zen-muted)]">
          Username
          <Input
            ref={prompt.username ? undefined : first}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
            className="h-9 text-[var(--zen-fg)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--zen-muted)]">
          Password
          <Input
            ref={prompt.username ? first : undefined}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="h-9 text-[var(--zen-fg)]"
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-[12.5px]">
          <Switch checked={remember} onCheckedChange={setRemember} />
          <span className="truncate">Remember until Zenium quits</span>
        </label>
        <Button type="button" variant="secondary" onClick={() => respond(null)}>
          Cancel
        </Button>
        <Button type="submit">Sign in</Button>
      </div>
    </form>
  )
}

function CertificateChooser({
  prompt,
  respond
}: {
  prompt: ClientCertificatePrompt
  respond: (response: SecurityPromptResponse | null) => void
}): JSX.Element {
  const [index, setIndex] = useState(0)
  // Validity is judged once, when the chooser opens.
  const [now] = useState(() => Date.now())
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--zen-element-bg)]">
          <BadgeCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">Select a certificate</h2>
          <p className="mt-0.5 text-[12.5px] text-[var(--zen-muted)]">
            {prompt.host} wants a certificate to identify you. Zenium never sends one without
            asking; your choice holds for this site until you quit.
          </p>
        </div>
      </div>
      <ul className="flex max-h-[260px] flex-col gap-1 overflow-y-auto" role="radiogroup">
        {prompt.certificates.map((cert, i) => {
          const expired = cert.validTo < now
          return (
            <li key={cert.fingerprint}>
              <button
                type="button"
                role="radio"
                aria-checked={i === index}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-2 text-left',
                  i === index
                    ? 'bg-[var(--zen-element-bg-active)] ring-1 ring-[var(--zen-accent)]/50'
                    : 'hover:bg-[var(--zen-element-bg)]'
                )}
                onClick={() => setIndex(i)}
                onDoubleClick={() => respond({ kind: 'client-certificate', index: i })}
              >
                <span className="text-[13px] font-medium">{cert.subject || cert.serialNumber}</span>
                <span className="text-[11.5px] text-[var(--zen-muted)]">
                  Issued by {cert.issuer || 'an unknown authority'}
                  {' · '}
                  {expired ? 'Expired ' : 'Valid until '}
                  {new Date(cert.validTo).toLocaleDateString()}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => respond(null)}>
          Continue without one
        </Button>
        <Button onClick={() => respond({ kind: 'client-certificate', index })}>
          Use certificate
        </Button>
      </div>
    </div>
  )
}
