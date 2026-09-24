import type { PermissionPrompt, PermissionPromptAnswer } from '../shared/types'
import type { PermissionPromptHost } from './platform'

interface Pending {
  prompt: PermissionPrompt
  resolve: (answer: PermissionPromptAnswer | null) => void
}

/** A prompt settled: the answer, or null for one withdrawn (the page navigated, the tab closed). */
export type PromptAnsweredListener = (
  prompt: PermissionPrompt,
  answer: PermissionPromptAnswer | null
) => void

/**
 * The permission prompts the chrome shows: non-modal, one at a time per tab, oldest first. The
 * queue rides in the state snapshot (`permissionPrompts`); the renderer shows its active tab's
 * first prompt (or one that belongs to no page) and answers with `permissions.respond`. A prompt
 * whose page navigates away or whose tab closes is withdrawn without an answer.
 *
 * This is the core's `PermissionPromptHost`; a platform may bring its own instead.
 */
export class PermissionPromptService implements PermissionPromptHost {
  private readonly pending: Pending[] = []
  private readonly answered = new Set<PromptAnsweredListener>()

  constructor(private readonly changed: () => void) {}

  /**
   * Hear every prompt's answer as it settles – the user's word, or null for one withdrawn – for
   * a service that keeps its own memory of them (the quiet notification rule remembers a site
   * whose prompt was dismissed, `webNotifications.ts`). Fired after the prompt has left the list.
   */
  onAnswered(listener: PromptAnsweredListener): () => void {
    this.answered.add(listener)
    return () => this.answered.delete(listener)
  }

  list(): PermissionPrompt[] {
    return this.pending.map((p) => p.prompt)
  }

  /** Pending prompts of one tab (its bubble shows the first, with a count of the rest). */
  forTab(tabId: string | null): PermissionPrompt[] {
    return this.pending.filter((p) => p.prompt.tabId === tabId).map((p) => p.prompt)
  }

  show(request: PermissionPrompt): Promise<PermissionPromptAnswer | null> {
    return new Promise((resolve) => {
      this.pending.push({ prompt: request, resolve })
      this.changed()
    })
  }

  /** The chrome answered (or dismissed) a prompt; unknown ids are stale answers and ignored. */
  respond(id: string, answer: PermissionPromptAnswer | null): void {
    const i = this.pending.findIndex((p) => p.prompt.id === id)
    if (i < 0) return
    const [entry] = this.pending.splice(i, 1)
    this.changed()
    entry.resolve(answer)
    for (const listener of this.answered) listener(entry.prompt, answer)
  }

  cancel(id: string): void {
    this.respond(id, null)
  }

  /** The tab committed a new document or closed: its questions are moot. */
  cancelForTab(tabId: string): void {
    for (const p of this.pending.filter((p) => p.prompt.tabId === tabId))
      this.respond(p.prompt.id, null)
  }
}
