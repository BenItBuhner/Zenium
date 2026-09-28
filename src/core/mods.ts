import type { Mod } from '../shared/types'
import { newId } from '../shared/ids'
import { MAX_MOD_CSS, UNTITLED_MOD } from '../shared/mods'
import { JsonStore } from './store/JsonStore'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

interface Persisted {
  version: 1
  mods: Mod[]
}

/**
 * Zen Mods for the Chromium port: custom CSS applied to the browser chrome (the equivalent of
 * Zen's `chrome.css` mods / `userChrome.css`). Stored locally, toggled live in the UI; one `mod`
 * record per Mod across devices (`sync/records.ts`, the `mods` scope), landed through `put` and
 * `remove`.
 */
export class ModService {
  private mods: Mod[] = []
  private readonly store: JsonStore<Persisted>

  constructor(private readonly browser: Browser) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'mods.json', 300)
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
      name: name.trim() || UNTITLED_MOD,
      source,
      css: css.slice(0, MAX_MOD_CSS),
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
    if (patch.css !== undefined) mod.css = patch.css.slice(0, MAX_MOD_CSS)
    if (patch.enabled !== undefined) mod.enabled = patch.enabled
    mod.updatedAt = Date.now()
    this.persist()
  }

  /**
   * Replace a whole Mod under its id (used by sync: the record as `sanitizeMod` read it). A Mod
   * the list holds keeps its place, one it does not is appended – the list's order is each
   * device's own, as the Boosts' is. Returns true when something changed.
   */
  put(mod: Mod): boolean {
    const index = this.mods.findIndex((m) => m.id === mod.id)
    const before = index === -1 ? undefined : this.mods[index]
    if (JSON.stringify(before) === JSON.stringify(mod)) return false
    if (index === -1) this.mods.push(mod)
    else this.mods[index] = mod
    this.persist()
    return true
  }

  remove(id: string): void {
    const before = this.mods.length
    this.mods = this.mods.filter((m) => m.id !== id)
    if (this.mods.length !== before) this.persist()
  }

  async importFile(win: ZenWindow): Promise<void> {
    try {
      const files = await this.browser.platform.dialogs.pickTextFiles(
        { title: 'Import mod', extensions: ['css'] },
        win
      )
      for (const file of files) {
        this.add(stripCssExtension(file.name), file.text, file.name)
        this.browser.toast(`Imported ${file.name}`, 'info', win)
      }
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
      const res = await this.browser.platform.net.fetchText(url, {
        headers: { accept: 'text/css,*/*;q=0.8' }
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const css = res.text
      if (!css.trim()) throw new Error('The file is empty')
      const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
      const name = decodeURIComponent(stripCssExtension(last)) || 'Mod'
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

function stripCssExtension(name: string): string {
  return name.replace(/\.css$/i, '')
}
