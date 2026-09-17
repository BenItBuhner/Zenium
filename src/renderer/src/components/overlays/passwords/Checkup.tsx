import type { JSX, ReactNode } from 'react'
import { CircleCheck, ExternalLink, ShieldAlert, ShieldOff, Repeat2 } from 'lucide-react'
import type { CredentialSummary, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { openSite, relativeTimeInSentence, usePhone } from './lib'
import { Btn, Description, Heading, ListRow, Progress, SiteIcon, StatusGlyph } from './shared'

/**
 * Password checkup: compromised (HIBP Pwned Passwords, k-anonymity range lookups), reused and
 * weak (zxcvbn) logins with a way to the site's password change. The headline counts distinct
 * logins – one login can be compromised, weak and reused at once – then a row group per finding.
 */
export function Checkup({
  state,
  logins,
  onShow
}: {
  state: UIState
  logins: CredentialSummary[]
  onShow: (id: string) => void
}): JSX.Element {
  const phone = usePhone()
  const checkup = state.passwords.checkup
  const byId = new Map(logins.map((c) => [c.id, c]))
  const resolve = (ids: string[]): CredentialSummary[] =>
    ids.map((id) => byId.get(id)).filter((c): c is CredentialSummary => Boolean(c))
  const compromised = resolve(checkup.compromised)
  const weak = resolve(checkup.weak)
  const reused = checkup.reused.map(resolve).filter((group) => group.length > 1)
  const issues = new Set([...compromised, ...weak, ...reused.flat()].map((c) => c.id)).size
  const ran = checkup.finishedAt !== null
  const clean = ran && !checkup.running && issues === 0 && !checkup.error

  const headline = checkup.running
    ? `Checking ${checkup.checked} of ${checkup.total}`
    : !ran
      ? 'Check your saved passwords'
      : issues === 0
        ? 'No problems found'
        : `${issues} ${issues === 1 ? 'password needs' : 'passwords need'} attention`
  const detail = checkup.running
    ? 'Looking up breaches by hash prefix; your passwords never leave this device.'
    : checkup.error
      ? checkup.error
      : ran && checkup.finishedAt
        ? `Last checked ${relativeTimeInSentence(checkup.finishedAt)}` +
          (checkup.unchecked.length
            ? ` · ${checkup.unchecked.length} could not be checked for breaches`
            : '')
        : 'Finds passwords that appeared in data breaches, are reused across sites or are easy to guess.'

  return (
    <div className="zen-v2-pw-gutter flex flex-col gap-4 pb-8">
      <div className={phone ? 'flex flex-col gap-4' : 'flex items-start gap-4'}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <StatusGlyph
            tone={clean ? 'ok' : issues > 0 ? 'danger' : 'accent'}
            className="mt-0.5 !h-6 !w-6"
          >
            {clean ? <CircleCheck /> : <ShieldAlert />}
          </StatusGlyph>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="zen-v2-pw-panel-title">{headline}</h3>
            <Description>{detail}</Description>
            {checkup.running && (
              <Progress value={checkup.checked} max={checkup.total} className="mt-2" />
            )}
          </div>
        </div>
        {checkup.running ? (
          <Btn onClick={() => run('passwords.checkupCancel', undefined)}>Cancel</Btn>
        ) : (
          <Btn
            variant="primary"
            disabled={logins.length === 0}
            onClick={() => run('passwords.checkupRun', undefined)}
          >
            {ran ? 'Check again' : 'Check now'}
          </Btn>
        )}
      </div>

      {ran && (
        <>
          <Findings
            icon={<ShieldOff />}
            tone="danger"
            title="Compromised"
            count={compromised.length}
            hint="Found in a known data breach. Change these first."
            empty="No compromised passwords."
          >
            {compromised.map((c) => (
              <IssueRow key={c.id} state={state} credential={c} onShow={onShow} />
            ))}
          </Findings>
          <Findings
            icon={<Repeat2 />}
            tone="warn"
            title="Reused"
            count={reused.reduce((n, g) => n + g.length, 0)}
            hint="One leak would open every account sharing the password."
            empty="No reused passwords."
          >
            {reused.map((group, i) => (
              <div key={i} className={i > 0 ? 'mt-2' : undefined}>
                <Description className="px-3 pb-1">Shared by {group.length}</Description>
                {group.map((c) => (
                  <IssueRow key={c.id} state={state} credential={c} onShow={onShow} />
                ))}
              </div>
            ))}
          </Findings>
          <Findings
            icon={<ShieldAlert />}
            tone="warn"
            title="Weak"
            count={weak.length}
            hint="Easy to guess. Replace them with generated passwords."
            empty="No weak passwords."
          >
            {weak.map((c) => (
              <IssueRow key={c.id} state={state} credential={c} onShow={onShow} />
            ))}
          </Findings>
        </>
      )}
    </div>
  )
}

/** A headed row group for one kind of finding; the glyph carries the status ink. */
function Findings({
  icon,
  tone,
  title,
  count,
  hint,
  empty,
  children
}: {
  icon: ReactNode
  tone: 'danger' | 'warn'
  title: string
  count: number
  hint: string
  empty: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="flex flex-col">
      <Heading
        className="px-3"
        trailing={<Description className="tabular-nums">{count}</Description>}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusGlyph tone={count === 0 ? 'muted' : tone}>{icon}</StatusGlyph>
          <span className="truncate">{title}</span>
        </span>
      </Heading>
      <Description className="px-3 pb-1">{count === 0 ? empty : hint}</Description>
      {count > 0 && <div className="flex flex-col">{children}</div>}
    </section>
  )
}

function IssueRow({
  state,
  credential,
  onShow
}: {
  state: UIState
  credential: CredentialSummary
  onShow: (id: string) => void
}): JSX.Element {
  return (
    <ListRow>
      <SiteIcon domain={credential.domain} favicon={credential.favicon} />
      <button
        type="button"
        className="zen-v2-pw-list-row-open min-w-0 flex-1 text-left"
        onClick={() => onShow(credential.id)}
      >
        <div className="truncate">{credential.domain}</div>
        <div className="zen-v2-pw-row-description truncate" data-clamp="false">
          {credential.username || 'No username'}
        </div>
      </button>
      <Btn onClick={() => openSite(state, credential)}>
        <ExternalLink /> Change
      </Btn>
    </ListRow>
  )
}
