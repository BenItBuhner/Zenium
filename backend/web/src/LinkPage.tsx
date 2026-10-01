import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { api } from '../../convex/_generated/api'
import { describeError } from './errors'

const KIND_LABEL = {
  desktop: 'Desktop',
  laptop: 'Laptop',
  phone: 'Phone',
  tablet: 'Tablet'
} as const

function codeFromUrl(): string {
  return new URLSearchParams(window.location.search).get('code')?.trim().toUpperCase() ?? ''
}

export function LinkPage() {
  const [code, setCode] = useState(codeFromUrl)
  const [draft, setDraft] = useState(code)

  if (!code)
    return (
      <section className="card">
        <h1>Link a device</h1>
        <p className="muted">Enter the code Zenium shows in Settings.</p>
        <form
          className="code-form"
          onSubmit={(e) => {
            e.preventDefault()
            setCode(draft.trim().toUpperCase())
          }}
        >
          <input
            className="code-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
            placeholder="ABCD-EFGH"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-label="Code"
          />
          <button className="primary" type="submit" disabled={draft.trim().length < 8}>
            Continue
          </button>
        </form>
      </section>
    )
  return (
    <Confirm
      code={code}
      onReset={() => {
        setCode('')
        setDraft('')
      }}
    />
  )
}

function Confirm({ code, onReset }: { code: string; onReset: () => void }) {
  const link = useQuery(api.links.describe, { userCode: code })
  const approve = useMutation(api.links.approve)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (link === undefined) return <p className="muted centre">Loading…</p>

  if (link === null)
    return (
      <section className="card">
        <h1>Code not found</h1>
        <p className="muted">
          <span className="code">{code}</span> isn’t a valid code. It may have expired, or been
          typed wrongly.
        </p>
        <button className="secondary" onClick={onReset}>
          Enter another code
        </button>
      </section>
    )

  if (link.approvedHere)
    return (
      <section className="card">
        <div className="tick" aria-hidden="true" />
        <h1>{link.deviceName} is linked</h1>
        <p className="muted">Return to Zenium to finish setting up sync. You can close this tab.</p>
        <a className="secondary" href="/">
          Manage your devices
        </a>
      </section>
    )

  return (
    <section className="card">
      <h1>Link this device?</h1>
      <p className="muted">Only continue if you started signing in on this device just now.</p>
      <div className="device-preview">
        <span className={`device-icon ${link.kind}`} aria-hidden="true" />
        <div>
          <div className="device-name">{link.deviceName}</div>
          <div className="muted small">{KIND_LABEL[link.kind]}</div>
        </div>
        <span className="code">{code}</span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            approve({ userCode: code })
              .catch((e: unknown) => {
                setError(describeError(e))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          {busy ? 'Linking…' : 'Link device'}
        </button>
        <button className="secondary" disabled={busy} onClick={onReset}>
          Not now
        </button>
      </div>
    </section>
  )
}
