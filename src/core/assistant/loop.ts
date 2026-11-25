/**
 * The built-in agent's loop: Claude, the browser's own MCP tools, and one local tool
 * (`remember`). It runs one step at a time and hands its state back after each one, so the
 * caller can save it and pick the task up again after a restart – or, once the hosted relay is
 * deployed, on the server, where the same loop drives the user's browsers through it.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { McpClient, McpToolResult } from './mcpClient'

export const ASSISTANT_MODEL = 'claude-opus-5-5'
/** Tool calls one task may make before it stops and says so. */
export const MAX_STEPS = 50
export const MAX_MEMORY_FACTS = 50
export const MAX_FACT_CHARS = 200

type MessageParam = Anthropic.Beta.BetaMessageParam
type ContentBlock = Anthropic.Beta.BetaContentBlock

export interface LoopState {
  messages: MessageParam[]
  steps: number
}

export type StepOutcome =
  { kind: 'continue' } | { kind: 'done'; answer: string } | { kind: 'failed'; error: string }

export interface LoopDeps {
  anthropic: Anthropic
  mcp: McpClient
  /** The facts the user agreed the agent may keep, oldest first. */
  memory: () => string[]
  remember: (fact: string) => string
  /** The user's search engine, so answers come from what they would see. */
  searchEngine: string
  now?: () => Date
}

const REMEMBER_TOOL: Anthropic.Beta.BetaTool = {
  name: 'remember',
  description: `Save one short fact about the user for later conversations (at most ${MAX_FACT_CHARS} characters, ${MAX_MEMORY_FACTS} facts in all; the oldest goes when full). Only call this after the user said yes to keeping it.`,
  input_schema: {
    type: 'object',
    properties: { fact: { type: 'string' } },
    required: ['fact']
  }
}

export function systemPrompt(deps: Pick<LoopDeps, 'memory' | 'searchEngine'>): string {
  const facts = deps.memory()
  return [
    "You are Zenium's built-in agent, working inside the user's own browser through its tools.",
    'Start with zen_session {"action":"start"} named after the task, work in background mode in your own tabs, and end the session with closeTabs when you are done unless the user wants the pages kept.',
    `To look something up, search with the user's search engine (${deps.searchEngine}) in a tab of your own and read the pages, then answer with the links you used.`,
    'Keep answers short and plain. Ask the user before anything that sends, buys, posts, books or deletes, and stop there until they answer.',
    'If a fact would help in later conversations, offer to remember it in one short question at the end; call remember only after a yes.',
    facts.length ? `What you know about the user:\n${facts.map((f) => `- ${f}`).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

function toolResultContent(
  result: McpToolResult
): Anthropic.Beta.BetaToolResultBlockParam['content'] {
  const out: Exclude<Anthropic.Beta.BetaToolResultBlockParam['content'], string | undefined> = []
  for (const c of result.content ?? []) {
    if (c.type === 'text' && c.text) out.push({ type: 'text', text: c.text })
    else if (c.type === 'image' && c.data && c.mimeType)
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: c.mimeType as 'image/png' | 'image/jpeg',
          data: c.data
        }
      })
  }
  return out.length ? out : [{ type: 'text', text: '(no output)' }]
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * One model call and the tool calls it asked for. Appends to `state` in place: the caller
 * saves it after every step.
 */
export async function step(
  state: LoopState,
  deps: LoopDeps,
  tools: Anthropic.Beta.BetaTool[],
  signal?: AbortSignal
): Promise<StepOutcome> {
  if (state.steps >= MAX_STEPS)
    return {
      kind: 'done',
      answer: `I stopped after ${MAX_STEPS} steps without finishing. Tell me to continue, or narrow the task.`
    }
  let response: Anthropic.Beta.BetaMessage
  try {
    response = await deps.anthropic.beta.messages.create(
      {
        model: ASSISTANT_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: systemPrompt(deps),
        tools: [...tools, REMEMBER_TOOL],
        messages: state.messages
      },
      { signal }
    )
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError)
      return { kind: 'failed', error: 'The API key was refused. Check it in Settings → Agent.' }
    if (error instanceof Anthropic.RateLimitError)
      return { kind: 'failed', error: 'The API is rate limiting this key. Try again in a minute.' }
    if (error instanceof Anthropic.APIError)
      return { kind: 'failed', error: `The model could not answer (HTTP ${error.status}).` }
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  state.messages.push({ role: 'assistant', content: response.content })
  if (response.stop_reason === 'refusal')
    return { kind: 'done', answer: textOf(response.content) || 'I can’t help with that one.' }
  const calls = response.content.filter(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use'
  )
  if (response.stop_reason !== 'tool_use' || calls.length === 0)
    return { kind: 'done', answer: textOf(response.content) }
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
  for (const call of calls) {
    state.steps++
    const input = (call.input ?? {}) as Record<string, unknown>
    try {
      if (call.name === 'remember') {
        const fact = typeof input.fact === 'string' ? input.fact : ''
        results.push({ type: 'tool_result', tool_use_id: call.id, content: deps.remember(fact) })
        continue
      }
      const result = await deps.mcp.callTool(call.name, input)
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: toolResultContent(result),
        is_error: result.isError || undefined
      })
    } catch (error) {
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: error instanceof Error ? error.message : String(error),
        is_error: true
      })
    }
  }
  // Every result of the turn in one user message.
  state.messages.push({ role: 'user', content: results })
  return { kind: 'continue' }
}

/** The browser's MCP tools as the Messages API takes them. */
export async function loadTools(mcp: McpClient): Promise<Anthropic.Beta.BetaTool[]> {
  const tools = await mcp.listTools()
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: { type: 'object', ...t.inputSchema } as Anthropic.Beta.BetaTool.InputSchema
  }))
}

/** Keep a fact within the limits: trimmed, cut at `MAX_FACT_CHARS`, the oldest dropped when full. */
export function addFact(facts: string[], fact: string): { facts: string[]; message: string } {
  const clean = fact.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)
  if (!clean) return { facts, message: 'Nothing to remember: the fact was empty.' }
  if (facts.some((f) => f.toLowerCase() === clean.toLowerCase()))
    return { facts, message: 'Already remembered.' }
  const next = [...facts, clean].slice(-MAX_MEMORY_FACTS)
  return { facts: next, message: `Remembered: ${clean}` }
}

/**
 * Add the user's follow-up to a conversation, keeping it valid: a model turn whose tool calls
 * never got their results (the task was stopped in the middle) is dropped, and a follow-up right
 * after tool results joins that same user turn.
 */
export function appendUser(state: LoopState, text: string): void {
  const last = state.messages.at(-1)
  if (
    last?.role === 'assistant' &&
    Array.isArray(last.content) &&
    last.content.some((b) => b.type === 'tool_use')
  ) {
    state.messages.pop()
    return appendUser(state, text)
  }
  if (last?.role === 'user') {
    const blocks =
      typeof last.content === 'string'
        ? [{ type: 'text' as const, text: last.content }]
        : last.content
    last.content = [...blocks, { type: 'text', text }]
    return
  }
  state.messages.push({ role: 'user', content: text })
}
