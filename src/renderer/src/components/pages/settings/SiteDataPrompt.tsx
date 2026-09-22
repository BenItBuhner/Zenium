import type { JSX } from 'react'
import { SheetActions } from './blocks'
import { SettingsDialog } from './dialogs'
import { SettingsSheet } from './sheets'
import { useSheetDismiss } from './sheetContext'

/**
 * A site-data clear's confirmation (§9.20, §9.23): the question as the title block over its one
 * paragraph, Cancel | the clear as §9.11 peers with the destructive one trailing, and nothing
 * else – so it is §9.20's notice, 320 wide on the desktop (the #322 ruling (c): a confirmation
 * takes 400 only when it carries a row or a field), a sheet on the phone. The container takes
 * the focus as it opens, named by the title and described by the paragraph (§9.22: a
 * title-and-notice surface focuses itself; landing on Cancel would announce the way out first).
 * `host` says which chassis draws it: the phone page's prompts are sheets over the page or over
 * the item sheet (§9.24: depth two from a page), the desktop viewer's are dialogs over its
 * dialog, which the dialog chassis covers (`SheetCoveredContext`).
 */
export function SiteDataPrompt({
  host,
  name,
  title,
  description,
  action,
  close,
  confirm
}: {
  host: 'sheet' | 'dialog'
  /** The prompt's name in the back registry and the harness (`settings-confirm:<name>`, `confirm:<name>`). */
  name: string
  title: string
  description: string
  /** The destructive button's label. */
  action: string
  close: () => void
  confirm: () => void
}): JSX.Element {
  if (host === 'sheet')
    return (
      <SettingsSheet
        name={`settings-confirm:${name}`}
        title={title}
        description={description}
        under={false}
        focus="dialog"
        onClose={close}
      >
        <PromptActions action={action} confirm={confirm} />
      </SettingsSheet>
    )
  return (
    <SettingsDialog
      name={`confirm:${name}`}
      title={title}
      description={description}
      under={false}
      width="notice"
      initial={(root) => root}
      onClose={close}
      className="zen-settings-dialog-prompt"
    >
      <PromptActions action={action} confirm={confirm} />
    </SettingsDialog>
  )
}

/** The prompt's pair, through the prompt's own dismiss: the sheet leaves with its motion first. */
function PromptActions({ action, confirm }: { action: string; confirm: () => void }): JSX.Element {
  const dismiss = useSheetDismiss()
  return (
    <SheetActions
      action={action}
      destructive
      onCancel={() => dismiss()}
      onAction={() => dismiss(confirm)}
    />
  )
}
