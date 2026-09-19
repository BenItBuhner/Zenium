import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import type { CredentialSummary, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { groupBySite, hostOf, matchLogins, usePhone } from './lib'
import {
  Btn,
  Description,
  EmptyState,
  Heading,
  IconBtn,
  ListRow,
  Rows,
  SearchField,
  SiteIcon,
  TextField
} from './shared'

/**
 * Saved logins grouped by site with a search over site, address, username and notes; the empty
 * state (§9.17: one sentence and the one obvious next step, Add login); and the sites the
 * manager never offers to save for (Chrome's "Declined sites"). The rows are the shared
 * `.zen-v2-row` in `Rows`, bleeding 16 into the gutter so their text sits on the gutter line
 * under the group's heading (§9.25, §10.3).
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
        <EmptyState action={{ label: 'Add login', onPress: onAdd }}>
          No saved passwords yet
        </EmptyState>
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
        <EmptyState>No logins match &ldquo;{query}&rdquo;</EmptyState>
      ) : (
        groups.map((group) => (
          <section key={group.domain} className="flex flex-col">
            <Heading
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
            <Rows>
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
            </Rows>
          </section>
        ))
      )}
      {!query && <NeverSave domains={status.neverSave} />}
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
      <Heading description="Zenium will not offer to save logins for these sites.">
        Never saved
      </Heading>
      <Rows>
        {domains.map((domain) => (
          // A static row (§9.34): its one control, the icon button, is the target.
          <ListRow key={domain}>
            <span className="min-w-0 flex-1 truncate">{domain}</span>
            <IconBtn
              label="Allow saving again"
              onClick={() => run('passwords.neverSaveRemove', { domain })}
            >
              <X />
            </IconBtn>
          </ListRow>
        ))}
      </Rows>
      <div className="flex items-center gap-2 pt-2">
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
