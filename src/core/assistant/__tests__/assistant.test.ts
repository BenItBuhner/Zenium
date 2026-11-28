import { describe, expect, it, vi } from 'vitest'
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
import { AssistantService, conversationOf, sanitizeProvider, type AssistantHost } from '../service'
import {
  anthropicClient,
  openaiClient,
  type ModelClient,
  type ModelReply,
  type ProviderConfig,
  type Turn
} from '../providers'
import type { SecretStore, StoreIO } from '../../platform'

/** A model whose replies come from a script, recording what it was sent. */
function scripted(replies: ModelReply[]): {
  model: ModelClient
  sent: Turn[][]
  systems: string[]
} {
  const sent: Turn[][] = []
  const systems: string[] = []
  const model: ModelClient = {
    turn: vi.fn(async (system: string, _tools: unknown, turns: Turn[]) => {
      systems.push(system)
      sent.push(structuredClone(turns))
      const next = replies.shift()
      if (!next) throw new Error('no more replies')
      return next
    })
  }
  return { model, sent, systems }
}

const say = (text: string): ModelReply => ({ text, calls: [], refused: false })
const call = (name: string, input: Record<string, unknown>, id = 'u1'): ModelReply => ({
  text: '',
  calls: [{ id, name, input }],
  refused: false
})

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

  it('turns the tools into the neutral shape the adapters take', async () => {
    const fake = fakeBrowser()
    const mcp = new McpClient(
      inProcess(
        (req) => fake.service.handleHttp(req),
        () => fake.service.connectionToken()
      )
    )
    const tools = await loadTools(mcp)
    for (const t of tools) expect(t.parameters.type).toBe('object')
  })
})

describe('the loop', () => {
  const mcp = {
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'page text' }] }))
  } as unknown as McpClient

  function deps(model: ModelClient, memory: string[] = []): LoopDeps {
    return {
      model,
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
    const { model, sent, systems } = scripted([
      call('browser_read', { tab: 1 }),
      say('The answer.')
    ])
    const state: LoopState = { turns: [{ role: 'user', text: 'what is it' }], steps: 0 }
    expect(await step(state, deps(model), [])).toEqual({ kind: 'continue' })
    expect(await step(state, deps(model), [])).toEqual({ kind: 'done', answer: 'The answer.' })
    expect(state.steps).toBe(1)
    expect(systems[0]).toContain('Kagi')
    expect(sent[1].at(-1)).toEqual({
      role: 'tool',
      results: [{ id: 'u1', name: 'browser_read', content: [{ type: 'text', text: 'page text' }] }]
    })
  })

  it('keeps a fact only through remember, and stops on a refusal', async () => {
    const memory: string[] = []
    const { model } = scripted([
      call('remember', { fact: 'Lives in Oslo' }),
      { text: '', calls: [], refused: true }
    ])
    const state: LoopState = { turns: [{ role: 'user', text: 'x' }], steps: 0 }
    await step(state, deps(model, memory), [])
    expect(memory).toEqual(['Lives in Oslo'])
    expect((await step(state, deps(model, memory), [])).kind).toBe('done')
    expect(systemPrompt({ memory: () => memory, searchEngine: 'G' })).toContain('- Lives in Oslo')
  })

  it('stops at the step limit and says so', async () => {
    const { model } = scripted([])
    const out = await step({ turns: [], steps: MAX_STEPS }, deps(model), [])
    expect(out).toMatchObject({ kind: 'done' })
    expect(model.turn).not.toHaveBeenCalled()
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
      turns: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: '', calls: [{ id: 'u', name: 'x', input: {} }] }
      ],
      steps: 3
    }
    appendUser(state, 'and then?')
    expect(state.turns).toEqual([
      { role: 'user', text: 'q' },
      { role: 'user', text: 'and then?' }
    ])
  })
})

/** A fetch that answers every request with `reply`, keeping what was sent. */
function fakeFetch(
  reply: unknown,
  status = 200
): { fetch: typeof fetch; bodies: unknown[]; urls: string[]; headers: Headers[] } {
  const bodies: unknown[] = []
  const urls: string[] = []
  const headers: Headers[] = []
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url instanceof Request ? url.url : url))
    headers.push(new Headers(init?.headers))
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  })
  return { fetch: f as unknown as typeof fetch, bodies, urls, headers }
}

const conversation: Turn[] = [
  { role: 'user', text: 'find it' },
  {
    role: 'assistant',
    text: 'Looking.',
    calls: [{ id: 'c1', name: 'browser_read', input: { a: 1 } }]
  },
  {
    role: 'tool',
    results: [
      {
        id: 'c1',
        name: 'browser_read',
        content: [
          { type: 'text', text: 'page' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' }
        ]
      }
    ]
  },
  { role: 'user', text: 'and more' }
]
const tools = [
  { name: 'browser_read', description: 'Read', parameters: { type: 'object', properties: {} } }
]

describe('the OpenAI-compatible adapter (Responses API)', () => {
  const config: ProviderConfig = {
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1/',
    model: 'local-model'
  }

  it('sends the conversation as Responses items, and reads text and function calls back', async () => {
    const net = fakeFetch({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Found.' }] },
        { type: 'function_call', call_id: 'c2', name: 'browser_read', arguments: '{"tab":2}' }
      ]
    })
    const reply = await openaiClient(config, 'sk-x', net.fetch).turn(
      'be brief',
      tools,
      conversation
    )
    expect(reply).toEqual({
      text: 'Found.',
      calls: [{ id: 'c2', name: 'browser_read', input: { tab: 2 } }],
      refused: false
    })
    expect(net.urls[0]).toBe('http://localhost:1234/v1/responses')
    expect(net.headers[0].get('authorization')).toBe('Bearer sk-x')
    const body = net.bodies[0] as Record<string, unknown>
    expect(body).toMatchObject({ model: 'local-model', instructions: 'be brief', store: false })
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'browser_read',
        description: 'Read',
        parameters: { type: 'object', properties: {} },
        strict: false
      }
    ])
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'find it' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
      { type: 'function_call', call_id: 'c1', name: 'browser_read', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'page' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Screenshot from the tool above:' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
        ]
      },
      { role: 'user', content: [{ type: 'input_text', text: 'and more' }] }
    ])
  })

  it('says in plain words what a refused key or a missing model means', async () => {
    const denied = fakeFetch({ error: { message: 'bad key' } }, 401)
    await expect(
      openaiClient(config, 'k', denied.fetch).turn('', [], conversation)
    ).rejects.toThrow('refused the key')
    const missing = fakeFetch({ error: { message: 'no model' } }, 404)
    await expect(
      openaiClient(config, 'k', missing.fetch).turn('', [], conversation)
    ).rejects.toThrow('no such model')
  })
})

describe('the Anthropic-compatible adapter (Messages API)', () => {
  const config: ProviderConfig = {
    kind: 'anthropic',
    baseUrl: 'http://localhost:8080',
    model: 'some-model'
  }

  it('sends Messages with tool results joined to the follow-up, and reads tool_use back', async () => {
    const net = fakeFetch({
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'some-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 't9', name: 'browser_read', input: { tab: 3 } }
      ]
    })
    const reply = await anthropicClient(config, 'key', net.fetch).turn('sys', tools, conversation)
    expect(reply).toEqual({
      text: 'On it.',
      calls: [{ id: 't9', name: 'browser_read', input: { tab: 3 } }],
      refused: false
    })
    expect(net.urls[0]).toBe('http://localhost:8080/v1/messages')
    const body = net.bodies[0] as {
      model: string
      system: string
      messages: { role: string; content: unknown }[]
    }
    expect(body.model).toBe('some-model')
    expect(body.system).toBe('sys')
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(body.messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'c1',
        content: [
          { type: 'text', text: 'page' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]
      },
      { type: 'text', text: 'and more' }
    ])
  })
})

describe('AssistantService', () => {
  const provider: ProviderConfig = {
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: 'm'
  }

  function service(replies: ModelReply[]): {
    svc: AssistantService
    host: AssistantHost
    makeClient: ReturnType<typeof vi.fn>
  } {
    const fake = fakeBrowser()
    const { model } = scripted(replies)
    const makeClient = vi.fn(() => model)
    const host: AssistantHost = {
      io: memoryIo(),
      secrets: memorySecrets(),
      handleHttp: (req) => fake.service.handleHttp(req),
      agentToken: () => fake.service.connectionToken(),
      searchEngine: () => 'Google',
      changed: vi.fn(),
      makeClient
    }
    return { svc: new AssistantService(host), host, makeClient }
  }

  async function settle(svc: AssistantService, id: string): Promise<void> {
    await vi.waitFor(() => {
      expect(svc.status().tasks.find((t) => t.id === id)?.status).not.toBe('running')
    })
  }

  it('asks for a model service before it runs anything', async () => {
    const { svc } = service([])
    await svc.start()
    const id = svc.ask('hello')
    await settle(svc, id)
    expect(svc.status().tasks[0].error).toContain('model service')
  })

  it('runs on the service and key the user set, follow-ups included, and saves it all', async () => {
    const { svc, host, makeClient } = service([say('Hi.'), say('Again.')])
    await svc.setProvider(provider, 'sk-local')
    expect(svc.status()).toMatchObject({ hasKey: true, provider })
    const id = svc.ask('hello')
    await settle(svc, id)
    expect(makeClient).toHaveBeenCalledWith(provider, 'sk-local')
    expect(svc.ask('more', id)).toBe(id)
    await settle(svc, id)
    const task = svc.status().tasks[0]
    expect(task.status).toBe('done')
    expect(task.conversation.map((m) => m.text)).toEqual(['hello', 'Hi.', 'more', 'Again.'])
    svc.shutdown()
    const again = new AssistantService({ ...host })
    expect(again.status().tasks[0].conversation).toHaveLength(4)
    expect(again.status().provider).toEqual(provider)
  })

  it('keeps the saved key when the service is changed without one, and forgets both on remove', async () => {
    const { svc, host } = service([])
    await svc.setProvider(provider, 'k1')
    await svc.setProvider({ ...provider, model: 'other' })
    expect(await host.secrets!.get('assistant.apiKey')).toBe('k1')
    expect(svc.status().provider?.model).toBe('other')
    await svc.setProvider(null)
    expect(svc.status()).toMatchObject({ provider: null, hasKey: false })
    expect(await host.secrets!.get('assistant.apiKey')).toBeNull()
  })

  it('forgets a fact and clears its memory', async () => {
    const { svc } = service([call('remember', { fact: 'Prefers metric' }), say('Ok.')])
    await svc.setProvider(provider, '')
    const id = svc.ask('remember I like metric')
    await settle(svc, id)
    expect(svc.status().memory).toEqual(['Prefers metric'])
    svc.forgetFact(0)
    expect(svc.status().memory).toEqual([])
  })

  it('takes only a known API, an http(s) address and a model', () => {
    expect(sanitizeProvider({ kind: 'openai', model: 'gpt' })).toEqual({
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt'
    })
    expect(sanitizeProvider({ kind: 'other', model: 'x' })).toBeNull()
    expect(sanitizeProvider({ kind: 'anthropic', model: '' })).toBeNull()
    expect(sanitizeProvider({ kind: 'anthropic', model: 'x', baseUrl: 'file:///etc' })).toBeNull()
  })

  it('shows only words in the conversation, never tool traffic', () => {
    expect(
      conversationOf({
        turns: [
          { role: 'user', text: 'q' },
          { role: 'assistant', text: 'checking', calls: [{ id: 'u', name: 'x', input: {} }] },
          {
            role: 'tool',
            results: [{ id: 'u', name: 'x', content: [{ type: 'text', text: 'big' }] }]
          },
          { role: 'assistant', text: 'a', calls: [] }
        ],
        steps: 1
      })
    ).toEqual([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'a' }
    ])
  })
})
