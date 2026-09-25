import type { SaveDialogOptions } from 'electron'
import type { SavePageFormat } from '../../shared/types'
import { SAVE_PAGE_FORMAT_SPECS, savePagePathFor } from '../../shared/savePage'

/**
 * Save Page As on Electron (CT-27): what the OS dialog is opened with for a format, and what
 * `webContents.savePage` is told to write. The format is Zenium's choice before the dialog
 * (the Save Page As submenu; `shared/savePage.ts` says why the dialog cannot make it), so each
 * dialog carries the one filter of its format, and the dialog's answer – a path, never the
 * filter – is completed with the format's extension where a typed name has none (GTK).
 */

/** Electron's `savePage` type per format. */
export const ELECTRON_SAVE_TYPES: Readonly<
  Record<SavePageFormat, 'HTMLComplete' | 'HTMLOnly' | 'MHTML'>
> = {
  complete: 'HTMLComplete',
  htmlOnly: 'HTMLOnly',
  singleFile: 'MHTML'
}

/** The save dialog for `format`: Chrome's title, the one filter, the suggested name in `directory`. */
export function savePageDialogOptions(
  format: SavePageFormat,
  defaultPath: string
): SaveDialogOptions {
  const spec = SAVE_PAGE_FORMAT_SPECS[format]
  return {
    title: 'Save Page As',
    defaultPath,
    filters: [{ name: spec.filter, extensions: [...spec.extensions] }]
  }
}

/** The write the dialog's answer asks for: the completed path and Electron's save type. */
export function savePageTarget(
  filePath: string,
  format: SavePageFormat
): { path: string; saveType: 'HTMLComplete' | 'HTMLOnly' | 'MHTML' } {
  return { path: savePagePathFor(filePath, format), saveType: ELECTRON_SAVE_TYPES[format] }
}
