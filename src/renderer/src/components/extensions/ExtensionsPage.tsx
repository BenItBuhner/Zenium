import type { DragEvent, JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  Ellipsis,
  FolderOpen,
  Info,
  Package,
  Pin,
  PinOff,
  Puzzle,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  Store,
  Trash2
} from 'lucide-react'
import type { ExtensionInfo, Rect, UIState } from '@shared/types'
import { anchorOf } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { relativeTime } from '@renderer/lib/extensions/format'
import { parseStoreInput, versionAndSource } from '@renderer/lib/extensions/storeInput'
import { cn } from '@renderer/lib/utils'
import { LocalMenu, type LocalMenuEntry } from '../menus/LocalMenu'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { ExtensionDetails } from './ExtensionDetails'
import { ExtensionIcon } from './ExtensionIcon'
import { useNow } from './useNow'

interface MenuState {
  anchor: Rect
  title?: string
  items: LocalMenuEntry[]
}

/**
 * The Extensions tab of Add-ons and Themes (design-language.md §8.2 rows, §8.7 header, §8.6
 * field, §8.8 menus): a header with the title and two trailing actions, the last update check
 * as a caption, one row per extension, and a details level that pushes in. Dropping a `.crx` or
 * `.zip` (or an unpacked folder) anywhere on the page installs it.
 */
export function ExtensionsPage({ state }: { state: UIState }): JSX.Element {
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropping, setDropping] = useState(false)
  const extensions = state.extensions
  // An extension removed underneath its details level takes the level with it.
  const details = detailsId ? extensions.find((e) => e.id === detailsId) : undefined
  const menuFor = (ext: ExtensionInfo, anchor: Rect): MenuState =>
    rowMenu(ext, anchor, setDetailsId, () => setDetailsId(null))

  const dropDepth = useRef(0)
  const onDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dropDepth.current++
    setDropping(true)
  }
  const onDragLeave = (): void => {
    dropDepth.current = Math.max(0, dropDepth.current - 1)
    if (dropDepth.current === 0) setDropping(false)
  }
  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dropDepth.current = 0
    setDropping(false)
    const paths = [...e.dataTransfer.files]
      .map((file) => window.zen.pathForFile?.(file) ?? '')
      .filter((p) => p.length > 0)
    if (paths.length) run('extension.installFromDrop', { paths })
  }

  return (
    <div
      className="relative flex min-h-full flex-col gap-4"
      data-dropping={dropping || undefined}
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {details ? (
        <ExtensionDetails
          ext={details}
          onBack={() => setDetailsId(null)}
          onMenu={(anchor) => setMenu(menuFor(details, anchor))}
        />
      ) : (
        <ExtensionList
          state={state}
          adding={adding}
          setAdding={setAdding}
          openMenu={setMenu}
          menuFor={menuFor}
          openDetails={setDetailsId}
        />
      )}
      {dropping && (
        <div className="zen-ext-drop zen-animate-in">
          <Package className="h-4 w-4" />
          Drop to install
        </div>
      )}
      {menu && (
        <LocalMenu
          anchor={menu.anchor}
          items={menu.items}
          title={menu.title}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function hasFiles(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes('Files')
}

// ---------------------------------------------------------------------------
// List level
// ---------------------------------------------------------------------------

function ExtensionList({
  state,
  adding,
  setAdding,
  openMenu,
  menuFor,
  openDetails
}: {
  state: UIState
  adding: boolean
  setAdding: (v: boolean) => void
  openMenu: (menu: MenuState) => void
  menuFor: (ext: ExtensionInfo, anchor: Rect) => MenuState
  openDetails: (id: string) => void
}): JSX.Element {
  const extensions = state.extensions
  const empty = extensions.length === 0
  const headerMenu = (anchor: Rect): MenuState => ({
    anchor,
    title: 'Extensions',
    items: [
      {
        id: 'file',
        label: 'Install from file',
        icon: Package,
        onSelect: () => run('extension.installFromFile', undefined)
      },
      {
        id: 'unpacked',
        label: 'Load unpacked',
        icon: FolderOpen,
        onSelect: () => run('extension.add', undefined)
      },
      {
        id: 'updates',
        label: 'Check for updates',
        icon: RefreshCw,
        disabled: empty,
        onSelect: () => run('extension.checkForUpdates', undefined)
      }
    ]
  })
  return (
    <>
      <header className="zen-ext-header">
        <h3 className="zen-ext-title">Extensions</h3>
        {!empty && !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Store className="h-4 w-4" /> Add from store
          </Button>
        )}
        <button
          type="button"
          className="zen-toolbar-button"
          title="More"
          aria-label="More actions"
          aria-haspopup="menu"
          onClick={(e) => openMenu(headerMenu(anchorOf(e.currentTarget)))}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </header>
      {adding && <AddFromStore onDone={() => setAdding(false)} />}
      {!empty && <UpdateCaption state={state} />}
      {empty ? (
        <EmptyState onAdd={() => setAdding(true)} adding={adding} />
      ) : (
        <ul className="zen-settings-rows">
          {extensions.map((ext) => (
            <ExtensionRow
              key={ext.id}
              ext={ext}
              onOpen={() => openDetails(ext.id)}
              onMenu={(anchor) => openMenu(menuFor(ext, anchor))}
            />
          ))}
        </ul>
      )}
    </>
  )
}

/** When updates were last looked for, under the header. */
function UpdateCaption({ state }: { state: UIState }): JSX.Element | null {
  const now = useNow()
  const check = state.extensionUpdates
  const latest = state.extensions.reduce<number | null>((acc, e) => {
    const t = e.updateCheckedAt ?? null
    return t !== null && (acc === null || t > acc) ? t : acc
  }, check?.lastCheckedAt ?? null)
  const text = check?.checking
    ? 'Checking for updates…'
    : latest !== null
      ? `Checked for updates ${relativeTime(latest, now)}`
      : 'Updates have not been checked yet'
  return <p className="zen-ext-caption -mt-3">{text}</p>
}

/** The field the primary action reveals: a store link or an id, Enter installs, Escape hides. */
function AddFromStore({ onDone }: { onDone: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const parsed = parseStoreInput(text)
  const submit = (): void => {
    if (!parsed) {
      setInvalid(text.trim().length > 0)
      return
    }
    run('extension.installFromStore', { ref: parsed.ref, store: parsed.store })
    setText('')
    onDone()
  }
  return (
    <div className="flex flex-col gap-1.5 px-2.5">
      <div className="flex items-center gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Store className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--zen-muted)]" />
          <Input
            ref={ref}
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Chrome Web Store or Edge Add-ons link, or an extension id"
            className="pl-8"
            aria-label="Store link or extension id"
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              setText(e.target.value)
              setInvalid(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                e.stopPropagation()
                onDone()
              }
            }}
          />
        </div>
        <Button size="sm" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={!parsed} onClick={submit}>
          Add
        </Button>
      </div>
      {invalid && (
        <p className="flex items-center gap-1.5 px-0.5 text-[11.5px] text-[var(--zen-danger)]">
          <Info className="h-3.5 w-3.5" />
          That is not a store link or a 32-letter extension id
        </p>
      )}
    </div>
  )
}

function EmptyState({ onAdd, adding }: { onAdd: () => void; adding: boolean }): JSX.Element {
  return (
    <div className="zen-ext-empty">
      <Puzzle className="h-6 w-6" strokeWidth={1.5} />
      <p>Extensions you add show up here, in every space.</p>
      {!adding && (
        <Button onClick={onAdd}>
          <Store className="h-4 w-4" /> Add from store
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ExtensionRow({
  ext,
  onOpen,
  onMenu
}: {
  ext: ExtensionInfo
  onOpen: () => void
  onMenu: (anchor: Rect) => void
}): JSX.Element {
  const mv2 = ext.manifestVersion === 2
  const disabledLook = !ext.enabled && !ext.error
  return (
    <li className="zen-settings-row zen-ext-row" data-disabled={disabledLook || undefined}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onOpen}
        aria-label={`${ext.name}, details`}
      >
        <ExtensionIcon icon={ext.icon} className="zen-ext-fade" />
        <span className="min-w-0 flex-1">
          <span className="zen-ext-name zen-ext-fade block truncate">{ext.name || ext.id}</span>
          <span
            className={cn('zen-ext-sub block truncate', ext.error && 'text-[var(--zen-danger)]')}
            title={ext.error ?? undefined}
          >
            {ext.error ?? versionAndSource(ext.version, ext.source)}
          </span>
          {mv2 && !ext.error && (
            <span className="zen-ext-caption-warn block truncate">
              Manifest V2 extensions are being retired
            </span>
          )}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {ext.updateState === 'available' && (
          <button
            type="button"
            className="zen-ext-chip"
            title={ext.availableVersion ? `Update to ${ext.availableVersion}` : 'Update'}
            onClick={() => run('extension.update', { id: ext.id })}
          >
            Update
          </button>
        )}
        {ext.updateState === 'updating' && (
          <RotateCw className="zen-spin h-4 w-4 text-[var(--zen-muted)]" />
        )}
        <Switch
          checked={ext.enabled}
          aria-label={`${ext.name} enabled`}
          onCheckedChange={(v) => run('extension.setEnabled', { id: ext.id, enabled: v })}
        />
        <button
          type="button"
          className="zen-toolbar-button"
          title="More"
          aria-label={`${ext.name}, more actions`}
          aria-haspopup="menu"
          onClick={(e) => onMenu(anchorOf(e.currentTarget))}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </div>
    </li>
  )
}

/** The row's overflow menu; also the details header's. */
function rowMenu(
  ext: ExtensionInfo,
  anchor: Rect,
  openDetails: (id: string) => void,
  closeDetails: () => void
): MenuState {
  const items: LocalMenuEntry[] = []
  if (ext.optionsPage && ext.enabled && !ext.error) {
    items.push({
      id: 'options',
      label: 'Options',
      icon: SlidersHorizontal,
      onSelect: () => run('extension.openOptions', { id: ext.id })
    })
  }
  items.push({
    id: 'pin',
    label: ext.pinned ? 'Unpin from toolbar' : 'Pin to toolbar',
    icon: ext.pinned ? PinOff : Pin,
    disabled: Boolean(ext.error),
    onSelect: () => run('extension.setPinned', { id: ext.id, pinned: !ext.pinned })
  })
  items.push({
    id: 'details',
    label: 'Details',
    icon: Info,
    onSelect: () => openDetails(ext.id)
  })
  if (ext.source === 'unpacked' || ext.source === undefined) {
    items.push({
      id: 'reload',
      label: 'Reload',
      icon: RefreshCw,
      disabled: !ext.enabled,
      onSelect: () => run('extension.reload', { id: ext.id })
    })
  }
  items.push({ id: 'sep', type: 'separator' })
  items.push({
    id: 'remove',
    label: 'Remove',
    icon: Trash2,
    danger: true,
    onSelect: () => {
      closeDetails()
      run('extension.remove', { id: ext.id })
    }
  })
  return { anchor, title: ext.name, items }
}
