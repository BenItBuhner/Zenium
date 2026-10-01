import type { AgentPromptKind } from '../../shared/types'
import { newId } from '../../shared/ids'
import { RpcError } from './jsonrpc'

/**
 * A prompt an agent's tab raised that would otherwise be native or browser UI (a file chooser,
 * a permission request, HTTP authentication…), held for the tab's agent (`AgentPromptQueue`).
 * This is what `browser_prompts` lists; the caller that opened it waits on the answer.
 */
export interface AgentPrompt {
  id: string
  kind: AgentPromptKind
  tabId: string
  /** One line: what the page asked for. */
  summary: string
  /** What the agent needs to answer: the candidates, the mode, the site – kind by kind. */
  details: Record<string, unknown>
  /** The answers it takes, each with what it does and the arguments it reads. */
  actions: Record<string, string>
  /** What an unanswered prompt gets once `expiresAt` passes. */
  defaultAction: string
  /** The page (a load, a navigation) waits on the answer: a running call returns with it. */
  blocking: boolean
  openedAt: number
  expiresAt: number
}

/** An agent's answer: one of the prompt's `actions`, with the arguments that action reads. */
export interface AgentPromptAnswer {
  action: string
  [key: string]: unknown
}

/** What opens a prompt: the caller's side of it. */
export interface AgentPromptSpec<T> {
  kind: AgentPromptKind
  tabId: string
  summary: string
  details: Record<string, unknown>
  actions: Record<string, string>
  /** The answer once it has waited `ttlMs` unanswered. */
  defaultAction: string
  /**
   * The answer when nobody will give one: the tab closed or left the agent, the session that
   * held it ended. The refusal of the kind (cancel, deny), never a grant.
   */
  dismissAction: string
  blocking?: boolean
  ttlMs: number
  /**
   * The caller's value for an answer. Throws an `RpcError` for one that does not fit (an
   * unknown action, a missing argument): the agent hears why and the prompt stays open.
   */
  decide(answer: AgentPromptAnswer): T
}

/** The caller's handle on an open prompt. */
export interface AgentPromptHandle<T> {
  readonly id: string
  readonly result: Promise<T>
  /** What the agent sees changed (a device list filling in while the engine scans). */
  update(details: Record<string, unknown>): void
  /** The engine withdrew the request: the prompt goes, answered with its dismissal. */
  close(): void
}

/** How a prompt ended, for the queue's listener. */
export type AgentPromptEnd = 'answered' | 'expired' | 'dismissed'

interface Entry {
  prompt: AgentPrompt
  decide(answer: AgentPromptAnswer): unknown
  resolve(value: unknown): void
  dismissAction: string
  timer: ReturnType<typeof setTimeout>
}

export interface AgentPromptQueueHooks {
  now(): number
  /** A prompt was put up: tell its agent. */
  opened(prompt: AgentPrompt): void
  /** A prompt ended. */
  ended(prompt: AgentPrompt, how: AgentPromptEnd, action: string): void
}

/**
 * The prompts of agents' tabs that wait for their agent, oldest first, a queue per tab. Each is
 * answered once – by the agent (`answer`), by its default when it waited too long, or with its
 * dismissal when nobody is left to answer – and the caller that opened it hears that answer as
 * its own value (`AgentPromptSpec.decide`). Nothing here is ever shown to the user.
 */
export class AgentPromptQueue {
  private readonly entries: Entry[] = []

  constructor(private readonly hooks: AgentPromptQueueHooks) {}

  open<T>(spec: AgentPromptSpec<T>): AgentPromptHandle<T> {
    const now = this.hooks.now()
    const prompt: AgentPrompt = {
      id: newId('prompt'),
      kind: spec.kind,
      tabId: spec.tabId,
      summary: spec.summary,
      details: spec.details,
      actions: spec.actions,
      defaultAction: spec.defaultAction,
      blocking: spec.blocking === true,
      openedAt: now,
      expiresAt: now + spec.ttlMs
    }
    let resolve: (value: T) => void = () => undefined
    const result = new Promise<T>((r) => {
      resolve = r
    })
    const entry: Entry = {
      prompt,
      decide: (answer) => spec.decide(answer),
      resolve: (value) => resolve(value as T),
      dismissAction: spec.dismissAction,
      timer: setTimeout(() => this.expire(prompt.id), spec.ttlMs)
    }
    this.entries.push(entry)
    this.hooks.opened(prompt)
    return {
      id: prompt.id,
      result,
      update: (details) => {
        if (this.entries.includes(entry))
          entry.prompt.details = { ...entry.prompt.details, ...details }
      },
      close: () => this.dismiss(prompt.id)
    }
  }

  /** The waiting prompts, oldest first; only `tabId`'s when given. */
  list(tabId?: string): AgentPrompt[] {
    return this.entries
      .filter((e) => tabId === undefined || e.prompt.tabId === tabId)
      .map((e) => e.prompt)
  }

  get(id: string): AgentPrompt | undefined {
    return this.entries.find((e) => e.prompt.id === id)?.prompt
  }

  /**
   * The agent's answer. Throws when the prompt is gone or the answer does not fit it; on
   * success the prompt is gone and the caller has its value.
   */
  answer(id: string, answer: AgentPromptAnswer): AgentPrompt {
    const entry = this.entries.find((e) => e.prompt.id === id)
    if (!entry)
      throw new RpcError(
        -32002,
        `No prompt ${id} is waiting (it was answered, timed out or withdrawn)`
      )
    if (!(answer.action in entry.prompt.actions))
      throw new RpcError(
        -32602,
        `${entry.prompt.kind} prompt ${id} takes action ${Object.keys(entry.prompt.actions)
          .map((a) => JSON.stringify(a))
          .join(', ')} – not ${JSON.stringify(answer.action)}`
      )
    const value = entry.decide(answer)
    this.settle(entry, value, 'answered', answer.action)
    return entry.prompt
  }

  /** Every prompt of the tab ends with its dismissal (the tab closed, or is no agent's now). */
  dismissTab(tabId: string): void {
    for (const e of this.entries.filter((e) => e.prompt.tabId === tabId)) this.dismiss(e.prompt.id)
  }

  /** Every prompt ends with its dismissal (the server stopped). */
  dismissAll(): void {
    for (const e of [...this.entries]) this.dismiss(e.prompt.id)
  }

  private dismiss(id: string): void {
    const entry = this.entries.find((e) => e.prompt.id === id)
    if (!entry) return
    this.settle(entry, this.fallback(entry, entry.dismissAction), 'dismissed', entry.dismissAction)
  }

  private expire(id: string): void {
    const entry = this.entries.find((e) => e.prompt.id === id)
    if (!entry) return
    const action = entry.prompt.defaultAction
    this.settle(entry, this.fallback(entry, action), 'expired', action)
  }

  /** The caller's value for `action`; the dismissal's when the default itself does not decide. */
  private fallback(entry: Entry, action: string): unknown {
    try {
      return entry.decide({ action })
    } catch {
      return entry.decide({ action: entry.dismissAction })
    }
  }

  private settle(entry: Entry, value: unknown, how: AgentPromptEnd, action: string): void {
    const i = this.entries.indexOf(entry)
    if (i < 0) return
    this.entries.splice(i, 1)
    clearTimeout(entry.timer)
    entry.resolve(value)
    this.hooks.ended(entry.prompt, how, action)
  }
}

/** `30 s`, `2 min`: a wait as the agent reads it. */
export function describeWait(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`
  return `${Math.round(ms / 60_000)} min`
}

/** One paragraph for the agent: which prompt, where, what it takes and what silence gets. */
export function describePrompt(p: AgentPrompt, now: number): string {
  const actions = Object.entries(p.actions)
    .map(([name, what]) => `"${name}" – ${what}`)
    .join('; ')
  const left = Math.max(0, p.expiresAt - now)
  const how =
    p.kind === 'file-chooser'
      ? `browser_file_upload {"promptId":"${p.id}","paths":[…]} (or "files"), or browser_respond_prompt {"promptId":"${p.id}","action":"cancel"}`
      : `browser_respond_prompt {"promptId":"${p.id}","action":…}`
  return `Prompt ${p.id} on tab ${p.tabId} (${p.kind}${p.blocking ? ', the page waits on it' : ''}): ${p.summary} Answer with ${how}: ${actions}. Unanswered, "${p.defaultAction}" applies in ${describeWait(left)}.`
}
