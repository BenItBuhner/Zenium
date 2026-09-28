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
 * Where Android mounts its external storage – every volume under one root: the primary's
 * `/storage/emulated/0`, an SD card's `/storage/XXXX-XXXX`. The public collection's directory
 * lives under it (`/storage/emulated/0/Download`), and so does the host's own external files
 * folder that stands in for it below Android 10 (`/storage/emulated/0/Android/data/…/files/Download`).
 */
const ANDROID_STORAGE_ROOT = '/storage/'

/**
 * A `content:` address is the shape Android's public collection takes for a host that wrote the
 * copy through the media store and could read no path back for its row (Android 10 and above) –
 * the row is in Downloads, whatever the address's own segments spell.
 */
const ANDROID_CONTENT_ADDRESS = /^content:/i

/**
 * The folder a saved file sits in, by its own name: the last segment of the path's parent, on
 * either separator – "Downloads", or the folder the user chose instead. Android's public
 * collection is the directory `Download`, and is named here as its Files app names it,
 * "Downloads" – once, for every toast that reports a save – but only in the shapes that
 * collection takes: a `content:` address, or the directory `Download` under Android's external
 * storage root. Anywhere else the name is read as it is spelt, so a desktop folder the user named
 * `Download` is "Download" to the toast, as the Files app would show it. A bare name or a file at
 * a root has no folder to name (''); a drive's root is the drive (`C:`).
 */
export function folderNameOf(path: string): string {
  if (ANDROID_CONTENT_ADDRESS.test(path)) return ANDROID_DOWNLOADS_NAME
  const segments = path.split(/[\\/]+/).filter(Boolean)
  const folder = segments.length > 1 ? (segments[segments.length - 2] ?? '') : ''
  return folder === ANDROID_DOWNLOADS_DIRECTORY && path.startsWith(ANDROID_STORAGE_ROOT)
    ? ANDROID_DOWNLOADS_NAME
    : folder
}
