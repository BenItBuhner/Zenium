import { dialog } from 'electron'
import { copyFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { NewTabBackgroundHost } from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import type { ElectronWindow } from './window'

/** Host of the page's custom background image (`NewTabPageState.backgroundImage`). */
export const NEW_TAB_BACKGROUND_HOST = 'newtab-background'
const BASENAME = 'background'
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp']
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp'
}

/**
 * The new tab page's custom background image: a copy of the picked file under
 * `<userData>/zen/newtab/`, served to the page as `zen://newtab-background/?v=<mtime>` (the
 * version changes with the file, so a re-pick shows up without a cache dance).
 */
export class ElectronNewTabBackground implements NewTabBackgroundHost {
  private file: { path: string; version: number } | null = null

  constructor(private readonly dir: string) {
    this.file = this.scan()
  }

  /** The image left by an earlier session, if any (read once, synchronously, at startup). */
  private scan(): { path: string; version: number } | null {
    if (!existsSync(this.dir)) return null
    for (const name of readdirSync(this.dir)) {
      const ext = extname(name).toLowerCase()
      if (name.slice(0, name.length - ext.length) !== BASENAME || !MIME_TYPES[ext]) continue
      const path = join(this.dir, name)
      try {
        return { path, version: Math.round(statSync(path).mtimeMs) }
      } catch {
        return null
      }
    }
    return null
  }

  current(): string | null {
    return this.file ? `zen://${NEW_TAB_BACKGROUND_HOST}/?v=${this.file.version}` : null
  }

  async pick(win: ZenWindow): Promise<string | null> {
    const host = win.host as ElectronWindow
    const options = {
      title: 'Choose a background image',
      properties: ['openFile' as const],
      filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
    }
    const result = host.alive
      ? await dialog.showOpenDialog(host.win, options)
      : await dialog.showOpenDialog(options)
    const source = result.filePaths[0]
    if (result.canceled || !source) return null
    const ext = extname(source).toLowerCase()
    if (!MIME_TYPES[ext]) return null
    try {
      await mkdir(this.dir, { recursive: true })
      await this.removeFiles()
      const path = join(this.dir, `${BASENAME}${ext}`)
      await copyFile(source, path)
      this.file = { path, version: Math.round((await stat(path)).mtimeMs) }
    } catch (error) {
      console.warn('[zen] new tab background:', (error as Error).message)
      this.file = null
      return null
    }
    return this.current()
  }

  async clear(): Promise<void> {
    this.file = null
    try {
      await this.removeFiles()
    } catch (error) {
      console.warn('[zen] new tab background:', (error as Error).message)
    }
  }

  private async removeFiles(): Promise<void> {
    if (!existsSync(this.dir)) return
    for (const name of await readdir(this.dir)) {
      const ext = extname(name).toLowerCase()
      if (name.slice(0, name.length - ext.length) === BASENAME) await unlink(join(this.dir, name))
    }
  }

  /** The bytes for `zen://newtab-background`; a 404 when no image is set. */
  async response(): Promise<Response> {
    const file = this.file
    if (!file) return new Response('', { status: 404 })
    try {
      const bytes = await readFile(file.path)
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': MIME_TYPES[extname(file.path).toLowerCase()] ?? 'image/png',
          'cache-control': 'private, max-age=31536000, immutable'
        }
      })
    } catch {
      return new Response('', { status: 404 })
    }
  }
}
