import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { KeyBinding, Shortcut, ShortcutGroup, UIState } from '@shared/types'
import {
  SHORTCUT_GROUP_LABELS,
  bindingFromInput,
  findConflicts,
  formatBinding,
  isModifierKey
} from '@shared/shortcuts'
import { run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const GROUP_ORDER: ShortcutGroup[] = [
  'zen-compact-mode',
  'zen-workspace',
  'zen-split-view',
  'zen-other',
  'windowAndTabManagement',
  'navigation',
  'searchAndFind',
  'pageOperations',
  'historyAndBookmarks',
  'mediaAndDisplay',
  'devTools'
]

/** Zen's keyboard shortcut manager: every binding is editable, conflicts are flagged. */
export function ShortcutsSection({ state }: { state: UIState }): JSX.Element | null {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const q = filter.trim().toLowerCase()

  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setEditing(null)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        run('shortcuts.update', { id: editing, binding: null })
        setEditing(null)
        return
      }
      if (isModifierKey(e.key)) return
      const binding: KeyBinding = bindingFromInput({
        key: e.key,
        control: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey
      })
      if (!binding.ctrl && !binding.alt && !binding.meta && binding.key.length === 1) {
        // Plain letters would break typing in pages – require a modifier (function keys are fine).
        return
      }
      run('shortcuts.update', { id: editing, binding })
      setEditing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editing])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter shortcuts"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => run('shortcuts.reset', undefined)}>
          Reset to defaults
        </Button>
      </div>
      <p className="text-[12px] text-[var(--zen-muted)]">
        Click a shortcut to change it. Press Backspace while editing to unbind, Esc to cancel.
      </p>
      {GROUP_ORDER.map((group) => {
        const items = state.shortcuts.filter(
          (s) =>
            s.group === group &&
            (!q ||
              s.label.toLowerCase().includes(q) ||
              formatBinding(s.binding, state.platform).toLowerCase().includes(q))
        )
        if (items.length === 0) return null
        return (
          <section key={group}>
            <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--zen-muted)]">
              {SHORTCUT_GROUP_LABELS[group]}
            </h3>
            <div className="overflow-hidden rounded-xl border border-[var(--zen-border)]">
              {items.map((s) => (
                <ShortcutRow
                  key={s.id}
                  shortcut={s}
                  state={state}
                  editing={editing === s.id}
                  onEdit={() => setEditing(editing === s.id ? null : s.id)}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function ShortcutRow({
  shortcut,
  state,
  editing,
  onEdit
}: {
  shortcut: Shortcut
  state: UIState
  editing: boolean
  onEdit: () => void
}): JSX.Element {
  const conflicts = shortcut.binding
    ? findConflicts(state.shortcuts, shortcut.binding, shortcut.id)
    : []
  return (
    <div
      className={cn(
        'flex h-10 items-center gap-3 border-b border-[var(--zen-border)] px-3 last:border-b-0',
        shortcut.unsupported && 'opacity-60'
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {shortcut.label}
        {shortcut.unsupported && (
          <span className="ml-2 text-[11px] text-[var(--zen-muted)]">
            not available in this build
          </span>
        )}
      </span>
      {shortcut.extraBindings.length > 0 && !editing && (
        <span className="hidden text-[11px] text-[var(--zen-muted)] md:inline">
          {shortcut.extraBindings.map((b) => formatBinding(b, state.platform)).join(', ')}
        </span>
      )}
      {conflicts.length > 0 && !editing && (
        <span
          className="text-[11px] text-amber-500"
          title={`Also used by: ${conflicts.map((c) => c.label).join(', ')}`}
        >
          conflict
        </span>
      )}
      <button
        type="button"
        className={cn(
          'zen-kbd h-7 min-w-[110px] justify-center px-2.5 text-[12px] hover:bg-[var(--zen-element-bg-hover)]',
          editing && 'ring-2 ring-[var(--zen-accent)]',
          !shortcut.binding && 'text-[var(--zen-muted)]'
        )}
        onClick={onEdit}
      >
        {editing ? 'Press keys…' : formatBinding(shortcut.binding, state.platform)}
      </button>
    </div>
  )
}
