import type { JSX } from 'react'
import { useState } from 'react'
import { Dices, Eye, EyeOff } from 'lucide-react'
import type { CredentialSummary } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { Generator } from './Generator'
import { domainFromInput, usePhone } from './lib'
import { Btn, Field, IconBtn, TextArea, TextField } from './shared'

export interface LoginFormValues {
  url: string
  username: string
  password: string
  notes: string
}

/**
 * Add or edit a login. When editing, the password field starts empty and only a typed or
 * generated value replaces the stored one (the form never holds the current secret).
 */
export function LoginForm({
  existing,
  onSubmit,
  onCancel
}: {
  existing?: CredentialSummary
  onSubmit: (values: LoginFormValues) => void
  onCancel: () => void
}): JSX.Element {
  const phone = usePhone()
  const [url, setUrl] = useState(existing?.url || existing?.origin || '')
  const [username, setUsername] = useState(existing?.username ?? '')
  const [password, setPassword] = useState('')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [show, setShow] = useState(false)
  const [generating, setGenerating] = useState(false)
  const domain = domainFromInput(url)
  const ready = url.trim().length > 0 && (existing ? true : password.length > 0)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit({ url: url.trim(), username: username.trim(), password, notes })
      }}
    >
      <Field label="Site" htmlFor="login-url">
        <TextField
          id="login-url"
          autoFocus={!existing && !phone}
          placeholder="https://example.com/login"
          value={url}
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field label="Username" htmlFor="login-username">
        <TextField
          id="login-username"
          placeholder="name@example.com"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          onChange={(e) => setUsername(e.target.value)}
        />
      </Field>
      <Field label="Password" htmlFor="login-password">
        <div className="flex items-center gap-1">
          <TextField
            id="login-password"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={existing ? 'Leave empty to keep the current one' : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={cn(show && 'zen-v2-pw-secret')}
          />
          <IconBtn label={show ? 'Hide' : 'Show'} onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff /> : <Eye />}
          </IconBtn>
          <IconBtn
            label="Generate a strong password"
            active={generating}
            onClick={() => setGenerating((g) => !g)}
          >
            <Dices />
          </IconBtn>
        </div>
        {generating && (
          <Generator
            domain={domain}
            className="zen-v2-pw-card mt-2"
            onUse={(value) => {
              setPassword(value)
              setShow(true)
              setGenerating(false)
            }}
          />
        )}
      </Field>
      <Field label="Notes" htmlFor="login-notes">
        <TextArea
          id="login-notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <div className={cn('flex gap-2 pt-2', phone ? 'flex-col-reverse' : 'justify-end')}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" variant="primary" disabled={!ready}>
          {existing ? 'Save changes' : 'Save login'}
        </Btn>
      </div>
    </form>
  )
}
