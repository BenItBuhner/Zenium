import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Tab, UIState } from '@shared/types'
import { SPACE_ICONS } from '@shared/defaults'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { FrameDialogHost, useFrameDialog } from '@renderer/lib/portals'
import { activeTab, tabTitle } from '@renderer/lib/selectors'
import { uiStore, type UiState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { AutofillEditor } from './autofill/AutofillEditor'
import { AutofillPrompts } from './autofill/AutofillPrompts'
import { LeakWarnings } from './autofill/LeakWarning'
import { PassphraseDialog } from './autofill/PassphraseDialog'
import { ExtensionPromptDialog } from './extensions/ExtensionPromptDialog'
import { ClearBrowsingDataDialog } from './siteControls/ClearBrowsingDataDialog'
import { ImportDialog } from './import/ImportDialog'
import { PermissionPrompts } from './siteControls/PermissionPromptBubble'
import { PageDialogs } from './dialogs/PageDialog'
import { WindowPromptDialog } from './dialogs/WindowPromptDialog'
import { BlockedPopupsPanel } from './security/BlockedPopupsPanel'
import { SecurityPrompts } from './security/SecurityPromptDialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { BookmarkAllTabsDialog } from './bookmarks/BookmarkAllTabsDialog'
import { CaptureLayer } from './capture/CaptureOverlay'
import { EditBookmarkDialog } from './bookmarks/EditBookmarkDialog'
import { InstallDialogLayer } from './install/InstallDialog'
import { StarDialog } from './bookmarks/StarDialog'
import { NewTabShortcutDialog } from './newtab/NewTabShortcutDialog'
import { BookmarkEditSheet } from './phone/BookmarkEditSheet'
import { InstallLayer } from './phone/InstallSheet'
import { LongScreenshotLayer } from './phone/LongScreenshotSheet'
import { PrintPreviewDialog } from './print/PrintPreviewDialog'
import { MediaLayer } from './phone/MediaSheet'
import { ScreenPickerLayer } from './screenCapture/ScreenPicker'
import { ShareLayer } from './share/SharePopover'
import { FolderDeleteDialog } from './sidebar/FolderDeleteDialog'
import { SiteDataConfirmDialog } from './siteinfo/SiteInfoSheet'
import { ZoomBubble } from './zoom/ZoomBubble'
import { ReaderPreferencesPanel } from './reader/ReaderPreferencesPanel'

const TAB_ICONS = [
  ...SPACE_ICONS,
  '📧',
  '📅',
  '📊',
  '🗂️',
  '🎬',
  '🛠️',
  '🧠',
  '🌐',
  '📌',
  '🔔',
  '🎧',
  '🏷️'
]

/**
 * Small dialogs shown by every layout: the star bubble, "Bookmark all tabs", the bookmark or
 * folder edit (the bookmarks manager page renames a folder in view in place and lets every
 * other request through to this dialog), the pinned-URL editor
 * and the icon picker, the security prompts (HTTP sign-in, certificate choice) the page's
 * requests wait on, the permission prompts a page's requests wait on, the screen-capture picker
 * a page's `getDisplayMedia` waits on, the page's own dialogs
 * (`alert`, `confirm`, `prompt`, "Leave site?"), the questions asked before a window closes or
 * Zenium quits, the new tab page's add / edit shortcut dialog, the extension install and
 * permission prompts, the site-information popover's "Clear site data?" confirmation, the
 * sidebar's "Delete <folder>?" prompt, the Clear browsing data dialog Settings opens on a mouse, the sign-in leak warning ("Change your
 * password", `LeakWarnings`), the autofill prompts (save / update a login,
 * save an address or a card, choose a passkey account), the address and card editors of
 * Settings > Autofill, the vault passphrase asked for by a re-authenticated command run from
 * the chrome, the print preview (Chrome's constrained window at the frame's size), the
 * desktop's Web capture overlay (`CaptureLayer`: the dimmed page with the marquee, then the
 * result card) and, on
 * phones, the media sheet the pill's Now playing chip opens (`MediaSheet`) and the long-screenshot
 * editor the screenshot card's Capture more opens (`LongScreenshotSheet`). The modal ones
 * render through the `FrameDialogHost` this mounts, so they centre
 * in the box it is placed in – the content frame on desktop, the shell on phones – over a scrim
 * that dims only that box (lib/portals.tsx). The star bubble is a popover: on desktop it portals
 * to the chrome layer, anchored under the star; on phones it is a sheet in the host. The zoom
 * bubble is a desktop popover too, under the pill's zoom chip, and so are the blocked pop-ups
 * list under its chip and Reader View's text preferences under theirs (sheets on phones). This is the frame's host: a dialog whose state lives
 * inside the frame (a phone panel's sheets, the new tab page's customise sheet) reaches it
 * through `FrameDialogPortal`.
 */
export function TabDialogs({ state }: { state: UIState }): JSX.Element {
  const pinnedTabId = uiStore.use((s) => s.editingPinnedUrlTabId)
  const iconTabId = uiStore.use((s) => s.iconPickerTabId)
  const star = uiStore.use((s) => s.starDialog)
  const zoom = uiStore.use((s) => s.zoomBubble)
  const readerPrefs = uiStore.use((s) => s.readerPreferences)
  const allTabs = uiStore.use((s) => s.bookmarkAllTabs)
  const edit = uiStore.use((s) => s.bookmarkEdit)
  const shortcut = uiStore.use((s) => s.newTabShortcutDialog)
  const siteData = uiStore.use((s) => s.siteDataConfirm)
  const folderDelete = uiStore.use((s) => s.folderDeleteConfirm)
  const phone = useViewport().formFactor === 'phone'
  const popups = uiStore.use((s) => s.blockedPopupsPanel)
  const pinnedTab = pinnedTabId ? state.tabs[pinnedTabId] : undefined
  const iconTab = iconTabId ? state.tabs[iconTabId] : undefined
  return (
    <FrameDialogHost frame>
      <BookmarkDialog
        state={state}
        star={star}
        allTabs={allTabs}
        edit={edit}
        phone={phone}
        pinnedTab={pinnedTab}
        iconTab={iconTab}
      />
      {shortcut && (
        <NewTabShortcutDialog key={shortcut.id ?? 'new'} state={state} request={shortcut} />
      )}
      {siteData && (
        <SiteDataConfirmDialog
          key={`${siteData.tabId}:${siteData.kind}`}
          state={state}
          request={siteData}
        />
      )}
      {folderDelete && (
        <FolderDeleteDialog key={folderDelete.folderId} state={state} request={folderDelete} />
      )}
      {popups && <BlockedPopupsPanel state={state} panel={popups} />}
      <SecurityPrompts state={state} />
      <PermissionPrompts state={state} />
      <PageDialogs state={state} />
      <WindowPromptDialog state={state} />
      <ExtensionPromptDialog />
      <ClearBrowsingDataDialog />
      <ImportDialog state={state} />
      <PrintPreviewDialog state={state} />
      {zoom && <ZoomBubble state={state} bubble={zoom} />}
      {readerPrefs && (
        <ReaderPreferencesPanel key={readerPrefs.tabId} state={state} panel={readerPrefs} />
      )}
      <InstallLayer state={state} />
      {phone && <MediaLayer state={state} />}
      <LongScreenshotLayer />
      <InstallDialogLayer state={state} />
      <ScreenPickerLayer state={state} />
      <CaptureLayer />
      <ShareLayer state={state} />
      <LeakWarnings state={state} />
      <AutofillPrompts state={state} />
      <AutofillEditor state={state} />
      <PassphraseDialog />
    </FrameDialogHost>
  )
}

function BookmarkDialog({
  state,
  star,
  allTabs,
  edit,
  phone,
  pinnedTab,
  iconTab
}: {
  state: UIState
  star: UiState['starDialog']
  allTabs: UiState['bookmarkAllTabs']
  edit: UiState['bookmarkEdit']
  phone: boolean
  pinnedTab: Tab | undefined
  iconTab: Tab | undefined
}): JSX.Element | null {
  if (star) return <StarDialog key={star.nodeId} state={state} star={star} />
  if (allTabs) return <BookmarkAllTabsDialog state={state} request={allTabs} />
  // On a phone every edit – from the star's toast, a panel row's menu, the core's menus – is the
  // one sheet, over the panel too (the phone panel hosts no editor of its own).
  if (edit && phone) {
    return <BookmarkEditSheet key={`${edit.id ?? 'new'}:${edit.type}`} state={state} edit={edit} />
  }
  if (edit) {
    // "Add page…" on the bar starts from the page on screen, like Chrome.
    const tab = edit.id === null && edit.type === 'url' ? activeTab(state) : null
    const prefill =
      tab && tab.url && !tab.url.startsWith('zen://')
        ? { title: tabTitle(tab), url: tab.url }
        : null
    return (
      <EditBookmarkDialog
        key={edit.id ?? `new-${edit.type}`}
        state={state}
        edit={edit}
        prefill={prefill}
      />
    )
  }
  if (pinnedTab) return <PinnedUrlDialog tab={pinnedTab} />
  if (iconTab) return <IconPickerDialog tab={iconTab} />
  return null
}

/** The panel of a small frame dialog: the host's scrim and Escape both close it. */
function Backdrop({
  onClose,
  children
}: {
  onClose: () => void
  children: React.ReactNode
}): JSX.Element {
  useFrameDialog({ onScrimPress: onClose })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="zen-panel zen-animate-pop w-[420px] max-w-[calc(100%-32px)] p-4">
      {children}
    </div>
  )
}

/** Zen 1.21.4 "Edit pinned tab": set the URL a pinned tab resets to. */
function PinnedUrlDialog({ tab }: { tab: UIState['tabs'][string] }): JSX.Element {
  const [value, setValue] = useState(tab.pinnedUrl ?? tab.url)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const close = (): void => uiStore.set({ editingPinnedUrlTabId: null })
  const url = inputToUrl(value)
  const save = (): void => {
    if (!url) return
    run('tab.editPinnedUrl', { tabId: tab.id, url })
    close()
  }
  return (
    <Backdrop onClose={close}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div>
          <h2 className="text-[14px] font-semibold">Edit pinned tab</h2>
          <p className="text-[12px] text-[var(--zen-muted)]">
            The URL this tab returns to when it is reset or closed.
          </p>
        </div>
        <Input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />
        <div className="flex justify-end gap-2">
          {tab.url !== tab.pinnedUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() => setValue(tab.url)}
            >
              Use current URL
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!url}>
            Save
          </Button>
        </div>
      </form>
    </Backdrop>
  )
}

/** Zen's icon picker for tabs: pick an emoji or return to the favicon. */
function IconPickerDialog({ tab }: { tab: UIState['tabs'][string] }): JSX.Element {
  const [custom, setCustom] = useState('')
  const close = (): void => uiStore.set({ iconPickerTabId: null })
  const pick = (icon: string | null): void => {
    run('tab.setIcon', { tabId: tab.id, icon })
    close()
  }
  return (
    <Backdrop onClose={close}>
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-[14px] font-semibold">Change icon</h2>
          <p className="truncate text-[12px] text-[var(--zen-muted)]">
            {tab.customTitle ?? tab.title}
          </p>
        </div>
        <div className="grid grid-cols-9 gap-1">
          <button
            type="button"
            className={cn(
              'zen-squircle flex h-9 items-center justify-center rounded-lg text-[11px] hover:bg-[var(--zen-element-bg)]',
              !tab.customIcon && 'bg-[var(--zen-element-bg-active)]'
            )}
            title="Use the site's favicon"
            onClick={() => pick(null)}
          >
            Auto
          </button>
          {TAB_ICONS.map((e) => (
            <button
              key={e}
              type="button"
              className={cn(
                'zen-squircle flex h-9 items-center justify-center rounded-lg text-lg hover:bg-[var(--zen-element-bg)]',
                tab.customIcon === e && 'bg-[var(--zen-element-bg-active)]'
              )}
              onClick={() => pick(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={custom}
            placeholder="Or type any emoji"
            maxLength={4}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && custom.trim() && pick(custom.trim())}
          />
          <Button size="sm" disabled={!custom.trim()} onClick={() => pick(custom.trim())}>
            Use
          </Button>
        </div>
      </div>
    </Backdrop>
  )
}
