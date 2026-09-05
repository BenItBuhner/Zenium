import type { JSX } from 'react'
import { useState } from 'react'
import type { UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { CONTAINER_COLORS, SPACE_ICONS } from '@shared/defaults'
import { run } from '@renderer/lib/api'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { OverlayShell } from './OverlayShell'

/** Create or edit a space: name, icon and default container (Zen's space settings). */
export function SpaceEditor({
  state,
  spaceId
}: {
  state: UIState
  spaceId: string | null
}): JSX.Element {
  const existing = spaceId ? state.spaces.find((s) => s.id === spaceId) : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [icon, setIcon] = useState(existing?.icon ?? '')
  const [containerId, setContainerId] = useState(existing?.containerId ?? DEFAULT_CONTAINER_ID)

  const save = (): void => {
    const trimmed = name.trim() || (existing ? existing.name : 'New Space')
    if (existing)
      run('space.update', { spaceId: existing.id, patch: { name: trimmed, icon, containerId } })
    else run('space.create', { name: trimmed, icon, containerId, theme: null })
    closeOverlay()
  }

  return (
    <OverlayShell
      title={existing ? 'Edit Space' : 'New Space'}
      variant="dialog"
      className="w-[460px]"
    >
      <form
        className="flex flex-col gap-4 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--zen-element-bg)] text-2xl">
            {icon || '◦'}
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="space-name">Name</Label>
            <Input
              id="space-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Work"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Icon</Label>
          <div className="grid grid-cols-8 gap-1">
            <button
              type="button"
              className={cn(
                'flex h-9 items-center justify-center rounded-lg text-sm hover:bg-[var(--zen-element-bg)]',
                icon === '' && 'bg-[var(--zen-element-bg-active)]'
              )}
              onClick={() => setIcon('')}
              title="No icon"
            >
              ◦
            </button>
            {SPACE_ICONS.map((e) => (
              <button
                key={e}
                type="button"
                className={cn(
                  'flex h-9 items-center justify-center rounded-lg text-lg hover:bg-[var(--zen-element-bg)]',
                  icon === e && 'bg-[var(--zen-element-bg-active)]'
                )}
                onClick={() => setIcon(e)}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Default container</Label>
          <Select value={containerId} onValueChange={setContainerId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {state.containers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: CONTAINER_COLORS[c.color] }}
                    />
                    {c.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11.5px] text-[var(--zen-muted)]">
            New tabs in this space open in the container&apos;s isolated cookie session.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          {existing && state.spaces.length > 1 && (
            <Button
              type="button"
              variant="destructive"
              className="mr-auto"
              onClick={() => {
                closeOverlay()
                run('space.delete', { spaceId: existing.id })
              }}
            >
              Delete space
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => closeOverlay()}>
            Cancel
          </Button>
          <Button type="submit">{existing ? 'Save' : 'Create space'}</Button>
        </div>
      </form>
    </OverlayShell>
  )
}
