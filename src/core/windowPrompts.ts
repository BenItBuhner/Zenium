import type { WindowPrompt, WindowPromptDownloads } from '../shared/types'
import { newId } from '../shared/ids'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

interface Pending {
  win: ZenWindow
  resolve: (accepted: boolean) => void
}

/**
 * Questions the chrome asks about a window as a whole – "Close N tabs?" before a window with
 * several tabs closes, "Quit Zenium?", the downloads a quit or a close would end (downloads-35)
 * – shown window-modal by that window's chrome. One at a time per window: a question raised
 * while another is up is answered no, so the flow that asked simply stops.
 */
export class WindowPrompts {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly browser: Browser) {}

  /**
   * Resolves with the user's answer; a window that is gone (or busy with a question) says no.
   * `count` is the tabs warning's (0 when it is not asked), `downloads` the downloads the answer
   * ends; the two make one prompt.
   */
  ask(
    win: ZenWindow,
    kind: WindowPrompt['kind'],
    count: number,
    downloads: WindowPromptDownloads | null = null
  ): Promise<boolean> {
    if (!win.alive || win.prompt) return Promise.resolve(false)
    const prompt: WindowPrompt = { id: newId('prompt'), kind, count, downloads }
    return new Promise((resolve) => {
      this.pending.set(prompt.id, { win, resolve })
      win.prompt = prompt
      if (!win.host.isFocused()) win.host.focus()
      this.browser.state.commitVolatile()
    })
  }

  /** The chrome answered (or dismissed, which is a no). */
  respond(id: string, accepted: boolean): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (entry.win.prompt?.id === id) entry.win.prompt = null
    this.browser.state.commitVolatile()
    entry.resolve(accepted)
  }

  /** The window went away: whatever it was asked is moot. */
  cancelForWindow(win: ZenWindow): void {
    for (const [id, entry] of [...this.pending]) if (entry.win === win) this.respond(id, false)
  }
}
