import type { JSX } from 'react'
import { useState } from 'react'
import { Dices, Eye, EyeOff } from 'lucide-react'
import { NOTE_MAX_LENGTH, type CredentialSummary } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { Generator } from './Generator'
import { domainFromInput, noteCounter, noteOverLimit, usePhone } from './lib'
import { Btn, Field, FormActions, IconBtn, TextArea, TextField } from './shared'

export interface LoginFormValues {
  url: string
  username: string
  password: string
  notes: string
}

/**
 * Add or edit a login: §9.12 form fields 16 apart, the password field with its Show and Generate
 * icon buttons beside it on both form factors, the generator unfolding under it – in a card on
 * the desktop (§6), as plain rows on a phone (§9.17: no new phone cards) – and the §9.11 actions
 * last. When editing, the password field starts empty and only a typed or generated value
 * replaces the stored one (the form never holds the current secret). The note (ID-34) clips at
 * Chrome's `NOTE_MAX_LENGTH`: a counter comes up under the field as it nears the limit, and a
 * longer note that arrived by sync shows §9.12's validation and holds Save until it fits.
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
  const noteError = noteOverLimit(notes.length)
  const ready =
    url.trim().length > 0 && (existing ? true : password.length > 0) && noteError === null
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit({ url: url.trim(), username: username.trim(), password, notes })
      }}
    >
      <Field id="login-url" label="Site">
        {(aria) => (
          <TextField
            {...aria}
            autoFocus={!existing && !phone}
            placeholder="https://example.com/login"
            value={url}
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="url"
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
      </Field>
      <Field id="login-username" label="Username">
        {(aria) => (
          <TextField
            {...aria}
            placeholder="name@example.com"
            value={username}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
        )}
      </Field>
      <Field id="login-password" label="Password">
        {(aria) => (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <TextField
              {...aria}
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
              pressed={generating}
              onClick={() => setGenerating((g) => !g)}
            >
              <Dices />
            </IconBtn>
          </span>
        )}
      </Field>
      {generating && (
        <Generator
          domain={domain}
          className={cn('zen-animate-fade', !phone && 'zen-v2-pw-card')}
          onUse={(value) => {
            setPassword(value)
            setShow(true)
            setGenerating(false)
          }}
        />
      )}
      <Field
        id="login-notes"
        label="Notes"
        description={noteCounter(notes.length)}
        error={noteError}
      >
        {(aria) => (
          <TextArea
            {...aria}
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>
      <FormActions className="pt-2">
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" variant="primary" disabled={!ready}>
          {existing ? 'Save changes' : 'Save login'}
        </Btn>
      </FormActions>
    </form>
  )
}
