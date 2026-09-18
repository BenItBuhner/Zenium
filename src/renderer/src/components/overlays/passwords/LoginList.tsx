import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { ChevronRight, KeyRound, Plus, Upload, X } from 'lucide-react'
import type { CredentialSummary, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { groupBySite, hostOf, matchLogins, usePhone } from './lib'
import {
  Btn,
  Description,
  Heading,
  IconBtn,
  ListRow,
  SearchField,
  SiteIcon,
  StatusGlyph,
  TextField
} from './shared'

/**
 * Saved logins grouped by site with a search over site, address, username and notes; the empty
 * state; and the sites the manager never offers to save for (Chrome's "Declined sites").
 */
export function LoginList({
  state,
  logins,
  onShow,
  onAdd
}: {
  state: UIState
  logins: CredentialSummary[]
  onShow: (id: string) => void
  onAdd: () => void
}): JSX.Element {
  const phone = usePhone()
  const status = state.passwords
  const [query, setQuery] = useState('')
  const matched = useMemo(() => matchLogins(logins, query), [logins, query])
  const groups = useMemo(() => groupBySite(matched), [matched])

  if (status.count === 0) {
    return (
      <div className="zen-v2-pw-gutter pb-8">
        <Empty onAdd={onAdd} onImport={() => void cmd('passwords.import', { conflict: 'skip' })} />
        {status.neverSave.length > 0 && <NeverSave domains={status.neverSave} />}
      </div>
    )
  }

  return (
    <div className="zen-v2-pw-gutter zen-v2-pw-sections flex flex-col gap-2 pb-8">
      <div className="flex items-center gap-3 pb-2">
        <SearchField
          autoFocus={!phone}
          placeholder="Search passwords"
          aria-label="Search passwords"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1"
        />
        {!phone && (
          <Description className="shrink-0 tabular-nums">
            {status.count} {status.count === 1 ? 'login' : 'logins'}
          </Description>
        )}
      </div>
      {groups.length === 0 ? (
        <Description className="py-10 text-center">
          No logins match &ldquo;{query}&rdquo;.
        </Description>
      ) : (
        groups.map((group) => (
          <section key={group.domain} className="flex flex-col">
            <Heading
              className="px-3"
              trailing={
                group.entries.length > 1 ? (
                  <Description className="tabular-nums">{group.entries.length}</Description>
                ) : undefined
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <SiteIcon domain={group.domain} favicon={group.favicon} />
                <span className="truncate">{group.domain}</span>
              </span>
            </Heading>
            {group.entries.map((c) => (
              <ListRow key={c.id} onClick={() => onShow(c.id)}>
                <span className="min-w-0 flex-1 truncate">
                  {c.username || <span className="zen-v2-pw-deemphasized">No username</span>}
                </span>
                {hostOf(c.origin) !== group.domain && (
                  <Description className="max-w-[45%] truncate">{hostOf(c.origin)}</Description>
                )}
                {c.realm && <Description className="shrink-0">HTTP auth</Description>}
                {phone && <ChevronRight className="zen-v2-pw-deemphasized" />}
              </ListRow>
            ))}
          </section>
        ))
      )}
      {!query && <NeverSave domains={status.neverSave} />}
    </div>
  )
}

/** The first run: the page's one primary is Add here; Import is the secondary. */
function Empty({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }): JSX.Element {
  const phone = usePhone()
  return (
    <div className="zen-animate-fade flex flex-col items-center gap-5 px-4 py-12 text-center">
      <StatusGlyph tone="accent" hero>
        <KeyRound />
      </StatusGlyph>
      <div className="flex max-w-[400px] flex-col gap-1">
        <h3 className="zen-v2-pw-panel-title">No saved passwords yet</h3>
        <Description>
          Logins you add here are encrypted on this device. Bring the ones you already have from
          another browser or password manager.
        </Description>
      </div>
      <div className={phone ? 'flex w-full max-w-[320px] flex-col gap-2' : 'flex gap-2'}>
        <Btn variant="primary" onClick={onAdd}>
          <Plus /> Add login
        </Btn>
        <Btn onClick={onImport}>
          <Upload /> Import passwords
        </Btn>
      </div>
    </div>
  )
}

/** Chrome's "Declined sites": domains Zenium never offers to save logins for. */
function NeverSave({ domains }: { domains: string[] }): JSX.Element {
  const [adding, setAdding] = useState('')
  const add = (): void => {
    const value = adding.trim()
    if (!value) return
    run('passwords.neverSaveAdd', { domain: value })
    setAdding('')
  }
  return (
    <section className="mt-4 flex flex-col">
      <Heading className="px-3" description="Zenium will not offer to save logins for these sites.">
        Never saved
      </Heading>
      {domains.map((domain) => (
        <ListRow key={domain}>
          <span className="min-w-0 flex-1 truncate">{domain}</span>
          <IconBtn
            label="Allow saving again"
            className="-mr-2"
            onClick={() => run('passwords.neverSaveRemove', { domain })}
          >
            <X />
          </IconBtn>
        </ListRow>
      ))}
      <div className="flex items-center gap-2 px-3 py-1">
        <TextField
          placeholder="Add a site, e.g. bank.example"
          aria-label="Site to never save for"
          value={adding}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Btn disabled={!adding.trim()} onClick={add}>
          Add
        </Btn>
      </div>
    </section>
  )
}
