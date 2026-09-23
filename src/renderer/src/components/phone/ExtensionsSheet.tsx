import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Puzzle, Trash2 } from 'lucide-react'
import type { ExtensionInfo, MenuItemDescriptor, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { manageExtension } from '@renderer/lib/extensions/manage'
import {
  actionMenuCommand,
  actionMenuGroups,
  actionSheetRows,
  actionTapCommand,
  isOwnMenuItem,
  ownMenuCommand,
  removeConfirm,
  type ActionMenuItemId,
  type ActionSheetRow
} from '@renderer/lib/extensions/phoneActions'
import { cn } from '@renderer/lib/utils'
import { openSettings } from '@renderer/lib/pages'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, closeExtensionsSheet, uiStore } from '@renderer/lib/ui'
import { ExtensionIcon } from '../extensions/ExtensionIcon'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneEmptyNote, PhoneListRow } from './PhoneList'
import { noteSheetOpener } from './phonePanel'
import { PhoneSheet } from './PhoneSheet'

/**
 * The app menu's Extensions row on a phone (`extensions.open`): the extensions' actions as a
 * §9.13 sheet on the frame's dialog host – one 44 px row per enabled extension with an action,
 * its 20 px icon, its name and Chrome's badge text as a trailing badge in the action's colours
 * (`lib/extensions/phoneActions.ts` is the model; the desktop draws the same actions as toolbar
 * buttons and the puzzle panel's rows). A tap is the action click through the one command path
 * the desktop button takes (`extension.openPopup`: the runtime opens the popup sheet, or fires
 * `action.onClicked` when the action has none) and the sheet closes as it goes out; a hold opens
 * Chrome's action context menu as a menu sheet over this one – the extension's own items first,
 * then the browser's (§9.24: depth two, and its Remove asks in a confirmation that takes the
 * menu's place). The last group is the way to the
 * management page, Settings › Extensions; with nothing to list the sheet says so (§9.17) and
 * offers the install step. The phone bar gets no puzzle button: this row is the entry.
 */
export function ExtensionsSheetLayer(): JSX.Element | null {
  const open = uiStore.use((s) => s.extensionsSheetOpen)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <ExtensionsSheet state={state} />
}

/** The sheet a row's hold opened over this one; `remove` takes the menu's place once it has gone. */
type Stacked = { kind: 'menu'; id: string } | { kind: 'remove'; id: string }

function ExtensionsSheet({ state }: { state: UIState }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [stacked, setStacked] = useState<Stacked | null>(null)
  const rows = actionSheetRows(state.extensions)
  const tabId = activeTab(state)?.id ?? null
  // The extension a stacked sheet is about; one removed meanwhile leaves the sheet nothing to say.
  const subject: ExtensionInfo | null = stacked
    ? (state.extensions.find((ext) => ext.id === stacked.id) ?? null)
    : null

  const leaveTo = (after: () => void): void => sheet.current?.dismiss(after)
  const tap = (row: ActionSheetRow, el: HTMLElement): void => {
    // The row's box, plain (the command crosses the bridge); the runtime's popup is a sheet of
    // its own and only the desktop's popover reads the anchor.
    const box = el.getBoundingClientRect()
    const command = actionTapCommand(row, {
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height
    })
    if (!command) return
    // The popup sheet comes up as this one goes down.
    run(command.name, command.args)
    sheet.current?.dismiss()
  }
  const menuPick = (id: ActionMenuItemId, extensionId: string): void => {
    switch (id) {
      case 'options': {
        const command = actionMenuCommand('options', extensionId)
        leaveTo(() => run(command.name, command.args))
        return
      }
      case 'remove':
        setStacked({ kind: 'remove', id: extensionId })
        return
      case 'manage':
        leaveTo(() => manageExtension(extensionId, tabId))
        return
    }
  }
  // One of the extension's own items: the pick goes to the core, which fires the extension's
  // `contextMenus.onClicked` against the active tab – the page under this sheet, which leaves
  // too so what the extension does to that page is in view (as Chrome's menu goes with a pick).
  const ownPick = (item: MenuItemDescriptor, extensionId: string): void => {
    const command = ownMenuCommand(extensionId, item)
    if (!command) return
    leaveTo(() => run(command.name, command.args))
  }

  return (
    <>
      <PhoneSheet
        name="extensions"
        title={{ pose: 'header', text: 'Extensions' }}
        // A list sheet opens on its first row (§9.22) and stands at most 80 % of the frame (§9.20).
        focus="first"
        body="list"
        onClose={closeExtensionsSheet}
        sheetRef={sheet}
        contentKey={rows.map((row) => `${row.id}:${row.badge}`).join('/')}
      >
        <div className="zen-phone-list zen-ext-phone-sheet pb-2">
          {rows.length === 0 ? (
            <PhoneEmptyNote
              action={{
                label: 'Install an extension',
                onSelect: () => leaveTo(() => openSettings('extensions'))
              }}
            >
              No extensions with a toolbar action
            </PhoneEmptyNote>
          ) : (
            rows.map((row) => (
              <ActionRow
                key={row.id}
                row={row}
                onTap={(el) => tap(row, el)}
                onHold={() => {
                  noteSheetOpener()
                  setStacked({ kind: 'menu', id: row.id })
                }}
              />
            ))
          )}
          <div className="zen-sheet-sep" aria-hidden />
          <PhoneListRow
            icon={<Puzzle className="h-5 w-5" strokeWidth={1.75} />}
            title="Manage extensions"
            trailing={
              <span className="flex h-11 w-11 shrink-0 items-center justify-center" aria-hidden>
                <ChevronRight className="h-5 w-5 opacity-60" strokeWidth={1.75} />
              </span>
            }
            onTap={() => leaveTo(() => openSettings('extensions'))}
          />
        </div>
      </PhoneSheet>
      {stacked?.kind === 'menu' && subject && (
        <ActionMenuSheet
          ext={subject}
          onPick={(id) => menuPick(id, subject.id)}
          onOwnPick={(item) => ownPick(item, subject.id)}
          onClose={() => setStacked((s) => (s?.kind === 'menu' ? null : s))}
        />
      )}
      {stacked?.kind === 'remove' && subject && (
        <RemoveSheet
          ext={subject}
          onConfirm={() => {
            const command = actionMenuCommand('remove', subject.id)
            run(command.name, command.args)
          }}
          onClose={() => setStacked(null)}
        />
      )}
    </>
  )
}

/**
 * One action: the icon in the leading box, the name, the badge trailing in the extension's
 * colours – or, when it set none, the sheet's accent (§9.29). An action the extension turned off
 * for this tab keeps its row at the disabled number and takes no tap (§9.30); its hold still
 * opens the menu, as the desktop button's right click does.
 */
function ActionRow({
  row,
  onTap,
  onHold
}: {
  row: ActionSheetRow
  onTap: (el: HTMLElement) => void
  onHold: () => void
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const label = row.badge ? `${row.name}, badge ${row.badge}` : row.name
  return (
    <div ref={box}>
      <PhoneListRow
        icon={<ExtensionIcon icon={row.icon} size={20} box={20} />}
        title={row.name}
        ariaLabel={row.title !== row.name ? `${row.title}, ${label}` : label}
        disabled={!row.enabled}
        trailing={
          row.badge ? (
            <span
              className="zen-ext-phone-badge"
              style={
                row.badgeColours
                  ? { background: row.badgeColours.background, color: row.badgeColours.color }
                  : undefined
              }
              aria-hidden
            >
              {row.badge}
            </span>
          ) : undefined
        }
        onTap={() => {
          if (box.current) onTap(box.current)
        }}
        onLongPress={onHold}
      />
    </div>
  )
}

/**
 * The extension's own action-context `contextMenus` items, asked of the core as the menu opens
 * (`extension.actionMenuItems`); empty until they arrive and for an extension that adds none.
 * The request is what keeps the handles the picks hand back alive, so it is made once per menu.
 */
function useOwnMenuItems(extensionId: string): MenuItemDescriptor[] {
  const [items, setItems] = useState<MenuItemDescriptor[]>([])
  useEffect(() => {
    let live = true
    cmd('extension.actionMenuItems', { id: extensionId })
      .then((own) => {
        if (live) setItems(own)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [extensionId])
  return items
}

/**
 * Chrome's action context menu for the phone, as a §9.13 menu sheet over the list: the 48 header
 * carries the extension's name (the row's label), then 44 px items in groups a hairline tells
 * apart, in Chrome's order – the extension's own `contextMenus` items for its action first
 * (check states drawn, a submenu drilled into as the menu sheet does), then Options when the
 * manifest names an options page and Manage Extension, and Remove from Zenium last, alone under
 * its hairline in the danger ink (§10.4). A pick closes the menu first and runs once it has
 * gone (§9.24: the lower sheet comes back, or leaves too).
 */
function ActionMenuSheet({
  ext,
  onPick,
  onOwnPick,
  onClose
}: {
  ext: ExtensionInfo
  onPick: (id: ActionMenuItemId) => void
  onOwnPick: (item: MenuItemDescriptor) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const own = useOwnMenuItems(ext.id)
  // The submenu path the menu has drilled into among the extension's items (`MenuSheet`'s
  // pattern): the header names the submenu and a Back control leads out.
  const [path, setPath] = useState<MenuItemDescriptor[]>([])
  const inside = path.length ? path[path.length - 1] : null
  const groups = inside
    ? actionMenuGroups({ optionsPage: null }, inside.submenu ?? []).filter((g) => g.kind === 'own')
    : actionMenuGroups(ext, own)
  const name = ext.name || ext.id
  return (
    <PhoneSheet
      name="extensions-action-menu"
      title={{
        pose: 'header',
        text: inside ? inside.label : name,
        leading: inside ? (
          <button
            type="button"
            className="zen-sheet-header-control"
            data-side="leading"
            onClick={() => setPath((p) => p.slice(0, -1))}
            aria-label="Back"
          >
            <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
          </button>
        ) : undefined
      }}
      focus="first"
      onClose={onClose}
      sheetRef={sheet}
      contentKey={`${own.length}:${path.map((item) => item.id).join('/')}`}
    >
      <div className="zen-ext-action-menu flex flex-col pb-2">
        {groups.map((group, index) => (
          <ul key={index} className="flex flex-col">
            {index > 0 && <li aria-hidden className="zen-sheet-sep" />}
            {group.items.map((item) =>
              isOwnMenuItem(item) ? (
                <li key={item.id}>
                  <button
                    type="button"
                    className="zen-sheet-item"
                    disabled={!item.enabled}
                    aria-checked={
                      item.type === 'checkbox' || item.type === 'radio' ? item.checked : undefined
                    }
                    role={
                      item.type === 'checkbox'
                        ? 'menuitemcheckbox'
                        : item.type === 'radio'
                          ? 'menuitemradio'
                          : undefined
                    }
                    onClick={() => {
                      if (item.submenu) setPath((p) => [...p, item])
                      else sheet.current?.dismiss(() => onOwnPick(item))
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {(item.type === 'checkbox' || item.type === 'radio') && item.checked && (
                      <Check className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
                    )}
                    {item.submenu && (
                      <ChevronRight
                        className={cn('zen-sheet-item-secondary h-5 w-5 shrink-0')}
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    )}
                  </button>
                </li>
              ) : (
                <li key={item.id}>
                  <button
                    type="button"
                    className="zen-sheet-item"
                    data-danger={item.danger}
                    onClick={() => sheet.current?.dismiss(() => onPick(item.id))}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                </li>
              )
            )}
          </ul>
        ))}
      </div>
    </PhoneSheet>
  )
}

/**
 * The menu's Remove asks first (§10.4, the wording of Settings › Extensions' Remove row): a prompt
 * sheet in the menu's place – title block with the glyph, the one paragraph, the §9.11 footer –
 * whose Remove, in the danger ink, runs once the sheet is gone; Cancel, the scrim, Escape and the
 * back gesture keep the extension. The focus starts on the sheet itself (§9.22: a title-and-notice
 * sheet holds its container; Cancel first is the failure the section names), so a stray Enter
 * does no harm.
 */
function RemoveSheet({
  ext,
  onConfirm,
  onClose
}: {
  ext: ExtensionInfo
  onConfirm: () => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const confirm = removeConfirm(ext)
  return (
    <PhoneSheet
      name="extensions-remove"
      title={{
        pose: 'block',
        text: confirm.title,
        icon: <Trash2 className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: confirm.description
      }}
      // A title-and-notice sheet holds the focus on its container (§9.22), never on Cancel.
      focus="dialog"
      onClose={onClose}
      handleLabel="Dismiss"
      sheetRef={sheet}
    >
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
          Cancel
        </button>
        <button
          type="button"
          className="zen-v2-button"
          data-danger
          onClick={() => sheet.current?.dismiss(onConfirm)}
        >
          {confirm.action}
        </button>
      </div>
    </PhoneSheet>
  )
}
