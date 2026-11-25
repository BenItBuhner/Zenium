/**
 * The model behind the built-in agent, behind one small interface: the user names a service –
 * any endpoint that speaks the Anthropic Messages API or the OpenAI Responses API – with its
 * address, key and model. Zenium ships no key and prefers no vendor.
 *
 * The loop keeps its conversation in a neutral form (`Turn`); each adapter turns that into its
 * API's messages and the reply back into text and tool calls.
 */
import Anthropic from '@anthropic-ai/sdk'

export type ProviderKind = 'anthropic' | 'openai'

export interface ProviderConfig {
  kind: ProviderKind
  /** The API's base address, e.g. `https://api.openai.com/v1` or a local server's. */
  baseUrl: string
  model: string
}

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1'
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the arguments, `type: 'object'`. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolOutput {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[] }
  | {
      role: 'tool'
      results: { id: string; name: string; content: ToolOutput[]; isError?: boolean }[]
    }

export interface ModelReply {
  text: string
  calls: ToolCall[]
  refused: boolean
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
  }
}

export interface ModelClient {
  turn(system: string, tools: ToolSpec[], turns: Turn[], signal?: AbortSignal): Promise<ModelReply>
}

/** Plain words for an HTTP failure from either API. */
export function describeFailure(status: number | null, detail: string): string {
  if (status === 401 || status === 403)
    return 'The service refused the key. Check it on the Ask page.'
  if (status === 404) return 'The service has no such model or address. Check both on the Ask page.'
  if (status === 429) return 'The service is rate limiting this key. Try again in a minute.'
  if (status !== null)
    return `The service could not answer (HTTP ${status}${detail ? `: ${detail}` : ''}).`
  return detail || 'The service could not be reached.'
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (and any service that speaks it)
// ---------------------------------------------------------------------------

function toAnthropic(turns: Turn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const t of turns) {
    if (t.role === 'user') {
      const last = out.at(-1)
      // A follow-up right after tool results joins that user turn: roles must alternate.
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push({ type: 'text', text: t.text })
      } else out.push({ role: 'user', content: t.text })
    } else if (t.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = []
      if (t.text) content.push({ type: 'text', text: t.text })
      for (const c of t.calls)
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
      if (content.length) out.push({ role: 'assistant', content })
    } else {
      out.push({
        role: 'user',
        content: t.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          is_error: r.isError || undefined,
          content: r.content.length
            ? r.content.map((c) =>
                c.type === 'image' && c.data
                  ? {
                      type: 'image' as const,
                      source: {
                        type: 'base64' as const,
                        media_type: (c.mimeType ?? 'image/png') as 'image/png' | 'image/jpeg',
                        data: c.data
                      }
                    }
                  : { type: 'text' as const, text: c.text || '(no output)' }
              )
            : [{ type: 'text' as const, text: '(no output)' }]
        }))
      })
    }
  }
  return out
}

export function anthropicClient(
  config: ProviderConfig,
  apiKey: string,
  fetcher?: typeof fetch
): ModelClient {
  const client = new Anthropic({
    apiKey,
    baseURL: config.baseUrl || DEFAULT_BASE_URLS.anthropic,
    ...(fetcher ? { fetch: fetcher } : {})
  })
  return {
    async turn(system, tools, turns, signal) {
      let reply: Anthropic.Message
      try {
        reply = await client.messages.create(
          {
            model: config.model,
            max_tokens: 16000,
            system,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: { ...t.parameters, type: 'object' } as Anthropic.Tool.InputSchema
            })),
            messages: toAnthropic(turns)
          },
          { signal }
        )
      } catch (error) {
        if (error instanceof Anthropic.APIError)
          throw new ProviderError(describeFailure(error.status ?? null, ''), error.status ?? null)
        throw error
      }
      const text = reply.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('\n')
        .trim()
      const calls = reply.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }]
          : []
      )
      return { text, calls, refused: reply.stop_reason === 'refusal' }
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses API (and any service that speaks it)
// ---------------------------------------------------------------------------

type ResponsesItem = Record<string, unknown>

function toResponses(turns: Turn[]): ResponsesItem[] {
  const out: ResponsesItem[] = []
  for (const t of turns) {
    if (t.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'input_text', text: t.text }] })
    } else if (t.role === 'assistant') {
      if (t.text) out.push({ role: 'assistant', content: [{ type: 'output_text', text: t.text }] })
      for (const c of t.calls)
        out.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input)
        })
    } else {
      const images: ResponsesItem[] = []
      for (const r of t.results) {
        const text = r.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n')
        out.push({
          type: 'function_call_output',
          call_id: r.id,
          output: (r.isError ? 'Error: ' : '') + (text || '(no output)')
        })
        for (const c of r.content)
          if (c.type === 'image' && c.data)
            images.push({
              type: 'input_image',
              image_url: `data:${c.mimeType ?? 'image/png'};base64,${c.data}`
            })
      }
      // Screenshots go to the model as a user turn: function outputs are text everywhere.
      if (images.length)
        out.push({
          role: 'user',
          content: [{ type: 'input_text', text: 'Screenshot from the tool above:' }, ...images]
        })
    }
  }
  return out
}

interface ResponsesReply {
  output?: {
    type: string
    call_id?: string
    name?: string
    arguments?: string
    content?: { type: string; text?: string; refusal?: string }[]
  }[]
  error?: { message?: string } | null
}

export function openaiClient(
  config: ProviderConfig,
  apiKey: string,
  fetcher: typeof fetch = fetch
): ModelClient {
  const base = (config.baseUrl || DEFAULT_BASE_URLS.openai).replace(/\/+$/, '')
  return {
    async turn(system, tools, turns, signal) {
      let res: Response
      try {
        res = await fetcher(`${base}/responses`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: config.model,
            instructions: system,
            input: toResponses(turns),
            tools: tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: { ...t.parameters, type: 'object' },
              strict: false
            })),
            store: false
          })
        })
      } catch (error) {
        if (signal?.aborted) throw error
        throw new ProviderError(describeFailure(null, error instanceof Error ? error.message : ''))
      }
      const body = await res.text()
      if (!res.ok) {
        let detail = ''
        try {
          detail = (JSON.parse(body) as ResponsesReply).error?.message ?? ''
        } catch {
          /* not JSON */
        }
        throw new ProviderError(describeFailure(res.status, detail.slice(0, 200)), res.status)
      }
      const reply = JSON.parse(body) as ResponsesReply
      const texts: string[] = []
      const calls: ToolCall[] = []
      let refused = false
      for (const item of reply.output ?? []) {
        if (item.type === 'message') {
          for (const c of item.content ?? []) {
            if (c.type === 'output_text' && c.text) texts.push(c.text)
            else if (c.type === 'refusal') {
              refused = true
              if (c.refusal) texts.push(c.refusal)
            }
          }
        } else if (item.type === 'function_call' && item.name) {
          let input: Record<string, unknown> = {}
          try {
            input = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {}
          } catch {
            input = {}
          }
          calls.push({ id: item.call_id ?? `call_${calls.length}`, name: item.name, input })
        }
      }
      return { text: texts.join('\n').trim(), calls, refused }
    }
  }
}

export function modelClient(
  config: ProviderConfig,
  apiKey: string,
  fetcher?: typeof fetch
): ModelClient {
  return config.kind === 'openai'
    ? openaiClient(config, apiKey, fetcher)
    : anthropicClient(config, apiKey, fetcher)
}
