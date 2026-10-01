import { useClerk } from '@clerk/clerk-react'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { MAX_BYTES } from '../../convex/lib/limits'
import { describeError } from './errors'

const METHOD_LABEL: Record<string, string> = {
  email: 'Email',
  password: 'Password',
  oauth_google: 'Google'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' })

function lastSeen(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60_000)
  if (minutes > -2) return 'Active now'
  if (minutes > -60) return `Active ${relative.format(minutes, 'minute')}`
  const hours = Math.round(minutes / 60)
  if (hours > -24) return `Active ${relative.format(hours, 'hour')}`
  return `Active ${relative.format(Math.round(hours / 24), 'day')}`
}

export function HomePage() {
  const me = useQuery(api.account.me)
  const devices = useQuery(api.devices.list)
  if (me === undefined || devices === undefined) return <p className="muted centre">Loading…</p>
  if (me === null) return <p className="error">This account is being deleted.</p>
  const usedShare = Math.min(100, (me.bytesUsed / MAX_BYTES) * 100)

  return (
    <>
      <section className="card">
        <h1>Your account</h1>
        <dl className="facts">
          <dt>Email</dt>
          <dd>{me.email}</dd>
          <dt>Sign-in</dt>
          <dd>
            {me.authMethods.length
              ? me.authMethods.map((m) => METHOD_LABEL[m] ?? m).join(', ')
              : 'Email'}
          </dd>
          <dt>Synced data</dt>
          <dd>
            <div
              className="meter"
              role="progressbar"
              aria-valuenow={Math.round(usedShare)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${Math.max(usedShare, 1)}%` }} />
            </div>
            <span className="muted small">
              {formatBytes(me.bytesUsed)} of {formatBytes(MAX_BYTES)}
            </span>
          </dd>
        </dl>
      </section>

      <section className="card">
        <h2>Devices</h2>
        {devices.length === 0 ? (
          <p className="muted">
            No devices yet. In Zenium, open Settings, then Sync, and choose Zenium account.
          </p>
        ) : (
          <ul className="devices">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                id={d.id}
                name={d.name}
                kind={d.kind}
                lastSeenAt={d.lastSeenAt}
              />
            ))}
          </ul>
        )}
      </section>

      <DangerZone />
    </>
  )
}

function DeviceRow(props: {
  id: Id<'deviceSessions'>
  name: string
  kind: string
  lastSeenAt: number
}) {
  const revoke = useMutation(api.devices.revoke)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <li className="device">
      <span className={`device-icon ${props.kind}`} aria-hidden="true" />
      <div className="device-text">
        <div className="device-name">{props.name}</div>
        <div className="muted small">{lastSeen(props.lastSeenAt)}</div>
        {error && <div className="error small">{error}</div>}
      </div>
      <button
        className="secondary small"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          revoke({ sessionId: props.id })
            .catch((e: unknown) => {
              setError(describeError(e))
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        Sign out
      </button>
    </li>
  )
}

function DangerZone() {
  const deleteAccount = useAction(api.account.deleteAccount)
  const { signOut } = useClerk()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <section className="card danger">
      <h2>Delete account</h2>
      <p className="muted">
        Signs out every device and erases your synced data from our servers. Data on your devices
        stays.
      </p>
      {!open ? (
        <button
          className="danger-button"
          onClick={() => {
            setOpen(true)
          }}
        >
          Delete account…
        </button>
      ) : (
        <div className="confirm">
          <label htmlFor="confirm-delete">
            Type <strong>delete</strong> to confirm
          </label>
          <input
            id="confirm-delete"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value)
            }}
            autoComplete="off"
          />
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button
              className="danger-button"
              disabled={typed.trim().toLowerCase() !== 'delete' || busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                deleteAccount({})
                  .then(() => signOut({ redirectUrl: '/' }))
                  .catch((e: unknown) => {
                    setError(describeError(e))
                    setBusy(false)
                  })
              }}
            >
              {busy ? 'Deleting…' : 'Delete for good'}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                setTyped('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
