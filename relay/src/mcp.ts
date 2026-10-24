/**
 * The relay's own share of MCP, kept free of Workers APIs so the tests run it directly: the
 * `initialize` answer, picking which browser runs a call, the `device` argument every tool
 * gains, and the `zen_devices` tool that lists the account's browsers. Everything else an agent
 * sends is the browser's to answer.
 */

export const LATEST_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28'
]

export const RELAY_VERSION = '0.1.0'
export const DEVICES_TOOL = 'zen_devices'
export const DEVICE_ARG = 'device'

export interface DeviceRecord {
  id: string
  name: string
  kind: 'desktop' | 'laptop' | 'phone' | 'tablet'
  version: string
  /** Epoch ms of the last frame, or of the connection's end. */
  lastSeenAt: number
}

export interface DeviceView extends DeviceRecord {
  online: boolean
  /** Agent sessions that last used this browser. */
  agents: number
}

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION
}

export const RELAY_INSTRUCTIONS = [
  "This server is Zenium, a browser, reached through your user's Zenium account: it can drive any of their browsers that are online.",
  `Call ${DEVICES_TOOL} first to see which browsers are online. Every other tool takes an optional "${DEVICE_ARG}" argument (a device id or name from ${DEVICES_TOOL}); leave it out when only one browser is online, or to keep using the one you used last.`,
  'Each browser asks its user to allow you the first time you use it. Start with zen_status on the browser you picked: it explains how to work in that browser (name yourself with zen_session start, open your own tabs, pass tabId to page tools).'
].join('\n\n')

export function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: negotiateVersion(params.protocolVersion),
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false }
    },
    serverInfo: { name: 'zenium', title: 'Zenium (your browsers)', version: RELAY_VERSION },
    instructions: RELAY_INSTRUCTIONS
  }
}

export const DEVICES_TOOL_DEFINITION = {
  name: DEVICES_TOOL,
  title: 'List your browsers',
  description: `List the browsers signed in to this Zenium account that allow agents: id, name, kind, whether each is online now, when it was last seen, and how many agent sessions use it. Pass a browser's id or name as "${DEVICE_ARG}" to any other tool to run that call there.`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'List your browsers', readOnlyHint: true, openWorldHint: false }
}

const DEVICE_PROPERTY = {
  type: 'string',
  description: `Which of your browsers runs this call: an id or name from ${DEVICES_TOOL}. Optional when only one browser is online, or to keep using the one you used last.`
}

/** The browser's tools as the agent sees them through the relay: each takes `device`, plus `zen_devices`. */
export function augmentTools(tools: unknown[]): unknown[] {
  const out: unknown[] = [DEVICES_TOOL_DEFINITION]
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const t = tool as Record<string, unknown>
    if (t.name === DEVICES_TOOL) continue
    const schema = (
      t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {}
    ) as Record<string, unknown>
    const properties = (
      schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    ) as Record<string, unknown>
    out.push({
      ...t,
      inputSchema: {
        ...schema,
        type: 'object',
        properties: { ...properties, [DEVICE_ARG]: DEVICE_PROPERTY }
      }
    })
  }
  return out
}

export type DevicePick = { ok: true; device: DeviceView } | { ok: false; message: string }

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

function label(d: DeviceView): string {
  return `${JSON.stringify(d.name)} (${d.id})`
}

/**
 * Which browser runs a call. An explicit `device` is a device id, a unique prefix of one, or a
 * name (whole, any case; then a unique prefix of one). Without it: the browser this session used
 * last while it is online, else the only online one.
 */
export function pickDevice(
  devices: DeviceView[],
  requested: unknown,
  lastUsed: string | null,
  now: number
): DevicePick {
  const online = devices.filter((d) => d.online)
  if (typeof requested === 'string' && requested.trim()) {
    const q = requested.trim()
    const lower = q.toLowerCase()
    const matches =
      firstNonEmpty(
        devices.filter((d) => d.id === q),
        devices.filter((d) => d.name.toLowerCase() === lower),
        devices.filter((d) => d.id.startsWith(q)),
        devices.filter((d) => d.name.toLowerCase().startsWith(lower))
      ) ?? []
    if (matches.length === 0)
      return {
        ok: false,
        message: `No browser matches ${JSON.stringify(q)}. ${listLine(devices, now)}`
      }
    if (matches.length > 1)
      return {
        ok: false,
        message: `${JSON.stringify(q)} matches ${matches.length} browsers: ${matches.map(label).join(', ')}. Pass the id.`
      }
    const d = matches[0]
    if (!d.online)
      return {
        ok: false,
        message: `${label(d)} is offline (last seen ${ago(now - d.lastSeenAt)}). ${onlineLine(online)}`
      }
    return { ok: true, device: d }
  }
  const last = lastUsed ? online.find((d) => d.id === lastUsed) : undefined
  if (last) return { ok: true, device: last }
  if (online.length === 1) return { ok: true, device: online[0] }
  if (online.length === 0)
    return {
      ok: false,
      message: `None of your browsers is online. Open Zenium on one of them with Settings → AI Agents → "Agents from your Zenium account" turned on. ${listLine(devices, now)}`
    }
  return {
    ok: false,
    message: `${online.length} browsers are online: ${online.map(label).join(', ')}. Pass "${DEVICE_ARG}" with the id or name of the one to use.`
  }
}

function firstNonEmpty<T>(...lists: T[][]): T[] | undefined {
  return lists.find((l) => l.length > 0)
}

function onlineLine(online: DeviceView[]): string {
  return online.length
    ? `Online now: ${online.map(label).join(', ')}.`
    : 'None of your browsers is online now.'
}

function listLine(devices: DeviceView[], now: number): string {
  if (!devices.length) return 'No browser has connected to this account yet.'
  return `Your browsers: ${devices.map((d) => `${label(d)} ${d.online ? 'online' : `offline, last seen ${ago(now - d.lastSeenAt)}`}`).join('; ')}.`
}

/** `zen_devices`'s text: one line per browser, online ones first. */
export function describeDevices(
  devices: DeviceView[],
  lastUsed: string | null,
  now: number
): string {
  if (!devices.length)
    return 'No browser has connected to this Zenium account yet. On each browser you want agents to use, turn on Settings → AI Agents → "Agents from your Zenium account".'
  const sorted = [...devices].sort(
    (a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt
  )
  const lines = sorted.map((d) => {
    const state = d.online ? 'online' : `offline (last seen ${ago(now - d.lastSeenAt)})`
    const used = d.id === lastUsed ? ', you used it last' : ''
    const agents = d.agents ? `, ${d.agents} agent session${d.agents === 1 ? '' : 's'}` : ''
    return `- ${d.id}: ${JSON.stringify(d.name)}, ${d.kind}, ${state}${agents}${used}`
  })
  const online = sorted.filter((d) => d.online).length
  const hint =
    online > 1
      ? `Pass "${DEVICE_ARG}" with an id or name to choose; without it calls go to the browser you used last.`
      : online === 1
        ? `Calls go to the online browser unless you pass "${DEVICE_ARG}".`
        : 'No browser is online right now.'
  return `${lines.join('\n')}\n\n${hint}`
}
