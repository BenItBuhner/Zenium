/**
 * The built-in agent's loop: a model the user chose (`providers.ts`), the browser's own MCP
 * tools, and one local tool (`remember`). It runs one step at a time and hands its state back
 * after each one, so the caller can save it and pick the task up again after a restart – or,
 * once the hosted relay is deployed, on the server, where the same loop drives the user's
 * browsers through it.
 */
import type { McpClient, McpToolResult } from './mcpClient'
import {
  ProviderError,
  type ModelClient,
  type ToolOutput,
  type ToolSpec,
  type Turn
} from './providers'

/** Tool calls one task may make before it stops and says so. */
export const MAX_STEPS = 50
export const MAX_MEMORY_FACTS = 50
export const MAX_FACT_CHARS = 200

export interface LoopState {
  turns: Turn[]
  steps: number
}

export type StepOutcome =
  { kind: 'continue' } | { kind: 'done'; answer: string } | { kind: 'failed'; error: string }

export interface LoopDeps {
  model: ModelClient
  mcp: McpClient
  /** The facts the user agreed the agent may keep, oldest first. */
  memory: () => string[]
  remember: (fact: string) => string
  /** The user's search engine, so answers come from what they would see. */
  searchEngine: string
}

const REMEMBER_TOOL: ToolSpec = {
  name: 'remember',
  description: `Save one short fact about the user for later conversations (at most ${MAX_FACT_CHARS} characters, ${MAX_MEMORY_FACTS} facts in all; the oldest goes when full). Only call this after the user said yes to keeping it.`,
  parameters: {
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

function outputOf(result: McpToolResult): ToolOutput[] {
  return (result.content ?? []).flatMap((c): ToolOutput[] =>
    c.type === 'text' && c.text
      ? [{ type: 'text' as const, text: c.text }]
      : c.type === 'image' && c.data
        ? [{ type: 'image' as const, data: c.data, mimeType: c.mimeType }]
        : []
  )
}

/**
 * One model call and the tool calls it asked for. Appends to `state` in place: the caller
 * saves it after every step.
 */
export async function step(
  state: LoopState,
  deps: LoopDeps,
  tools: ToolSpec[],
  signal?: AbortSignal
): Promise<StepOutcome> {
  if (state.steps >= MAX_STEPS)
    return {
      kind: 'done',
      answer: `I stopped after ${MAX_STEPS} steps without finishing. Tell me to continue, or narrow the task.`
    }
  let reply
  try {
    reply = await deps.model.turn(
      systemPrompt(deps),
      [...tools, REMEMBER_TOOL],
      state.turns,
      signal
    )
  } catch (error) {
    if (error instanceof ProviderError) return { kind: 'failed', error: error.message }
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  state.turns.push({ role: 'assistant', text: reply.text, calls: reply.calls })
  if (reply.refused) return { kind: 'done', answer: reply.text || 'I can’t help with that one.' }
  if (reply.calls.length === 0) return { kind: 'done', answer: reply.text }
  const results: Extract<Turn, { role: 'tool' }>['results'] = []
  for (const call of reply.calls) {
    state.steps++
    try {
      if (call.name === 'remember') {
        const fact = typeof call.input.fact === 'string' ? call.input.fact : ''
        results.push({
          id: call.id,
          name: call.name,
          content: [{ type: 'text', text: deps.remember(fact) }]
        })
        continue
      }
      const result = await deps.mcp.callTool(call.name, call.input)
      results.push({
        id: call.id,
        name: call.name,
        content: outputOf(result),
        isError: result.isError || undefined
      })
    } catch (error) {
      results.push({
        id: call.id,
        name: call.name,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true
      })
    }
  }
  state.turns.push({ role: 'tool', results })
  return { kind: 'continue' }
}

/** The browser's MCP tools as the model adapters take them. */
export async function loadTools(mcp: McpClient): Promise<ToolSpec[]> {
  const tools = await mcp.listTools()
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    parameters: { type: 'object', ...t.inputSchema }
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
 * never got their results (the task was stopped in the middle) loses those calls.
 */
export function appendUser(state: LoopState, text: string): void {
  const last = state.turns.at(-1)
  if (last?.role === 'assistant' && last.calls.length) {
    last.calls = []
    if (!last.text) state.turns.pop()
  }
  state.turns.push({ role: 'user', text })
}
