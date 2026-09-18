import type { JSX } from 'react'
import { useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import type {
  NewTabBackgroundKind,
  NewTabShortcut,
  NewTabShortcutsMode,
  Settings,
  UIState
} from '@shared/types'
import { MAX_NEW_TAB_SHORTCUTS } from '@shared/defaults'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Choice, Group, Row } from './SettingsPrimitives'

/**
 * Settings → New Tab, what the page's Customize control opens: the shortcuts source, background
 * and greeting, the switch that turns the page off, and a list editor for the "My shortcuts"
 * tiles for those who prefer forms to the grid.
 */
export function NewTabSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const prefs = state.settings.newTab
  const update = (patch: Partial<Settings['newTab']>): void =>
    set({ newTab: { ...prefs, ...patch } })
  const { image, canPick } = state.newTabBackground
  const backgroundOptions: Array<{ value: NewTabBackgroundKind; label: string }> = [
    { value: 'space', label: 'Space gradient' },
    { value: 'solid', label: 'Solid colour' }
  ]
  if (canPick) backgroundOptions.push({ value: 'image', label: 'Image from file' })
  const onBackground = (v: NewTabBackgroundKind): void => {
    if (v === 'image' && !image) {
      // Picking the file sets the background once a file was chosen; a cancelled dialog keeps the
      // current choice.
      void run('newtab.pickBackgroundImage', undefined)
      return
    }
    update({ background: v })
  }
  return (
    <>
      <Group title="New Tab">
        <Row
          label="Open the new tab page"
          hint="Off, a new tab shows only the address bar, as before."
        >
          <Switch checked={prefs.enabled} onCheckedChange={(v) => update({ enabled: v })} />
        </Row>
        <Row label="Shortcuts">
          <Choice<NewTabShortcutsMode>
            value={prefs.shortcuts}
            onChange={(v) => update({ shortcuts: v })}
            options={[
              { value: 'most-visited', label: 'Most visited' },
              { value: 'custom', label: 'My shortcuts' },
              { value: 'hidden', label: 'Hide' }
            ]}
          />
        </Row>
        <Row
          label="Background"
          hint={
            prefs.background === 'image' && image
              ? 'Your image, stored on this device only.'
              : undefined
          }
        >
          <div className="flex items-center gap-2">
            {canPick && image && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void run('newtab.pickBackgroundImage', undefined)}
                >
                  Change image
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => run('newtab.clearBackgroundImage', undefined)}
                >
                  Remove image
                </Button>
              </>
            )}
            <Choice<NewTabBackgroundKind>
              value={prefs.background === 'image' && !image ? 'space' : prefs.background}
              onChange={onBackground}
              options={backgroundOptions}
            />
          </div>
        </Row>
        <Row label="Show a greeting" hint="A line above the search box that follows the hour.">
          <Switch checked={prefs.greeting} onCheckedChange={(v) => update({ greeting: v })} />
        </Row>
      </Group>
      <ShortcutsGroup shortcuts={state.newTabShortcuts} />
    </>
  )
}

function ShortcutsGroup({ shortcuts }: { shortcuts: NewTabShortcut[] }): JSX.Element {
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const move = (index: number, dir: -1 | 1): void => {
    const ids = shortcuts.map((s) => s.id)
    const target = index + dir
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    run('newtab.reorderShortcuts', { ids })
  }
  return (
    <Group title="My shortcuts">
      {shortcuts.length === 0 && editing !== 'new' && (
        <Row
          label="No shortcuts yet"
          hint='Choose "My shortcuts" above and add the sites you want on every new tab.'
        >
          <span />
        </Row>
      )}
      {shortcuts.map((shortcut, index) =>
        editing === shortcut.id ? (
          <ShortcutForm
            key={shortcut.id}
            initial={shortcut}
            onCancel={() => setEditing(null)}
            onSave={(title, url) => {
              run('newtab.updateShortcut', { id: shortcut.id, title, url })
              setEditing(null)
            }}
          />
        ) : (
          <div
            key={shortcut.id}
            className="flex min-h-12 items-center gap-3 border-b border-[var(--zen-border)] px-4 py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{shortcut.title}</div>
              <div className="truncate text-[11.5px] text-[var(--zen-muted)]">{shortcut.url}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${shortcut.title} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${shortcut.title} down`}
              disabled={index === shortcuts.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${shortcut.title}`}
              onClick={() => setEditing(shortcut.id)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${shortcut.title}`}
              onClick={() => run('newtab.removeShortcut', { id: shortcut.id })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )
      )}
      {editing === 'new' ? (
        <ShortcutForm
          initial={null}
          onCancel={() => setEditing(null)}
          onSave={(title, url) => {
            void run('newtab.addShortcut', { title, url })
            setEditing(null)
          }}
        />
      ) : (
        <div className="flex min-h-12 items-center border-b border-[var(--zen-border)] px-4 py-2 last:border-b-0">
          <Button
            variant="secondary"
            size="sm"
            disabled={shortcuts.length >= MAX_NEW_TAB_SHORTCUTS}
            onClick={() => setEditing('new')}
          >
            <Plus className="h-4 w-4" />
            Add shortcut
          </Button>
          {shortcuts.length >= MAX_NEW_TAB_SHORTCUTS && (
            <span className="ml-3 text-[11.5px] text-[var(--zen-muted)]">
              The grid holds {MAX_NEW_TAB_SHORTCUTS} shortcuts.
            </span>
          )}
        </div>
      )}
    </Group>
  )
}

function ShortcutForm({
  initial,
  onSave,
  onCancel
}: {
  initial: NewTabShortcut | null
  onSave: (title: string, url: string) => void
  onCancel: () => void
}): JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const valid = Boolean(inputToUrl(url.trim()))
  const save = (): void => {
    if (!valid) return
    onSave(title.trim(), url.trim())
  }
  return (
    <form
      className="flex flex-col gap-2 border-b border-[var(--zen-border)] px-4 py-3 last:border-b-0"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="flex gap-2">
        <Input
          aria-label="Shortcut name"
          placeholder="Name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1"
        />
        <Input
          aria-label="Shortcut address"
          placeholder="example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-[2]"
          autoFocus
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid}>
          {initial ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  )
}
