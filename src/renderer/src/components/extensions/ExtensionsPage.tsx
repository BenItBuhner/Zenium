import type { DragEvent, JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import {
  Ellipsis,
  FolderOpen,
  Info,
  Package,
  Pin,
  PinOff,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  Store,
  Trash2
} from 'lucide-react'
import type { ExtensionInfo, UIState } from '@shared/types'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { relativeTime } from '@renderer/lib/extensions/format'
import { parseStoreInput, versionAndSource } from '@renderer/lib/extensions/storeInput'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { LocalMenu, type LocalMenuEntry } from '../menus/LocalMenu'
import { ExtensionDetails } from './ExtensionDetails'
import { ExtensionIcon } from './ExtensionIcon'
import { PageHeader } from './PageHeader'
import { useNow } from './useNow'
import { V2Button, V2Field, V2FormField, V2IconButton, V2Switch } from './v2'

interface MenuState {
  anchor: Anchor
  title?: string
  items: LocalMenuEntry[]
}

/**
 * The Extensions tab of Add-ons and Themes, an in-content page to the v2 draft: the page
 * colour, a 22/600 header whose hairline appears once the list scrolls under it (§9.7), one
 * bordered card per extension (Zen's add-on cards, §6), and a details level that pushes in.
 * Dropping a `.crx` or `.zip` (or an unpacked folder) anywhere on the page installs it (§9.4).
 */
export function ExtensionsPage({
  state,
  embedded = false
}: {
  state: UIState
  /** Inside another page's column (Settings → Extensions): no page colour, no own scrolling. */
  embedded?: boolean
}): JSX.Element {
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropping, setDropping] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const extensions = state.extensions
  // An extension removed underneath its details level takes the level with it.
  const details = detailsId ? extensions.find((e) => e.id === detailsId) : undefined
  const menuFor = (ext: ExtensionInfo, anchor: Anchor): MenuState =>
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
      className={cn('zen-v2 relative flex min-w-0 flex-1 flex-col', !embedded && 'zen-v2-page')}
      data-surface="page"
      data-embedded={embedded || undefined}
      data-dropping={dropping || undefined}
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={cn('min-h-0 flex-1', !embedded && 'overflow-y-auto')}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {details ? (
          <ExtensionDetails
            ext={details}
            scrolled={scrolled}
            onBack={() => setDetailsId(null)}
            onMenu={(anchor) => setMenu(menuFor(details, anchor))}
          />
        ) : (
          <ExtensionList
            state={state}
            scrolled={scrolled}
            adding={adding}
            setAdding={setAdding}
            openMenu={setMenu}
            menuFor={menuFor}
            openDetails={setDetailsId}
          />
        )}
      </div>
      {dropping && (
        <div className="zen-ext-drop zen-v2-fade">
          <Package />
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
  scrolled,
  adding,
  setAdding,
  openMenu,
  menuFor,
  openDetails
}: {
  state: UIState
  scrolled: boolean
  adding: boolean
  setAdding: (v: boolean) => void
  openMenu: (menu: MenuState) => void
  menuFor: (ext: ExtensionInfo, anchor: Anchor) => MenuState
  openDetails: (id: string) => void
}): JSX.Element {
  const extensions = state.extensions
  const empty = extensions.length === 0
  const headerMenu = (anchor: Anchor): MenuState => ({
    anchor,
    title: 'Extensions',
    items: [
      {
        id: 'file',
        label: 'Install from File',
        icon: Package,
        onSelect: () => run('extension.installFromFile', undefined)
      },
      {
        id: 'unpacked',
        label: 'Load Unpacked',
        icon: FolderOpen,
        onSelect: () => run('extension.add', undefined)
      },
      {
        id: 'updates',
        label: 'Check for Updates',
        icon: RefreshCw,
        disabled: empty,
        onSelect: () => run('extension.checkForUpdates', undefined)
      }
    ]
  })
  return (
    <>
      <PageHeader scrolled={scrolled}>
        <h1 className="zen-v2-title">Extensions</h1>
        {!empty && !adding && (
          <V2Button variant="primary" onClick={() => setAdding(true)}>
            <Store /> Add from store
          </V2Button>
        )}
        <V2IconButton
          icon={Ellipsis}
          label="More actions"
          aria-haspopup="menu"
          onClick={(e) => openMenu(headerMenu(anchorOf(e.currentTarget)))}
        />
      </PageHeader>
      <div className="zen-v2-column flex flex-col gap-4 pb-8">
        {adding && <AddFromStore onDone={() => setAdding(false)} />}
        {!empty && <UpdateCaption state={state} />}
        {empty ? (
          <EmptyState onAdd={() => setAdding(true)} adding={adding} />
        ) : (
          <ul className="zen-ext-list">
            {extensions.map((ext) => (
              <ExtensionCard
                key={ext.id}
                ext={ext}
                onOpen={() => openDetails(ext.id)}
                onMenu={(anchor) => openMenu(menuFor(ext, anchor))}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

/** When updates were last looked for, under the header. */
function UpdateCaption({ state }: { state: UIState }): JSX.Element | null {
  const now = useNow()
  const check = state.extensionUpdates
  const latest = state.extensions.reduce<number | null>((acc, e) => {
    const t = e.updateCheckedAt
    return t !== null && (acc === null || t > acc) ? t : acc
  }, check.lastCheckedAt)
  const text = check.checking
    ? 'Checking for updates…'
    : latest !== null
      ? `Checked for updates ${relativeTime(latest, now)}`
      : 'Updates have not been checked yet'
  return <p className="zen-v2-caption">{text}</p>
}

/**
 * The form the primary action reveals (§9.12): a labelled field for a store link or an ID with
 * an example as its placeholder and a description under it, which the validation text replaces
 * while the value is wrong. Enter installs, Escape hides it.
 */
function AddFromStore({ onDone }: { onDone: () => void }): JSX.Element {
  const id = useId()
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
    <V2FormField
      id={id}
      label="Store link or extension ID"
      description="A Chrome Web Store or Edge Add-ons listing, or the 32-letter ID in its address"
      error={invalid ? 'That is not a store link or a 32-letter extension ID' : undefined}
      actions={
        <>
          <V2Button onClick={onDone}>Cancel</V2Button>
          <V2Button variant="primary" disabled={!parsed} onClick={submit}>
            Add
          </V2Button>
        </>
      }
    >
      {(field) => (
        <V2Field
          ref={ref}
          lead={Store}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="https://chromewebstore.google.com/detail/eimadpbcbfnmbkopoojfekhnkhdbieeh"
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
          {...field}
        />
      )}
    </V2FormField>
  )
}

/**
 * The list's empty state (§9.17): one sentence, no glyph, top-anchored 32 below the header (48
 * on a phone) and centred in a 32 gutter, with the one obvious next step 16 beneath it as a
 * secondary button – never primary, so the header's primary keeps its place once there is a list.
 */
function EmptyState({ onAdd, adding }: { onAdd: () => void; adding: boolean }): JSX.Element {
  return (
    <div className="zen-ext-empty">
      <p>Extensions you add show up here, in every Space</p>
      {!adding && (
        <V2Button onClick={onAdd}>
          <Store /> Add from store
        </V2Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function ExtensionCard({
  ext,
  onOpen,
  onMenu
}: {
  ext: ExtensionInfo
  onOpen: () => void
  onMenu: (anchor: Anchor) => void
}): JSX.Element {
  const mv2 = ext.manifestVersion === 2
  const disabledLook = !ext.enabled && !ext.error
  return (
    <li className="zen-v2-card zen-ext-card" data-disabled={disabledLook || undefined}>
      <button
        type="button"
        className="zen-ext-card-main"
        onClick={onOpen}
        aria-label={`${ext.name}, details`}
      >
        <ExtensionIcon
          icon={ext.icon}
          size={32}
          box={32}
          className="zen-ext-card-icon zen-ext-fade"
        />
        <span className="min-w-0 flex-1">
          <span className="zen-ext-name zen-ext-fade">{ext.name || ext.id}</span>
          <span
            className="zen-ext-sub"
            data-tone={ext.error ? 'danger' : undefined}
            title={ext.error ?? undefined}
          >
            {ext.error ?? versionAndSource(ext.version, ext.source)}
          </span>
          {mv2 && !ext.error && (
            <span className="zen-ext-sub" data-tone="warn">
              Manifest V2 extensions are being retired
            </span>
          )}
        </span>
      </button>
      <div className="zen-ext-card-controls">
        {ext.updateState === 'available' && (
          <V2Button
            className="mr-1"
            title={ext.availableVersion ? `Update to ${ext.availableVersion}` : 'Update'}
            onClick={() => run('extension.update', { id: ext.id })}
          >
            Update
          </V2Button>
        )}
        {ext.updateState === 'updating' && (
          <RotateCw className="zen-spin zen-v2-deemphasized mr-1 h-4 w-4" />
        )}
        <V2Switch
          checked={ext.enabled}
          label={`${ext.name} enabled`}
          onChange={(v) => run('extension.setEnabled', { id: ext.id, enabled: v })}
        />
        <V2IconButton
          icon={Ellipsis}
          label={`${ext.name}, more actions`}
          title="More actions"
          aria-haspopup="menu"
          onClick={(e) => onMenu(anchorOf(e.currentTarget))}
        />
      </div>
    </li>
  )
}

/** The card's overflow menu; also the details header's. Menu items are Title Case (§9.1). */
function rowMenu(
  ext: ExtensionInfo,
  anchor: Anchor,
  openDetails: (id: string) => void,
  closeDetails: () => void
): MenuState {
  const items: LocalMenuEntry[] = []
  if (ext.optionsPage && ext.enabled && !ext.error) {
    items.push({
      id: 'options',
      label: 'Options',
      icon: SlidersHorizontal,
      // The options page opens in a tab; the overlay would hide it (as the Source link does).
      onSelect: () => {
        closeOverlay()
        run('extension.openOptions', { id: ext.id })
      }
    })
  }
  items.push({
    id: 'pin',
    label: ext.toolbarPinned ? 'Unpin from Toolbar' : 'Pin to Toolbar',
    icon: ext.toolbarPinned ? PinOff : Pin,
    disabled: Boolean(ext.error),
    onSelect: () => run('extension.setToolbarPinned', { id: ext.id, pinned: !ext.toolbarPinned })
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
