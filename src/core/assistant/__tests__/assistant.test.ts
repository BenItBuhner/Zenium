import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { fakeBrowser } from '../../agent/__tests__/fakeBrowser'
import { McpClient, inProcess, parseRpcBody } from '../mcpClient'
import {
  MAX_FACT_CHARS,
  MAX_MEMORY_FACTS,
  MAX_STEPS,
  addFact,
  appendUser,
  loadTools,
  step,
  systemPrompt,
  type LoopDeps,
  type LoopState
} from '../loop'
import { AssistantService, conversationOf, type AssistantHost } from '../service'
import type { SecretStore, StoreIO } from '../../platform'

type Reply = { stop_reason: string; content: unknown[] }

/** An Anthropic client whose `beta.messages.create` answers from a script, recording requests. */
function scripted(replies: Reply[]): { client: Anthropic; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = []
  const client = {
    beta: {
      messages: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          requests.push(structuredClone(body))
          const next = replies.shift()
          if (!next) throw new Error('no more replies')
          return { id: 'm', role: 'assistant', type: 'message', ...next }
        })
      }
    }
  } as unknown as Anthropic
  return { client, requests }
}

function memoryIo(): StoreIO {
  const files = new Map<string, string>()
  return {
    readSync: (n: string) => files.get(n) ?? null,
    write: async (n: string, t: string) => void files.set(n, t),
    writeSync: (n: string, t: string) => void files.set(n, t)
  } as unknown as StoreIO
}

function memorySecrets(): SecretStore {
  const m = new Map<string, string>()
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k)
  }
}

describe('the MCP client, in process', () => {
  it('lists the browser tools and calls one with the connection token', async () => {
    const fake = fakeBrowser()
    const mcp = new McpClient(
      inProcess(
        (req) => fake.service.handleHttp(req),
        () => fake.service.connectionToken()
      )
    )
    const tools = await mcp.listTools()
    expect(tools.map((t) => t.name)).toContain('zen_session')
    const result = await mcp.callTool('zen_status', {})
    expect(result.content[0].text).toBeTruthy()
    // The token's session is approved without a prompt, under the client's own name.
    expect(fake.service.list().map((a) => a.name)).toContain('Zenium agent')
  })

  it('reads a JSON-RPC reply from a plain body or an SSE stream', () => {
    expect(parseRpcBody('{"id":1,"result":{}}')).toEqual({ id: 1, result: {} })
    expect(
      parseRpcBody('event: message\ndata: {"method":"x"}\n\ndata: {"id":2,"result":3}\n')
    ).toEqual({ id: 2, result: 3 })
    expect(parseRpcBody('')).toBeNull()
  })

  it('turns the tools into the shape the Messages API takes', async () => {
    const fake = fakeBrowser()
    const mcp = new McpClient(
      inProcess(
        (req) => fake.service.handleHttp(req),
        () => fake.service.connectionToken()
      )
    )
    const tools = await loadTools(mcp)
    for (const t of tools) expect(t.input_schema.type).toBe('object')
  })
})

describe('the loop', () => {
  const mcp = {
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'page text' }] }))
  } as unknown as McpClient

  function deps(client: Anthropic, memory: string[] = []): LoopDeps {
    return {
      anthropic: client,
      mcp,
      memory: () => memory,
      remember: (fact) => {
        const r = addFact(memory, fact)
        memory.splice(0, memory.length, ...r.facts)
        return r.message
      },
      searchEngine: 'Kagi, https://kagi.com/search?q=%s'
    }
  }

  it('runs the tools the model asks for, then returns its answer', async () => {
    const { client, requests } = scripted([
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'u1', name: 'browser_read', input: { tab: 1 } }]
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The answer.' }] }
    ])
    const state: LoopState = { messages: [{ role: 'user', content: 'what is it' }], steps: 0 }
    expect(await step(state, deps(client), [])).toEqual({ kind: 'continue' })
    expect(await step(state, deps(client), [])).toEqual({ kind: 'done', answer: 'The answer.' })
    expect(state.steps).toBe(1)
    // The request: the model, the fallbacks, effort, and the user's search engine in the prompt.
    expect(requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { effort: 'medium' }
    })
    expect(String(requests[0].system)).toContain('Kagi')
    const second = requests[1].messages as { role: string; content: unknown }[]
    expect(second.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'u1' }]
    })
  })

  it('keeps a fact only through remember, and stops on a refusal', async () => {
    const memory: string[] = []
    const { client } = scripted([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'u1', name: 'remember', input: { fact: 'Lives in Oslo' } }
        ]
      },
      { stop_reason: 'refusal', content: [] }
    ])
    const state: LoopState = { messages: [{ role: 'user', content: 'x' }], steps: 0 }
    await step(state, deps(client, memory), [])
    expect(memory).toEqual(['Lives in Oslo'])
    const out = await step(state, deps(client, memory), [])
    expect(out.kind).toBe('done')
    expect(systemPrompt({ memory: () => memory, searchEngine: 'G' })).toContain('- Lives in Oslo')
  })

  it('stops at the step limit and says so', async () => {
    const { client } = scripted([])
    const state: LoopState = { messages: [], steps: MAX_STEPS }
    const out = await step(state, deps(client), [])
    expect(out).toMatchObject({ kind: 'done' })
    expect(client.beta.messages.create).not.toHaveBeenCalled()
  })

  it('keeps memory bounded, trimmed and without repeats', () => {
    let facts: string[] = []
    for (let i = 0; i < MAX_MEMORY_FACTS + 5; i++) facts = addFact(facts, `fact ${i}`).facts
    expect(facts).toHaveLength(MAX_MEMORY_FACTS)
    expect(facts[0]).toBe('fact 5')
    expect(addFact(facts, 'FACT 9').message).toBe('Already remembered.')
    expect(addFact([], 'x'.repeat(500)).facts[0]).toHaveLength(MAX_FACT_CHARS)
    expect(addFact([], '   ').facts).toEqual([])
  })

  it('adds a follow-up without leaving a tool call unanswered', () => {
    const state: LoopState = {
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'x', input: {} }] }
      ],
      steps: 3
    }
    appendUser(state, 'and then?')
    expect(state.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q' },
          { type: 'text', text: 'and then?' }
        ]
      }
    ])
  })
})

describe('AssistantService', () => {
  function service(replies: Reply[]): { svc: AssistantService; host: AssistantHost } {
    const fake = fakeBrowser()
    const { client } = scripted(replies)
    const host: AssistantHost = {
      io: memoryIo(),
      secrets: memorySecrets(),
      handleHttp: (req) => fake.service.handleHttp(req),
      agentToken: () => fake.service.connectionToken(),
      searchEngine: () => 'Google',
      changed: vi.fn(),
      makeClient: () => client
    }
    return { svc: new AssistantService(host), host }
  }

  async function settle(svc: AssistantService, id: string): Promise<void> {
    await vi.waitFor(() => {
      expect(svc.status().tasks.find((t) => t.id === id)?.status).not.toBe('running')
    })
  }

  it('asks for the key before it runs anything', async () => {
    const { svc } = service([])
    await svc.start()
    const id = svc.ask('hello')
    await settle(svc, id)
    expect(svc.status().tasks[0].error).toContain('API key')
  })

  it('answers, takes a follow-up on the same task, and saves the conversation', async () => {
    const { svc, host } = service([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Again.' }] }
    ])
    await svc.setKey('sk-ant-test')
    expect(svc.status().hasKey).toBe(true)
    const id = svc.ask('hello')
    await settle(svc, id)
    expect(svc.ask('more', id)).toBe(id)
    await settle(svc, id)
    const task = svc.status().tasks[0]
    expect(task.status).toBe('done')
    expect(task.conversation.map((m) => m.text)).toEqual(['hello', 'Hi.', 'more', 'Again.'])
    // A new service over the same files sees the same task.
    svc.shutdown()
    const again = new AssistantService({ ...host })
    expect(again.status().tasks[0].conversation).toHaveLength(4)
  })

  it('forgets a fact and clears its memory', async () => {
    const { svc } = service([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'u', name: 'remember', input: { fact: 'Prefers metric' } }
        ]
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok.' }] }
    ])
    await svc.setKey('k')
    const id = svc.ask('remember I like metric')
    await settle(svc, id)
    expect(svc.status().memory).toEqual(['Prefers metric'])
    svc.forgetFact(0)
    expect(svc.status().memory).toEqual([])
  })

  it('shows only words in the conversation, never tool traffic', () => {
    expect(
      conversationOf({
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'x', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'big' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a' }] }
        ],
        steps: 1
      })
    ).toEqual([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'a' }
    ])
  })
})
