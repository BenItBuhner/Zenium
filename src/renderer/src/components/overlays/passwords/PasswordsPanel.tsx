import '@renderer/assets/passwords.css'
import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Dices, KeyRound, Plus, Settings2, ShieldCheck } from 'lucide-react'
import type { CredentialSummary, UIState } from '@shared/types'
import { cmd, onEvent } from '@renderer/lib/api'
import { closeOverlay, pushToast, uiStore } from '@renderer/lib/ui'
import { Checkup } from './Checkup'
import { Generator } from './Generator'
import { usePhone, useScrolled } from './lib'
import { LoginDetail } from './LoginDetail'
import { LoginForm } from './LoginForm'
import { LoginList } from './LoginList'
import { ManagerSettings } from './ManagerSettings'
import { PageShell, PaneHeader, PushedPane } from './PageShell'
import { Btn, Description, IconBtn, Menulist } from './shared'
import { useReauth } from './useReauth'
import { VaultGate } from './VaultGate'

type View = 'logins' | 'checkup' | 'generator' | 'settings'
type Pane = { kind: 'detail'; id: string } | { kind: 'add' } | null

/** The categories: nav items on the desktop (Title Case, §9.1), the header menulist on a phone. */
const VIEWS: Array<{ id: View; label: string; title: string; icon: JSX.Element }> = [
  { id: 'logins', label: 'Passwords', title: 'Passwords', icon: <KeyRound /> },
  { id: 'checkup', label: 'Checkup', title: 'Password Checkup', icon: <ShieldCheck /> },
  { id: 'generator', label: 'Generator', title: 'Password Generator', icon: <Dices /> },
  { id: 'settings', label: 'Settings', title: 'Password Settings', icon: <Settings2 /> }
]

/**
 * The password manager: Chrome's information architecture (saved logins, checkup, settings, plus
 * the generator) as a v2 in-content page. The vault itself is `PasswordService` in the core,
 * reached only through `passwords.*` commands; this surface never holds a secret longer than a
 * reveal. A desktop shows the categories in a 234 px nav column, a phone picks them from a
 * menulist in the header; a login opens as a pane pushed over the list on both. A deleted login
 * is offered back in the shell's message (`pushToast` with an Undo action: the phone's card,
 * the desktop's toast), not in a bar of the manager's own.
 */
export function PasswordsPanel({ state }: { state: UIState }): JSX.Element {
  const phone = usePhone()
  const status = state.passwords
  const unlocked = !status.locked && !status.error
  const requested = uiStore.use((u) => u.overlaySection)
  const [view, setView] = useState<View>(
    VIEWS.some((v) => v.id === requested) ? (requested as View) : 'logins'
  )
  const [pane, setPane] = useState<Pane>(null)
  const { gate, prompt } = useReauth()

  return (
    <PageShell layer={prompt}>
      {unlocked ? (
        <Manager
          state={state}
          phone={phone}
          view={view}
          setView={setView}
          pane={pane}
          setPane={setPane}
          gate={gate}
        />
      ) : (
        <>
          <PaneHeader title="Passwords" onClose={closeOverlay} />
          <VaultGate status={status} />
        </>
      )}
    </PageShell>
  )
}

/** Everything behind the gate; unmounts when the vault locks, so no login lingers in memory. */
function Manager({
  state,
  phone,
  view,
  setView,
  pane,
  setPane,
  gate
}: {
  state: UIState
  phone: boolean
  view: View
  setView: (view: View) => void
  pane: Pane
  setPane: (pane: Pane) => void
  gate: ReturnType<typeof useReauth>['gate']
}): JSX.Element {
  const status = state.passwords
  const [all, setAll] = useState<CredentialSummary[]>([])
  const { scrolled, onScroll } = useScrolled()

  // Every change to the vault bumps `revision`; the list is small enough to fetch whole.
  useEffect(() => {
    let cancelled = false
    void cmd('passwords.list', {}).then((list) => {
      if (!cancelled) setAll(list)
    })
    return () => {
      cancelled = true
    }
  }, [status.revision])

  const show = (id: string): void => {
    setView('logins')
    setPane({ kind: 'detail', id })
  }

  // A deletion is offered back for as long as a toast with an action stays (the core keeps the
  // login restorable for a minute); Undo restores it and opens it again.
  useEffect(
    () =>
      onEvent('passwords.removed', ({ id, site }) =>
        pushToast(`Deleted the login for ${site}`, 'info', {
          action: {
            label: 'Undo',
            onPick: () => {
              void cmd('passwords.restore', { id }).then((restored) => {
                if (restored) show(id)
              })
            }
          }
        })
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `show` only sets state
    []
  )

  const selected = pane?.kind === 'detail' ? (all.find((c) => c.id === pane.id) ?? null) : null
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!
  const alerts = useMemo(
    () => new Set(state.passwords.checkup.compromised).size,
    [state.passwords.checkup.compromised]
  )
  const pick = (next: View): void => {
    setPane(null)
    setView(next)
  }

  // One primary per view (§6): the list's is Add, shown in the header while the list has rows.
  const headerAdd = view === 'logins' && status.count > 0
  const actions =
    view === 'logins' ? (
      phone ? (
        <IconBtn label="Add login" onClick={() => setPane({ kind: 'add' })}>
          <Plus />
        </IconBtn>
      ) : headerAdd ? (
        <Btn variant="primary" onClick={() => setPane({ kind: 'add' })}>
          <Plus /> Add
        </Btn>
      ) : undefined
    ) : undefined

  return (
    <div className="flex min-h-0 flex-1">
      {!phone && (
        <nav aria-label="Categories" className="zen-v2-pw-nav pt-[52px]">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="zen-v2-pw-nav-item"
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => pick(item.id)}
            >
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {/* The count badge (§9.19): the shared badge, ink only – no red pill. */}
              {item.id === 'checkup' && alerts > 0 && (
                <span className="zen-v2-badge">{alerts}</span>
              )}
            </button>
          ))}
        </nav>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <PaneHeader
          scrolled={scrolled}
          onClose={closeOverlay}
          actions={actions}
          title={
            phone ? (
              <Menulist
                title
                label="Category"
                value={view}
                options={VIEWS.map((v) => ({ value: v.id, label: v.label }))}
                onChange={pick}
              />
            ) : (
              current.title
            )
          }
        />
        <div
          className="zen-v2-pw-column min-h-0 flex-1 overflow-y-auto pt-4"
          onScroll={onScroll}
          key={view}
        >
          {view === 'logins' && (
            <LoginList
              state={state}
              logins={all}
              onShow={show}
              onAdd={() => setPane({ kind: 'add' })}
            />
          )}
          {view === 'checkup' && <Checkup state={state} logins={all} onShow={show} />}
          {view === 'generator' && (
            <div className="zen-v2-pw-gutter flex flex-col gap-4 pb-8">
              <Generator />
              <Description>
                Generated passwords come from this device&apos;s secure random source and are not
                saved until you add a login with one.
              </Description>
            </div>
          )}
          {view === 'settings' && <ManagerSettings state={state} gate={gate} />}
        </div>

        {pane?.kind === 'detail' && selected && (
          <PushedPane name="passwords-pane" onPop={() => setPane(null)}>
            <LoginDetail
              key={`${selected.id}:${selected.updatedAt}`}
              state={state}
              credential={selected}
              gate={gate}
              onBack={() => setPane(null)}
              onChanged={(updated) =>
                setAll((list) => list.map((c) => (c.id === updated.id ? updated : c)))
              }
              onRemoved={() => setPane(null)}
            />
          </PushedPane>
        )}
        {pane?.kind === 'add' && (
          <PushedPane name="passwords-pane" onPop={() => setPane(null)}>
            <AddPane
              onCancel={() => setPane(null)}
              onCreated={(created) => setPane({ kind: 'detail', id: created.id })}
            />
          </PushedPane>
        )}
      </div>
    </div>
  )
}

/** The new-login pane: a header with the back control over the form. */
function AddPane({
  onCancel,
  onCreated
}: {
  onCancel: () => void
  onCreated: (created: CredentialSummary) => void
}): JSX.Element {
  const { scrolled, onScroll } = useScrolled()
  return (
    <>
      <PaneHeader title="New Login" onBack={onCancel} scrolled={scrolled} />
      <div className="zen-v2-pw-column min-h-0 flex-1 overflow-y-auto pt-4" onScroll={onScroll}>
        <div className="zen-v2-pw-gutter pb-8">
          <LoginForm
            onCancel={onCancel}
            onSubmit={(values) => void cmd('passwords.add', values).then(onCreated)}
          />
        </div>
      </div>
    </>
  )
}
