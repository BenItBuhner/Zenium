import type { SavePageFormat } from './types'

/**
 * Save Page As (CT-27): the three formats Chrome's dialog offers, in its order, with the words
 * its filter list uses – "Webpage, Complete" (the document and a `_files` folder of its
 * resources), "Webpage, HTML Only" (the document alone) and "Webpage, Single File" (one MHTML
 * archive). The menu draws the labels, the desktop's save dialog takes the filter, the downloads
 * list takes the MIME type from the saved file's extension.
 *
 * Electron's `dialog.showSaveDialog` answers `{ canceled, filePath }` and never says which filter
 * was picked (Electron 44's `SaveDialogReturnValue`), and `.html` cannot tell complete from HTML
 * only – so the format is chosen in Zenium before the dialog opens (the Save Page As submenu),
 * and each pick opens the dialog with that one filter. Ctrl+S saves in the format used last
 * (`DownloadSettings.savePageFormat`), as Edge's dialog remembers it.
 */
export const SAVE_PAGE_FORMATS: readonly SavePageFormat[] = ['complete', 'htmlOnly', 'singleFile']

export interface SavePageFormatSpec {
  /** The menu row's label, Chrome's filter wording with the dialog's ellipsis. */
  label: string
  /** The save dialog's filter name (Chrome's). */
  filter: string
  /** The extensions the filter accepts; the first is the one a name without any gets. */
  extensions: readonly string[]
  /** What the saved file is, for the downloads list. */
  mimeType: string
}

/** The MIME type of an MHTML archive (Chrome's, RFC 2557). */
export const MHTML_MIME_TYPE = 'multipart/related'

export const SAVE_PAGE_FORMAT_SPECS: Readonly<Record<SavePageFormat, SavePageFormatSpec>> = {
  complete: {
    label: 'Webpage, Complete…',
    filter: 'Webpage, Complete',
    extensions: ['html', 'htm'],
    mimeType: 'text/html'
  },
  htmlOnly: {
    label: 'Webpage, HTML Only…',
    filter: 'Webpage, HTML Only',
    extensions: ['html', 'htm'],
    mimeType: 'text/html'
  },
  singleFile: {
    label: 'Webpage, Single File…',
    filter: 'Webpage, Single File',
    extensions: ['mhtml', 'mht'],
    mimeType: MHTML_MIME_TYPE
  }
}

/** Chrome's default format, and the one a profile that never picked reads. */
export const DEFAULT_SAVE_PAGE_FORMAT: SavePageFormat = 'complete'

export function isSavePageFormat(value: unknown): value is SavePageFormat {
  return typeof value === 'string' && (SAVE_PAGE_FORMATS as readonly string[]).includes(value)
}

/** The lower-case extension of a path's last segment, without the dot; '' when it has none. */
export function fileExtensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * The name Save Page As suggests for `title` in `format`: the title made safe for a file name,
 * cut to 80 characters, with the format's first extension.
 */
export function suggestedSavePageName(title: string, format: SavePageFormat): string {
  const safe = (title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
  return `${safe}.${SAVE_PAGE_FORMAT_SPECS[format].extensions[0]}`
}

/**
 * The path the page is written to for what the dialog answered: a name typed without any
 * extension gets the format's (GTK's dialog does not append the filter's extension to a typed
 * name; Chrome's does), a name typed with one – the format's or another – stands as typed.
 */
export function savePagePathFor(filePath: string, format: SavePageFormat): string {
  return fileExtensionOf(filePath) === ''
    ? `${filePath}.${SAVE_PAGE_FORMAT_SPECS[format].extensions[0]}`
    : filePath
}

/**
 * What a saved page's file is, from its extension: an archive for `.mhtml` / `.mht` – which is
 * what Android writes whatever format was asked for – and a document otherwise.
 */
export function savePageMimeType(filePath: string): string {
  const extension = fileExtensionOf(filePath)
  return SAVE_PAGE_FORMAT_SPECS.singleFile.extensions.includes(extension)
    ? MHTML_MIME_TYPE
    : 'text/html'
}
