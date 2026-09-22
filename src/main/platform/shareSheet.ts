import { ShareMenu, app, type BrowserWindow } from 'electron'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { ShareSheetHost } from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import type { ShareFile } from '../../shared/share'

/**
 * The desktop's extras behind the chrome's share sheet (MW-21). Files a page shared through
 * `navigator.share` are written to the downloads folder ("Save"); on macOS the OS's own sheet
 * (`ShareMenu`: Mail, Messages, AirDrop, Notes, …) is offered as well – Chrome's "More…" there.
 * Windows and Linux have no Electron share sheet, so the row stays away and the Zenium sheet's
 * own targets (copy, QR, email) are what there is, which is more than Chrome offers on Linux.
 */
export class ElectronShareSheet implements ShareSheetHost {
  /** Only macOS has `ShareMenu`; the core hides the "More…" row when this is absent. */
  readonly system?: ShareSheetHost['system']

  constructor(
    private readonly downloadsDir: () => string,
    private readonly windowOf: (win: ZenWindow) => BrowserWindow | undefined
  ) {
    if (process.platform === 'darwin') this.system = (payload, win) => this.popup(payload, win)
  }

  async saveFiles(files: ShareFile[]): Promise<string[]> {
    return writeShared(files, this.downloadsDir())
  }

  private async popup(
    payload: { title: string; text: string; url: string; files: ShareFile[] },
    win: ZenWindow
  ): Promise<void> {
    const item: Electron.SharingItem = {}
    const texts = [payload.title, payload.text].filter((t) => t.trim() !== '')
    if (texts.length > 0) item.texts = texts
    if (payload.url) item.urls = [payload.url]
    if (payload.files.length > 0) {
      // The sheet's targets read files from disk; a page's files go to a temporary folder first.
      const dir = join(app.getPath('temp'), `zenium-share-${Date.now()}`)
      item.filePaths = await writeShared(payload.files, dir)
    }
    const bw = this.windowOf(win)
    new ShareMenu(item).popup(bw ? { window: bw } : {})
  }
}

/** Write shared files under `dir` without overwriting anything there; resolves with the paths. */
export async function writeShared(files: ShareFile[], dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true })
  const out: string[] = []
  for (const file of files) {
    // A file the host already holds (`uri`, Android's) never reaches Electron's sheet.
    if (file.data === undefined) continue
    const path = await uniquePath(dir, sharedFileName(file))
    await writeFile(path, Buffer.from(file.data, 'base64'))
    out.push(path)
  }
  return out
}

/** A safe file name for a shared file: the page's name, a plain one when it gave none. */
export function sharedFileName(file: Pick<ShareFile, 'name' | 'type'>): string {
  // A `File.name` is a leaf name, but the page's world is not trusted: the last path segment
  // (either separator) with the characters no file system takes replaced.
  const leaf =
    file.name
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .pop() ?? ''
  // eslint-disable-next-line no-control-regex
  let name = basename(leaf.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')).trim()
  if (name === '' || name === '.' || name === '..') name = `shared${extensionFor(file.type)}`
  return name
}

function extensionFor(type: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'text/plain': '.txt',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3'
  }
  return known[type.toLowerCase()] ?? ''
}

/** `name.ext`, `name (1).ext`, `name (2).ext`, … – the first that is free (Chrome's download rule). */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 0; n < 10_000; n++) {
    const candidate = join(dir, n === 0 ? name : `${stem} (${n})${ext}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}
