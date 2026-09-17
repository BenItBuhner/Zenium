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
import { Group } from './SettingsPrimitives'

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
      <div className="flex items-center gap-2 px-2.5">
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
      <p className="zen-settings-hint px-2.5">
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
          <Group key={group} title={SHORTCUT_GROUP_LABELS[group]}>
            {items.map((s) => (
              <ShortcutRow
                key={s.id}
                shortcut={s}
                state={state}
                editing={editing === s.id}
                onEdit={() => setEditing(editing === s.id ? null : s.id)}
              />
            ))}
          </Group>
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
    <div className={cn('zen-settings-row', shortcut.unsupported && 'opacity-60')}>
      <span className="zen-settings-label min-w-0 flex-1 truncate">
        {shortcut.label}
        {shortcut.unsupported && (
          <span className="zen-settings-hint ml-2 inline">not available in this build</span>
        )}
      </span>
      {shortcut.extraBindings.length > 0 && !editing && (
        <span className="zen-settings-hint hidden md:inline">
          {shortcut.extraBindings.map((b) => formatBinding(b, state.platform)).join(', ')}
        </span>
      )}
      {conflicts.length > 0 && !editing && (
        <span
          className="zen-settings-hint text-[var(--zen-warn)]"
          title={`Also used by: ${conflicts.map((c) => c.label).join(', ')}`}
        >
          Conflict
        </span>
      )}
      <button
        type="button"
        className={cn('zen-kbd-button', !shortcut.binding && 'text-[var(--zen-muted)]')}
        data-editing={editing || undefined}
        onClick={onEdit}
      >
        {editing ? 'Press keys…' : formatBinding(shortcut.binding, state.platform)}
      </button>
    </div>
  )
}
