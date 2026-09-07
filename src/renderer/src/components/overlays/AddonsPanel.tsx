import type { JSX } from 'react'
import { useState } from 'react'
import { FolderOpen, Link2, Plus, Puzzle, Trash2 } from 'lucide-react'
import type { Mod, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { EmptyNote, OverlayShell } from './OverlayShell'

type Tab = 'extensions' | 'mods'

/** Zen's "Add-ons and Themes" (Ctrl+Shift+A): unpacked extensions and chrome CSS mods. */
export function AddonsPanel({ state }: { state: UIState }): JSX.Element {
  const [tab, setTab] = useState<Tab>('extensions')
  return (
    <OverlayShell title="Add-ons and Themes" variant="full">
      <div className="flex h-full">
        <nav className="w-52 shrink-0 border-r border-[var(--zen-border)] p-2">
          {(
            [
              { id: 'extensions', label: 'Extensions' },
              { id: 'mods', label: 'Mods' }
            ] as Array<{ id: Tab; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                'zen-squircle flex h-9 w-full items-center rounded-lg px-3 text-left text-[13px] hover:bg-[var(--zen-element-bg)]',
                tab === item.id && 'bg-[var(--zen-element-bg-active)] font-medium'
              )}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {tab === 'extensions' ? (
              <ExtensionsSection state={state} />
            ) : (
              <ModsSection state={state} />
            )}
          </div>
        </div>
      </div>
    </OverlayShell>
  )
}

export function ExtensionsSection({ state }: { state: UIState }): JSX.Element {
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold">Extensions</h3>
          <p className="mt-1 text-[12.5px] text-[var(--zen-muted)]">
            Load unpacked Chrome extensions (a folder with a <code>manifest.json</code>). Content
            scripts, storage, webRequest, scripting and DevTools panels are supported; extensions
            run in every container.
          </p>
        </div>
        <Button size="sm" onClick={() => run('extension.add', undefined)}>
          <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> Load unpacked…
        </Button>
      </div>
      {state.extensions.length === 0 ? (
        <EmptyNote>No extensions yet.</EmptyNote>
      ) : (
        <ul className="zen-squircle overflow-hidden rounded-xl border border-[var(--zen-border)]">
          {state.extensions.map((ext) => (
            <li
              key={ext.id}
              className="flex items-center gap-3 border-b border-[var(--zen-border)] px-4 py-3 last:border-b-0"
            >
              {ext.icon ? (
                <img src={ext.icon} alt="" className="h-8 w-8 rounded-lg" draggable={false} />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--zen-element-bg)]">
                  <Puzzle className="h-4 w-4 opacity-60" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13.5px] font-medium">{ext.name}</span>
                  {ext.version && (
                    <span className="text-[11px] text-[var(--zen-muted)]">v{ext.version}</span>
                  )}
                </div>
                <div className="truncate text-[11.5px] text-[var(--zen-muted)]" title={ext.path}>
                  {ext.error ? (
                    <span className="text-red-500">{ext.error}</span>
                  ) : (
                    ext.description || ext.path
                  )}
                </div>
              </div>
              <Switch
                checked={ext.enabled}
                onCheckedChange={(v) => run('extension.setEnabled', { id: ext.id, enabled: v })}
              />
              <button
                type="button"
                className="zen-toolbar-button h-7 w-7"
                title="Remove"
                onClick={() => run('extension.remove', { id: ext.id })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export function ModsSection({ state }: { state: UIState }): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold">Mods</h3>
          <p className="mt-1 text-[12.5px] text-[var(--zen-muted)]">
            Custom CSS for the browser chrome, like Zen&apos;s mods and <code>userChrome.css</code>.
            Style hooks: <code>.zen-tab</code>, <code>.zen-essential</code>, <code>.zen-panel</code>
            , <code>.zen-content-frame</code>, <code>.zen-toolbar-button</code>,{' '}
            <code>[data-active]</code>.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="secondary" onClick={() => run('mod.importFile', undefined)}>
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> Import…
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void run('mod.add', { name: 'New mod', css: '/* your CSS */\n' })
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New mod
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 shrink-0 opacity-60" />
        <Input
          placeholder="https://example.com/mod.css"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim()) {
              run('mod.importUrl', { url: url.trim() })
              setUrl('')
            }
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!url.trim()}
          onClick={() => {
            run('mod.importUrl', { url: url.trim() })
            setUrl('')
          }}
        >
          Import from URL
        </Button>
      </div>
      {state.mods.length === 0 ? (
        <EmptyNote>No mods installed.</EmptyNote>
      ) : (
        <ul className="zen-squircle overflow-hidden rounded-xl border border-[var(--zen-border)]">
          {state.mods.map((mod) => (
            <ModRow
              key={mod.id}
              mod={mod}
              editing={editing === mod.id}
              onToggleEdit={() => setEditing(editing === mod.id ? null : mod.id)}
            />
          ))}
        </ul>
      )}
    </>
  )
}

function ModRow({
  mod,
  editing,
  onToggleEdit
}: {
  mod: Mod
  editing: boolean
  onToggleEdit: () => void
}): JSX.Element {
  const [css, setCss] = useState(mod.css)
  const [name, setName] = useState(mod.name)
  return (
    <li className="border-b border-[var(--zen-border)] last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() =>
                name.trim() !== mod.name && run('mod.update', { id: mod.id, patch: { name } })
              }
              className="h-7 max-w-xs"
            />
          ) : (
            <button
              type="button"
              className="truncate text-left text-[13.5px] font-medium"
              onClick={onToggleEdit}
            >
              {mod.name}
            </button>
          )}
          <div className="truncate text-[11.5px] text-[var(--zen-muted)]">
            {mod.source ?? `${mod.css.length.toLocaleString()} characters`}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onToggleEdit}>
          {editing ? 'Done' : 'Edit'}
        </Button>
        <Switch
          checked={mod.enabled}
          onCheckedChange={(v) => run('mod.update', { id: mod.id, patch: { enabled: v } })}
        />
        <button
          type="button"
          className="zen-toolbar-button h-7 w-7"
          title="Remove mod"
          onClick={() => run('mod.remove', { id: mod.id })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {editing && (
        <div className="px-4 pb-3">
          <textarea
            value={css}
            spellCheck={false}
            className="zen-squircle h-48 w-full resize-y rounded-xl bg-[var(--zen-element-bg)] p-2.5 font-mono text-[12px] outline-none ring-1 ring-transparent focus:ring-[var(--zen-accent)]/60"
            onChange={(e) => setCss(e.target.value)}
            onBlur={() => css !== mod.css && run('mod.update', { id: mod.id, patch: { css } })}
          />
        </div>
      )}
    </li>
  )
}
