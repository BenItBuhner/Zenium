import { dialog, net } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Mod } from '../../shared/types'
import { newId } from '../../shared/ids'
import { JsonStore } from '../store/JsonStore'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

interface Persisted {
  version: 1
  mods: Mod[]
}

const MAX_CSS = 512 * 1024

/**
 * Zen Mods for the Chromium port: custom CSS applied to the browser chrome (the equivalent of
 * Zen's `chrome.css` mods / `userChrome.css`). Stored locally, toggled live in the UI.
 */
export class ModService {
  private mods: Mod[] = []
  private readonly store: JsonStore<Persisted>

  constructor(
    private readonly browser: Browser,
    userDataDir: string
  ) {
    this.store = new JsonStore<Persisted>(join(userDataDir, 'zen', 'mods.json'), 300)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.mods)) {
      this.mods = data.mods.filter(
        (m) => m && typeof m.id === 'string' && typeof m.css === 'string'
      )
    }
  }

  all(): Mod[] {
    return this.mods
  }

  add(name: string, css: string, source: string | null = null): Mod {
    const mod: Mod = {
      id: newId('mod'),
      name: name.trim() || 'Untitled mod',
      source,
      css: css.slice(0, MAX_CSS),
      enabled: true,
      updatedAt: Date.now()
    }
    this.mods.push(mod)
    this.persist()
    return mod
  }

  update(id: string, patch: Partial<Pick<Mod, 'name' | 'css' | 'enabled'>>): void {
    const mod = this.mods.find((m) => m.id === id)
    if (!mod) return
    if (patch.name !== undefined) mod.name = patch.name.trim() || mod.name
    if (patch.css !== undefined) mod.css = patch.css.slice(0, MAX_CSS)
    if (patch.enabled !== undefined) mod.enabled = patch.enabled
    mod.updatedAt = Date.now()
    this.persist()
  }

  remove(id: string): void {
    const before = this.mods.length
    this.mods = this.mods.filter((m) => m.id !== id)
    if (this.mods.length !== before) this.persist()
  }

  async importFile(win: ZenWindow): Promise<void> {
    const result = await dialog.showOpenDialog(win.win, {
      title: 'Import mod',
      properties: ['openFile'],
      filters: [{ name: 'CSS', extensions: ['css'] }]
    })
    if (result.canceled || !result.filePaths[0]) return
    const file = result.filePaths[0]
    try {
      const css = await readFile(file, 'utf8')
      this.add(basename(file, '.css'), css, file)
      this.browser.toast(`Imported ${basename(file)}`, 'info', win)
    } catch (error) {
      this.browser.toast(`Could not import mod: ${(error as Error).message}`, 'error', win)
    }
  }

  async importUrl(url: string, win: ZenWindow): Promise<void> {
    if (!/^https?:\/\//i.test(url)) {
      this.browser.toast('Enter an http(s) URL to a .css file', 'error', win)
      return
    }
    try {
      const res = await net.fetch(url, { headers: { accept: 'text/css,*/*;q=0.8' } })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const css = await res.text()
      if (!css.trim()) throw new Error('The file is empty')
      const name = decodeURIComponent(basename(new URL(url).pathname, '.css')) || 'Mod'
      this.add(name, css, url)
      this.browser.toast(`Imported ${name}`, 'info', win)
    } catch (error) {
      this.browser.toast(`Could not import mod: ${(error as Error).message}`, 'error', win)
    }
  }

  private persist(): void {
    this.store.write({ version: 1, mods: this.mods })
    this.browser.state.commitVolatile()
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
