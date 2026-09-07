import type { JSX } from 'react'
import { useState } from 'react'
import type { LiveFolderConfig, LiveFolderProvider, UIState } from '@shared/types'
import {
  LIVE_FOLDER_INTERVALS,
  LIVE_FOLDER_PROVIDERS,
  defaultLiveFolderConfig,
  isLocalEndpoint
} from '@shared/livefolders'
import { cmd } from '@renderer/lib/api'
import { closeOverlay } from '@renderer/lib/ui'
import { cn, relativeTime } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { OverlayShell } from './OverlayShell'

/** Create a Live Folder or edit the source of an existing one (Zen 1.19). */
export function LiveFolderEditor({
  state,
  folderId
}: {
  state: UIState
  folderId: string | null
}): JSX.Element {
  const folder = folderId ? state.folders[folderId] : undefined
  const existing = folderId ? state.liveFolders[folderId] : undefined
  const [name, setName] = useState(folder?.name ?? '')
  const [config, setConfig] = useState<LiveFolderConfig>(
    () => existing ?? defaultLiveFolderConfig(folderId ?? 'new', 'github-pulls')
  )
  const [saving, setSaving] = useState(false)
  const provider = LIVE_FOLDER_PROVIDERS.find((p) => p.id === config.provider)!
  const isGithub = config.provider === 'github-pulls' || config.provider === 'github-issues'
  const isRest = config.provider === 'rest'
  const localRest = isRest && isLocalEndpoint(config.source)
  const patch = (p: Partial<LiveFolderConfig>): void => setConfig((c) => ({ ...c, ...p }))
  const canSave =
    config.source.trim().length > 0 && (!isRest || localRest || Boolean(config.mapping))

  const save = async (): Promise<void> => {
    setSaving(true)
    const autoName =
      name.trim() ||
      (isGithub
        ? `${config.provider === 'github-pulls' ? 'Pull requests' : 'Issues'} · ${config.source.trim()}`
        : provider.label)
    await cmd('liveFolder.save', {
      folderId: folder ? folder.id : null,
      name: autoName,
      config: {
        provider: config.provider,
        source: config.source,
        includeDrafts: config.includeDrafts,
        token: config.token,
        mapping: config.mapping,
        intervalMinutes: config.intervalMinutes,
        maxItems: config.maxItems
      }
    }).catch(() => undefined)
    setSaving(false)
    closeOverlay()
  }

  return (
    <OverlayShell
      title={existing ? 'Live Folder' : 'New Live Folder'}
      variant="dialog"
      className="w-[520px]"
    >
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) void save()
        }}
      >
        <p className="text-[12.5px] text-[var(--zen-muted)]">
          Live folders fill themselves from a source and refresh automatically. Closing or moving a
          tab out of the folder dismisses that item for good.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {LIVE_FOLDER_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cn(
                'zen-squircle flex items-center gap-3 rounded-xl border border-[var(--zen-border)] px-3 py-2 text-left hover:bg-[var(--zen-element-bg)]',
                config.provider === p.id &&
                  'bg-[var(--zen-element-bg-active)] ring-2 ring-[var(--zen-accent)]'
              )}
              onClick={() =>
                setConfig((c) => ({
                  ...defaultLiveFolderConfig(c.folderId, p.id as LiveFolderProvider),
                  intervalMinutes: c.intervalMinutes,
                  dismissed: c.dismissed,
                  items: c.items
                }))
              }
            >
              <span className="text-lg leading-none">{p.icon}</span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{p.label}</span>
                <span className="block truncate text-[11px] text-[var(--zen-muted)]">{p.hint}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lf-name">Folder name</Label>
          <Input
            id="lf-name"
            value={name}
            placeholder={isGithub ? 'e.g. My pull requests' : provider.label}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lf-source">
            {isGithub ? 'GitHub username (or search query)' : isRest ? 'Endpoint URL' : 'Feed URL'}
          </Label>
          <Input
            id="lf-source"
            autoFocus
            value={config.source}
            placeholder={
              isGithub
                ? 'octocat  ·  or: repo:zen-browser/desktop is:open'
                : isRest
                  ? 'https://api.example.com/items'
                  : 'https://example.com/feed.xml'
            }
            onChange={(e) => patch({ source: e.target.value })}
          />
        </div>

        {isGithub && (
          <>
            {config.provider === 'github-pulls' && (
              <label className="flex items-center justify-between gap-3 text-[13px]">
                Include draft pull requests
                <Switch
                  checked={config.includeDrafts}
                  onCheckedChange={(v) => patch({ includeDrafts: v })}
                />
              </label>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lf-token">
                Personal access token{' '}
                <span className="text-[var(--zen-muted)]">(optional, for private repos)</span>
              </Label>
              <Input
                id="lf-token"
                type="password"
                value={config.token}
                autoComplete="off"
                onChange={(e) => patch({ token: e.target.value })}
              />
            </div>
          </>
        )}

        {isRest && !localRest && (
          <div className="flex flex-col gap-2">
            <Label>Field mapping (dot paths into the JSON)</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['items', 'id', 'title', 'url'] as const).map((field) => (
                <label key={field} className="flex items-center gap-2 text-[12px]">
                  <span className="w-10 text-[var(--zen-muted)]">{field}</span>
                  <Input
                    className="h-7"
                    value={config.mapping?.[field] ?? ''}
                    placeholder={field === 'items' ? 'data.items (empty = root array)' : field}
                    onChange={(e) =>
                      patch({
                        mapping: {
                          items: config.mapping?.items ?? '',
                          id: config.mapping?.id ?? 'id',
                          title: config.mapping?.title ?? 'title',
                          url: config.mapping?.url ?? 'url',
                          [field]: e.target.value
                        }
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        )}
        {localRest && (
          <p className="text-[12px] text-[var(--zen-muted)]">
            Localhost endpoints must return Zen&apos;s local schema:{' '}
            <code>{'{ "items": [{ "id", "title", "url" }] }'}</code>.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Refresh every</Label>
            <Select
              value={String(config.intervalMinutes)}
              onValueChange={(v) => patch({ intervalMinutes: Number(v) })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIVE_FOLDER_INTERVALS.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lf-max">Maximum items</Label>
            <Input
              id="lf-max"
              type="number"
              min={1}
              max={100}
              value={config.maxItems}
              onChange={(e) => patch({ maxItems: Number(e.target.value) || 100 })}
            />
          </div>
        </div>

        {existing && (
          <p className="text-[11.5px] text-[var(--zen-muted)]">
            {existing.lastError ? (
              <span className="text-red-500">Last update failed: {existing.lastError}</span>
            ) : existing.lastFetched ? (
              `Last updated ${relativeTime(existing.lastFetched)} · ${Object.keys(existing.items).length} items · ${existing.dismissed.length} dismissed`
            ) : (
              'Not updated yet'
            )}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={() => closeOverlay()}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave || saving}>
            {existing ? 'Save & refresh' : 'Create live folder'}
          </Button>
        </div>
      </form>
    </OverlayShell>
  )
}
