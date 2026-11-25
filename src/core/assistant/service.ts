/**
 * The built-in agent (`zen://ask`): tasks the user hands Zenium in plain words, run by Claude on
 * the user's own Anthropic API key through the browser's own MCP tools (`McpClient` +
 * `inProcess`), so it follows exactly the rules an outside agent does – its own named session,
 * its own tabs, the approval prompts, the cookie switches.
 *
 * Each task's conversation is saved after every step (`assistant.json`), so a task the browser
 * quit in the middle of carries on at the next start. The key lives in the secret store, never
 * in the JSON. Memory is a short list of facts the user agreed to keep, shown and editable on
 * the page, at most `MAX_MEMORY_FACTS` of `MAX_FACT_CHARS` characters.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { AssistantStatus, AssistantTaskInfo } from '../../shared/types'
import { JsonStore } from '../store/JsonStore'
import type { SecretStore, StoreIO } from '../platform'
import type { AgentHttpRequest, AgentHttpResponse } from '../agent/http'
import { McpClient, inProcess } from './mcpClient'
import { addFact, appendUser, loadTools, step, type LoopState } from './loop'

export const API_KEY_SECRET = 'assistant.apiKey'
export const ASSISTANT_FILE = 'assistant.json'
/** Tasks kept on the page; the oldest finished ones go first. */
export const MAX_TASKS = 20

interface StoredTask {
  id: string
  title: string
  status: AssistantTaskInfo['status']
  answer: string
  error: string
  createdAt: number
  updatedAt: number
  state: LoopState
}

interface Persisted {
  version: 1
  memory: string[]
  tasks: StoredTask[]
}

export interface AssistantHost {
  io: StoreIO
  secrets: SecretStore | undefined
  handleHttp: (req: AgentHttpRequest) => Promise<AgentHttpResponse>
  agentToken: () => string
  searchEngine: () => string
  /** Something on the page changed. */
  changed: () => void
  /** Swappable for tests. */
  makeClient?: (apiKey: string) => Anthropic
}

function titleOf(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** What the page shows of a task: the user's words and the model's answers, no tool traffic. */
export function conversationOf(state: LoopState): AssistantTaskInfo['conversation'] {
  const out: AssistantTaskInfo['conversation'] = []
  for (const m of state.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const blocks =
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
    if (m.role === 'assistant' && blocks.some((b) => b.type === 'tool_use')) continue
    const text = blocks
      .flatMap((b) => (b.type === 'text' && 'text' in b ? [b.text] : []))
      .join('\n')
      .trim()
    if (text) out.push({ role: m.role, text })
  }
  return out
}

export class AssistantService {
  private readonly store: JsonStore<Persisted>
  private memory: string[] = []
  private tasks: StoredTask[] = []
  private hasKey = false
  private readonly running = new Map<string, AbortController>()
  private mcp: McpClient | null = null

  constructor(private readonly host: AssistantHost) {
    this.store = new JsonStore<Persisted>(host.io, ASSISTANT_FILE, 300)
    const data = this.store.readSync()
    if (data?.version === 1) {
      this.memory = Array.isArray(data.memory)
        ? data.memory.filter((f) => typeof f === 'string')
        : []
      this.tasks = Array.isArray(data.tasks) ? data.tasks.filter((t) => t && t.id && t.state) : []
    }
  }

  /** Read whether a key is set, and pick up the tasks a quit left running. */
  async start(): Promise<void> {
    this.hasKey = Boolean(await this.host.secrets?.get(API_KEY_SECRET))
    this.host.changed()
    for (const t of this.tasks) if (t.status === 'running') void this.run(t)
  }

  status(): AssistantStatus {
    return {
      available: Boolean(this.host.secrets),
      hasKey: this.hasKey,
      memory: [...this.memory],
      tasks: this.tasks
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          answer: t.answer,
          error: t.error,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          conversation: conversationOf(t.state)
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }

  async setKey(key: string): Promise<void> {
    const secrets = this.host.secrets
    if (!secrets) throw new Error('This device has no secret store for an API key')
    const k = key.trim()
    if (k) await secrets.set(API_KEY_SECRET, k)
    else await secrets.delete(API_KEY_SECRET)
    this.hasKey = Boolean(k)
    this.host.changed()
  }

  /** A new task, or a follow-up on `taskId`. Returns the task's id. */
  ask(prompt: string, taskId?: string): string {
    const text = prompt.trim()
    if (!text) throw new Error('Nothing to ask')
    const now = Date.now()
    let task = taskId ? this.tasks.find((t) => t.id === taskId) : undefined
    if (task) {
      this.running.get(task.id)?.abort()
      appendUser(task.state, text)
      task.state.steps = 0
      Object.assign(task, { status: 'running', answer: '', error: '', updatedAt: now })
    } else {
      task = {
        id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        title: titleOf(text),
        status: 'running',
        answer: '',
        error: '',
        createdAt: now,
        updatedAt: now,
        state: { messages: [{ role: 'user', content: text }], steps: 0 }
      }
      this.tasks.push(task)
      this.trim()
    }
    this.save()
    void this.run(task)
    return task.id
  }

  stop(taskId: string): void {
    const task = this.tasks.find((t) => t.id === taskId)
    this.running.get(taskId)?.abort()
    if (task && task.status === 'running') {
      Object.assign(task, { status: 'stopped', updatedAt: Date.now() })
      this.save()
    }
  }

  remove(taskId: string): void {
    this.stop(taskId)
    this.tasks = this.tasks.filter((t) => t.id !== taskId)
    this.save()
  }

  forgetFact(index: number): void {
    if (index < 0 || index >= this.memory.length) return
    this.memory.splice(index, 1)
    this.save()
  }

  clearMemory(): void {
    this.memory = []
    this.save()
  }

  /** Stop every task without marking it stopped, so the next start resumes it. */
  shutdown(): void {
    for (const c of this.running.values()) c.abort()
    this.running.clear()
    this.store.flushSync()
  }

  private trim(): void {
    while (this.tasks.length > MAX_TASKS) {
      const oldest = this.tasks
        .filter((t) => t.status !== 'running')
        .sort((a, b) => a.updatedAt - b.updatedAt)[0]
      if (!oldest) break
      this.tasks = this.tasks.filter((t) => t !== oldest)
    }
  }

  private save(): void {
    this.store.write({ version: 1, memory: this.memory, tasks: this.tasks })
    this.host.changed()
  }

  private finish(task: StoredTask, patch: Partial<StoredTask>): void {
    Object.assign(task, patch, { updatedAt: Date.now() })
    this.save()
  }

  private async run(task: StoredTask): Promise<void> {
    const key = await this.host.secrets?.get(API_KEY_SECRET)
    if (!key) {
      this.finish(task, {
        status: 'failed',
        error: 'Add your Anthropic API key on this page to use the built-in agent.'
      })
      return
    }
    const controller = new AbortController()
    this.running.set(task.id, controller)
    // One MCP connection for every task: the browser sees one agent, "Zenium agent".
    const mcp = (this.mcp ??= new McpClient(inProcess(this.host.handleHttp, this.host.agentToken)))
    const anthropic = this.host.makeClient?.(key) ?? new Anthropic({ apiKey: key })
    try {
      const tools = await loadTools(mcp)
      const deps = {
        anthropic,
        mcp,
        searchEngine: this.host.searchEngine(),
        memory: () => this.memory,
        remember: (fact: string) => {
          const r = addFact(this.memory, fact)
          this.memory = r.facts
          return r.message
        }
      }
      for (;;) {
        if (controller.signal.aborted) return
        const outcome = await step(task.state, deps, tools, controller.signal)
        if (controller.signal.aborted) return
        if (outcome.kind === 'continue') {
          task.updatedAt = Date.now()
          this.save()
          continue
        }
        if (outcome.kind === 'done') this.finish(task, { status: 'done', answer: outcome.answer })
        else this.finish(task, { status: 'failed', error: outcome.error })
        return
      }
    } catch (error) {
      if (!controller.signal.aborted)
        this.finish(task, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        })
    } finally {
      if (this.running.get(task.id) === controller) this.running.delete(task.id)
    }
  }
}
