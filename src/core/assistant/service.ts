/**
 * The built-in agent (`zen://ask`): tasks the user hands Zenium in plain words, run by a model
 * service the user sets up – any endpoint speaking the Anthropic Messages API or the OpenAI
 * Responses API, with its address, key and model (`providers.ts`) – through the browser's own
 * MCP tools (`McpClient` + `inProcess`), so it follows exactly the rules an outside agent does:
 * its own named session, its own tabs, the approval prompts, the cookie switches.
 *
 * Each task's conversation is saved after every step (`assistant.json`), so a task the browser
 * quit in the middle of carries on at the next start. The key lives in the secret store, never
 * in the JSON. Memory is a short list of facts the user agreed to keep, shown and editable on
 * the page, at most `MAX_MEMORY_FACTS` of `MAX_FACT_CHARS` characters.
 */
import type { AssistantStatus, AssistantTaskInfo } from '../../shared/types'
import { JsonStore } from '../store/JsonStore'
import type { SecretStore, StoreIO } from '../platform'
import type { AgentHttpRequest, AgentHttpResponse } from '../agent/http'
import { McpClient, inProcess } from './mcpClient'
import { addFact, appendUser, loadTools, step, type LoopState } from './loop'
import {
  DEFAULT_BASE_URLS,
  modelClient,
  type ModelClient,
  type ProviderConfig,
  type ProviderKind
} from './providers'

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
  version: 1 | 2
  memory: string[]
  tasks: StoredTask[]
  hasKey?: boolean
  provider?: ProviderConfig | null
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
  makeClient?: (config: ProviderConfig, apiKey: string) => ModelClient
}

function titleOf(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** What the page shows of a task: the user's words and the model's answers, no tool traffic. */
export function conversationOf(state: LoopState): AssistantTaskInfo['conversation'] {
  const out: AssistantTaskInfo['conversation'] = []
  for (const t of state.turns) {
    if (t.role === 'user') out.push({ role: 'user', text: t.text })
    else if (t.role === 'assistant' && !t.calls.length && t.text)
      out.push({ role: 'assistant', text: t.text })
  }
  return out
}

export class AssistantService {
  private readonly store: JsonStore<Persisted>
  private memory: string[] = []
  private tasks: StoredTask[] = []
  private hasKey = false
  private provider: ProviderConfig | null = null
  private readonly running = new Map<string, AbortController>()
  private mcp: McpClient | null = null

  constructor(private readonly host: AssistantHost) {
    this.store = new JsonStore<Persisted>(host.io, ASSISTANT_FILE, 300)
    const data = this.store.readSync()
    // Version 1 kept Anthropic-only conversations: its memory carries over, its tasks do not.
    if (data?.version === 1 || data?.version === 2) {
      this.memory = Array.isArray(data.memory)
        ? data.memory.filter((f) => typeof f === 'string')
        : []
      if (data.version === 2) {
        this.tasks = Array.isArray(data.tasks)
          ? data.tasks.filter((t) => t && t.id && Array.isArray(t.state?.turns))
          : []
        this.hasKey = data.hasKey === true
        this.provider = sanitizeProvider(data.provider)
      }
    }
  }

  /**
   * Pick up the tasks a quit left running. Whether a key is set comes from the JSON (`hasKey`),
   * so starting the browser never reads the secret store; the key itself is read per task.
   */
  async start(): Promise<void> {
    for (const t of this.tasks) if (t.status === 'running') void this.run(t)
  }

  status(): AssistantStatus {
    return {
      available: Boolean(this.host.secrets),
      hasKey: this.hasKey,
      provider: this.provider,
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

  /**
   * Set up the model service: which API it speaks, its address and model, and – when `key` is
   * given – its key (an empty key removes it). `null` forgets the service and its key.
   */
  async setProvider(config: ProviderConfig | null, key?: string): Promise<void> {
    const secrets = this.host.secrets
    if (!secrets) throw new Error('This device has no secret store for an API key')
    if (!config) {
      await secrets.delete(API_KEY_SECRET)
      this.provider = null
      this.hasKey = false
      this.save()
      return
    }
    const clean = sanitizeProvider(config)
    if (!clean) throw new Error('Name the API, its address and a model')
    this.provider = clean
    if (key !== undefined) {
      const k = key.trim()
      if (k) await secrets.set(API_KEY_SECRET, k)
      else await secrets.delete(API_KEY_SECRET)
      this.hasKey = Boolean(k)
    }
    this.save()
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
        state: { turns: [{ role: 'user', text }], steps: 0 }
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
    this.store.write({
      version: 2,
      memory: this.memory,
      tasks: this.tasks,
      hasKey: this.hasKey,
      provider: this.provider
    })
    this.host.changed()
  }

  private finish(task: StoredTask, patch: Partial<StoredTask>): void {
    Object.assign(task, patch, { updatedAt: Date.now() })
    this.save()
  }

  private async run(task: StoredTask): Promise<void> {
    const provider = this.provider
    if (!provider) {
      this.finish(task, {
        status: 'failed',
        error: 'Set up a model service on this page to use the built-in agent.'
      })
      return
    }
    // A local server may need no key; any other service refuses the call and says so.
    const key = (await this.host.secrets?.get(API_KEY_SECRET)) ?? ''
    const controller = new AbortController()
    this.running.set(task.id, controller)
    // One MCP connection for every task: the browser sees one agent, "Zenium agent".
    const mcp = (this.mcp ??= new McpClient(inProcess(this.host.handleHttp, this.host.agentToken)))
    const model = this.host.makeClient?.(provider, key) ?? modelClient(provider, key)
    try {
      const tools = await loadTools(mcp)
      const deps = {
        model,
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

/** A provider setting as stored or sent: a known API, an http(s) address, a model name. */
export function sanitizeProvider(value: unknown): ProviderConfig | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<ProviderConfig>
  const kind: ProviderKind | null = v.kind === 'anthropic' || v.kind === 'openai' ? v.kind : null
  if (!kind) return null
  const model = typeof v.model === 'string' ? v.model.trim().slice(0, 200) : ''
  if (!model) return null
  let baseUrl = typeof v.baseUrl === 'string' && v.baseUrl.trim() ? v.baseUrl.trim() : ''
  if (!baseUrl) baseUrl = DEFAULT_BASE_URLS[kind]
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  } catch {
    return null
  }
  return { kind, baseUrl: baseUrl.replace(/\/+$/, ''), model }
}
