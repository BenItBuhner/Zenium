import type { JSX, ReactNode } from 'react'
import { CircleCheck, ExternalLink, ShieldAlert, ShieldOff, Repeat2 } from 'lucide-react'
import type { CredentialSummary, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { openSite, relativeTimeInSentence, usePhone } from './lib'
import {
  Btn,
  Description,
  EmptyRow,
  Heading,
  ListRow,
  Progress,
  Rows,
  SiteIcon,
  StatusGlyph
} from './shared'

/**
 * Password checkup: compromised (HIBP Pwned Passwords, k-anonymity range lookups), reused and
 * weak (zxcvbn) logins with a way to the site's password change. The headline counts distinct
 * logins – one login can be compromised, weak and reused at once – then a row group per finding,
 * an empty group one plain row (§9.17). Nothing here selects a row (§9.6 has no case): a
 * finding's row opens the login or its site.
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
    <div className="zen-v2-pw-gutter zen-v2-pw-sections flex flex-col gap-4 pb-8">
      <div className={phone ? 'flex flex-col gap-4' : 'flex items-start gap-4'}>
        {/* Busy (§9.30): the block being worked on says so; the progress bar reports the count. */}
        <div
          className="flex min-w-0 flex-1 items-start gap-3"
          aria-busy={checkup.running || undefined}
        >
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
        {/*
         * The view's one primary starts the check and, while it runs, is the working button
         * (§9.30): full opacity, its label a spinner, `aria-busy`; Cancel stands beside it.
         */}
        <div className="flex shrink-0 gap-2">
          {checkup.running && (
            <Btn onClick={() => run('passwords.checkupCancel', undefined)}>Cancel</Btn>
          )}
          <Btn
            variant="primary"
            busy={checkup.running}
            disabled={!checkup.running && logins.length === 0}
            onClick={() => run('passwords.checkupRun', undefined)}
          >
            {ran ? 'Check again' : 'Check now'}
          </Btn>
        </div>
      </div>

      {ran && (
        <>
          <Findings
            icon={<ShieldOff />}
            tone="danger"
            title="Compromised"
            count={compromised.length}
            hint="Found in a known data breach. Change these first."
            empty="No compromised passwords"
          >
            <Rows>
              {compromised.map((c) => (
                <IssueRow key={c.id} state={state} credential={c} onShow={onShow} />
              ))}
            </Rows>
          </Findings>
          <Findings
            icon={<Repeat2 />}
            tone="warn"
            title="Reused"
            count={reused.reduce((n, g) => n + g.length, 0)}
            hint="One leak would open every account sharing the password."
            empty="No reused passwords"
          >
            {reused.map((group, i) => (
              <div key={i} className={i > 0 ? 'mt-2' : undefined}>
                <Description className="pb-1">Shared by {group.length}</Description>
                <Rows>
                  {group.map((c) => (
                    <IssueRow key={c.id} state={state} credential={c} onShow={onShow} />
                  ))}
                </Rows>
              </div>
            ))}
          </Findings>
          <Findings
            icon={<ShieldAlert />}
            tone="warn"
            title="Weak"
            count={weak.length}
            hint="Easy to guess. Replace them with generated passwords."
            empty="No weak passwords"
          >
            <Rows>
              {weak.map((c) => (
                <IssueRow key={c.id} state={state} credential={c} onShow={onShow} />
              ))}
            </Rows>
          </Findings>
        </>
      )}
    </div>
  )
}

/**
 * A headed row group for one kind of finding; the glyph carries the status ink. With nothing
 * found the group is one plain row saying so (§9.17), at the rows' gutter.
 */
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
        trailing={<Description className="tabular-nums">{count}</Description>}
        description={hint}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusGlyph tone={count === 0 ? 'muted' : tone}>{icon}</StatusGlyph>
          <span className="truncate">{title}</span>
        </span>
      </Heading>
      {count > 0 ? (
        <div className="flex flex-col">{children}</div>
      ) : (
        <Rows>
          <EmptyRow>{empty}</EmptyRow>
        </Rows>
      )}
    </section>
  )
}

/**
 * A finding: the shared row in its static form (§9.34) – its two targets are the text, which
 * opens the login, and the Change button, which opens the site – with the site tile on the
 * first text line and the username the 13/20 second line.
 */
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
      <SiteIcon
        domain={credential.domain}
        favicon={credential.favicon}
        className="zen-v2-pw-row-site"
      />
      <button
        type="button"
        className="zen-v2-pw-list-row-open flex min-w-0 flex-1 flex-col justify-center text-left"
        onClick={() => onShow(credential.id)}
      >
        <span className="truncate">{credential.domain}</span>
        <span className="zen-v2-description zen-v2-pw-one-line">
          {credential.username || 'No username'}
        </span>
      </button>
      <Btn onClick={() => openSite(state, credential)}>
        <ExternalLink /> Change
      </Btn>
    </ListRow>
  )
}
