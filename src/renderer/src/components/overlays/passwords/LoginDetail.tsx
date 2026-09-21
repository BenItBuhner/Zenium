import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Copy, Eye, EyeOff, ExternalLink, Pencil, Trash2 } from 'lucide-react'
import type { CredentialSummary, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { pushToast } from '@renderer/lib/ui'
import {
  DOT_MASK,
  formatDate,
  openSite,
  relativeTimeInSentence,
  usePhone,
  useScrolled
} from './lib'
import { LoginForm } from './LoginForm'
import { PaneHeader } from './PageShell'
import {
  ActionRow,
  Btn,
  Description,
  ErrorNote,
  IconBtn,
  PromptSheet,
  type PromptSheetHandle,
  Rows,
  Secret,
  SiteIcon,
  Title
} from './shared'
import type { Gate } from './useReauth'

/** How long a revealed password stays on screen before it is masked again. */
const REVEAL_MS = 30_000

/**
 * One saved login as a pushed pane. Mounted with a key of the entry's id and `updatedAt`, so a
 * different entry or an edit that may have changed the password starts masked again. Deleting
 * asks first: inline under the header on the desktop, in a confirmation sheet on a phone
 * (§10.4: a destructive action is never an inline button there).
 */
export function LoginDetail({
  state,
  credential,
  gate,
  onBack,
  onChanged,
  onRemoved
}: {
  state: UIState
  credential: CredentialSummary
  gate: Gate
  onBack: () => void
  onChanged: (updated: CredentialSummary) => void
  onRemoved: (id: string) => void
}): JSX.Element {
  const phone = usePhone()
  const [revealed, setRevealed] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { scrolled, onScroll } = useScrolled()

  useEffect(() => {
    if (revealed === null) return
    const timer = setTimeout(() => setRevealed(null), REVEAL_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  const reveal = async (): Promise<void> => {
    if (revealed !== null) {
      setRevealed(null)
      return
    }
    const value = await gate(`Show the password for ${credential.domain}`, (passphrase) =>
      cmd('passwords.reveal', { id: credential.id, passphrase })
    )
    if (value !== null) setRevealed(value)
  }

  const copy = (field: 'username' | 'password'): void => {
    void gate(`Copy the password for ${credential.domain}`, (passphrase) =>
      cmd('passwords.copy', { id: credential.id, field, passphrase })
    )
  }

  const remove = (): void => {
    run('passwords.remove', { id: credential.id })
    onRemoved(credential.id)
  }

  return (
    <>
      <PaneHeader
        onBack={onBack}
        scrolled={scrolled}
        title={
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <SiteIcon domain={credential.domain} favicon={credential.favicon} size="hero" />
            <span className="flex min-w-0 flex-1 flex-col">
              <Title>{credential.domain}</Title>
              <button
                type="button"
                className="zen-v2-link min-w-0 max-w-full"
                data-touch=""
                onClick={() => openSite(state, credential)}
                title="Open the site"
              >
                <span className="truncate">{credential.url || credential.origin}</span>
                <ExternalLink />
              </button>
            </span>
          </span>
        }
        actions={
          editing ? undefined : (
            <>
              <IconBtn label="Edit" onClick={() => setEditing(true)}>
                <Pencil />
              </IconBtn>
              <IconBtn
                label="Delete"
                pressed={confirmDelete}
                onClick={() => setConfirmDelete((c) => !c)}
              >
                <Trash2 />
              </IconBtn>
            </>
          )
        }
      />
      <div className="zen-v2-pw-column min-h-0 flex-1 overflow-y-auto pt-4" onScroll={onScroll}>
        <div className="zen-v2-pw-gutter flex flex-col gap-4 pb-8">
          {confirmDelete &&
            (phone ? (
              <DeleteSheet onKeep={() => setConfirmDelete(false)} onDelete={remove} />
            ) : (
              <div className="zen-v2-pw-inner-box zen-animate-fade flex flex-wrap items-center gap-3">
                <ErrorNote className="min-w-0 flex-1 basis-[200px]">
                  Delete this login? You can undo for a minute.
                </ErrorNote>
                <div className="flex gap-2">
                  <Btn onClick={() => setConfirmDelete(false)}>Keep</Btn>
                  <Btn variant="danger" onClick={remove}>
                    Delete
                  </Btn>
                </div>
              </div>
            ))}

          {editing ? (
            <LoginForm
              existing={credential}
              onCancel={() => setEditing(false)}
              onSubmit={(values) => {
                const patch: { url: string; username: string; notes: string; password?: string } = {
                  url: values.url,
                  username: values.username,
                  notes: values.notes
                }
                if (values.password) patch.password = values.password
                void cmd('passwords.update', { id: credential.id, patch }).then((updated) => {
                  if (updated) onChanged(updated)
                  setEditing(false)
                })
              }}
            />
          ) : (
            <>
              <Rows>
                <FieldRow
                  label="Username"
                  value={
                    credential.username || (
                      <span className="zen-v2-pw-deemphasized">No username</span>
                    )
                  }
                  actions={
                    <IconBtn label="Copy username" onClick={() => copy('username')}>
                      <Copy />
                    </IconBtn>
                  }
                />
                <FieldRow
                  label="Password"
                  value={
                    revealed !== null ? (
                      <Secret value={revealed} className="zen-animate-fade" />
                    ) : (
                      <Secret value={DOT_MASK} />
                    )
                  }
                  actions={
                    <>
                      <IconBtn
                        label={revealed !== null ? 'Hide password' : 'Show password'}
                        onClick={() => void reveal()}
                      >
                        {revealed !== null ? <EyeOff /> : <Eye />}
                      </IconBtn>
                      <IconBtn label="Copy password" onClick={() => copy('password')}>
                        <Copy />
                      </IconBtn>
                    </>
                  }
                />
                {credential.notes && (
                  <FieldRow
                    label="Notes"
                    value={<span className="whitespace-pre-wrap">{credential.notes}</span>}
                  />
                )}
                {credential.realm && (
                  <FieldRow label="HTTP authentication realm" value={credential.realm} />
                )}
              </Rows>
              <div className="flex flex-col gap-0.5">
                <Description>Saved {formatDate(credential.createdAt)}</Description>
                <Description>Changed {relativeTimeInSentence(credential.updatedAt)}</Description>
                <Description>
                  {credential.lastUsedAt
                    ? `Last used ${relativeTimeInSentence(credential.lastUsedAt)}`
                    : 'Not used to sign in yet'}
                </Description>
              </div>
              {/* The level's actions are rows (§10.4), not buttons: §9.11's full-width buttons
                  belong to sheet and dialog footers. The first leaves the page (§9.10 glyph). */}
              <Rows>
                <ActionRow
                  label="Change password on site"
                  leaves="external"
                  onPress={() => openSite(state, credential)}
                />
                <ActionRow
                  label="Never save for this site"
                  onPress={() => {
                    run('passwords.neverSaveAdd', { domain: credential.domain })
                    pushToast(`Zenium will not offer to save logins for ${credential.domain}`)
                  }}
                />
              </Rows>
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * A field as a row on the surface: the shared row in its static form (§9.34) – the value is not
 * a target, its icon buttons are – with the caption the 13/20 first line and the value the
 * 15/20 second, the controls centred on the row (§9.18, §9.21).
 */
function FieldRow({
  label,
  value,
  actions
}: {
  label: string
  value: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="zen-v2-row zen-v2-pw-row" data-static="">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="zen-v2-description">{label}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
      </span>
      {actions && <div className="zen-v2-pw-row-control flex-nowrap">{actions}</div>}
    </div>
  )
}

/** The phone's delete confirmation (§10.4, §9.23): a prompt sheet, Delete in the danger ink. */
function DeleteSheet({
  onKeep,
  onDelete
}: {
  onKeep: () => void
  onDelete: () => void
}): JSX.Element {
  const sheet = useRef<PromptSheetHandle>(null)
  const deleting = useRef(false)
  return (
    <PromptSheet
      ref={sheet}
      name="passwords-delete"
      title="Delete this login?"
      description="You can undo for a minute."
      onClosed={() => (deleting.current ? onDelete() : onKeep())}
      footer={
        <>
          <Btn onClick={() => sheet.current?.dismiss()}>Keep</Btn>
          <Btn
            variant="danger"
            onClick={() => {
              deleting.current = true
              sheet.current?.dismiss()
            }}
          >
            Delete
          </Btn>
        </>
      }
    />
  )
}
