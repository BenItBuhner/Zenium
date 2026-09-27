/**
 * What the chrome calls the places a file path names – the words a toast that reports a save
 * uses for the folder the file landed in (§9.33: the toast names the destination, not the
 * file). One reading for the browser core and the renderer alike: the share hub's "Saved to
 * <folder>", the capture card's and the PDF viewer's say the same of the same folder.
 */

/**
 * The directory of Android's public Downloads collection (`Environment.DIRECTORY_DOWNLOADS`),
 * which its Files app lists as "Downloads": the one folder named otherwise than it is spelt.
 */
const ANDROID_DOWNLOADS_DIRECTORY = 'Download'

/** What the chrome calls that collection – as its Files app and our own QR toast do. */
const ANDROID_DOWNLOADS_NAME = 'Downloads'

/**
 * The folder a saved file sits in, by its own name: the last segment of the path's parent, on
 * either separator – "Downloads", or the folder the user chose instead. Android's public
 * collection is the directory `Download`, and is named here as its Files app names it,
 * "Downloads" – once, for every toast that reports a save. A bare name or a file at a root has
 * no folder to name (''); a drive's root is the drive (`C:`).
 */
export function folderNameOf(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  const folder = segments.length > 1 ? (segments[segments.length - 2] ?? '') : ''
  return folder === ANDROID_DOWNLOADS_DIRECTORY ? ANDROID_DOWNLOADS_NAME : folder
}
