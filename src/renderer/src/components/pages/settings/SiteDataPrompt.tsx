import type { JSX } from 'react'
import { ConfirmDialog } from '../../dialogs/ConfirmDialog'
import { useCoversSheet } from './sheetContext'
import { ConfirmSheet } from './sheets'

interface SiteDataPromptProps {
  /** The prompt's name in the back registry and the harness (`settings-confirm:<name>`, `confirm:<name>`). */
  name: string
  title: string
  description: string
  /** The destructive button's label. */
  action: string
  close: () => void
  confirm: () => void
}

/**
 * A site-data clear's confirmation (§9.20, §9.23) on the program's prompt primitive: the
 * question as the title block over its one paragraph, Cancel | the clear as §9.11 peers with
 * the destructive one trailing, and nothing else. `host` says which chassis draws it: the
 * phone page's prompts are confirmation sheets (`ConfirmSheet`) over the page or over the item
 * sheet (§9.24: depth two from a page); the desktop viewer's is the `ConfirmDialog` primitive
 * (components/dialogs) over the viewer's dialog – §9.20's 320 notice, whatever it covers (the
 * #322 ruling (c) and the lead's on #392: a confirmation over a dialog is the notice however
 * much it carries) – which stands `inert` under it (`useCoversSheet`: the primitive is no
 * Settings dialog, so the prompt tells its host itself). The keyboard is the primitive's on
 * both hosts (§9.22 as amended on #392): the container takes the focus as the prompt opens,
 * named by the title and described by the paragraph, Tab reaches Cancel then the clear, Escape
 * and the scrim are Cancel and the focus goes back to what opened it – Clear all, or the row.
 * Every clear here is destructive, so the prompt has no default: Enter from the held container
 * is inert.
 */
export function SiteDataPrompt({
  host,
  ...props
}: SiteDataPromptProps & { host: 'sheet' | 'dialog' }): JSX.Element {
  return host === 'sheet' ? <SiteDataPromptSheet {...props} /> : <SiteDataPromptDialog {...props} />
}

/** The phone's form: the sheet leaves with its motion first, then the clear runs (`ConfirmSheet`). */
function SiteDataPromptSheet({
  name,
  title,
  description,
  action,
  close,
  confirm
}: SiteDataPromptProps): JSX.Element {
  return (
    <ConfirmSheet
      name={`settings-confirm:${name}`}
      title={title}
      description={description}
      action={action}
      destructive
      under={false}
      onClose={close}
      onConfirm={confirm}
    />
  )
}

/**
 * The desktop's form: the primitive over the viewer's dialog, which it covers while it stands.
 * The prompt closes first and the clear runs at once (the dialog has no motion to wait for),
 * as the dialog chassis's own dismiss orders it; the way back is the primitive's default – the
 * control that had the focus as the prompt opened, the viewer's Clear all. The `data-dialog`
 * handle the desktop smoke reads (`confirm:<name>`) rides on the root beside the primitive's
 * `data-confirm`.
 */
function SiteDataPromptDialog({
  name,
  title,
  description,
  action,
  close,
  confirm
}: SiteDataPromptProps): JSX.Element {
  useCoversSheet(true)
  return (
    <ConfirmDialog
      name={name}
      title={title}
      description={description}
      action={action}
      destructive
      onCancel={close}
      onConfirm={() => {
        close()
        confirm()
      }}
      data={{ 'data-dialog': `confirm:${name}` }}
    />
  )
}
