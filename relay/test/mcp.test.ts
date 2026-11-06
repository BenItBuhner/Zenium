import { describe, expect, it } from 'vitest'
import {
  DEVICES_TOOL,
  augmentTools,
  describeDevices,
  initializeResult,
  pickDevice,
  type DeviceView
} from '../src/mcp'

const now = 1_800_000_000_000
const dev = (id: string, name: string, online: boolean, ago = 0): DeviceView => ({
  id,
  name,
  kind: 'laptop',
  version: '1',
  lastSeenAt: now - ago,
  online,
  agents: 0
})

describe('pickDevice', () => {
  const laptop = dev('k57abc', 'Laptop', true)
  const desk = dev('k57xyz', 'Desktop', true)
  const phone = dev('j11ppp', 'Phone', false, 14 * 60_000)

  it('takes the only online browser when none is named', () => {
    const r = pickDevice([laptop, phone], undefined, null, now)
    expect(r).toEqual({ ok: true, device: laptop })
  })

  it('asks which one when several are online and the session used none', () => {
    const r = pickDevice([laptop, desk], undefined, null, now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('2 browsers are online')
  })

  it('keeps the browser the session used last', () => {
    expect(pickDevice([laptop, desk], undefined, 'k57xyz', now)).toEqual({ ok: true, device: desk })
  })

  it('matches an id, a name in any case, then unique prefixes', () => {
    expect(pickDevice([laptop, desk], 'k57abc', null, now)).toEqual({ ok: true, device: laptop })
    expect(pickDevice([laptop, desk], 'desktop', null, now)).toEqual({ ok: true, device: desk })
    expect(pickDevice([laptop, desk], 'Lap', null, now)).toEqual({ ok: true, device: laptop })
    const ambiguous = pickDevice([laptop, desk], 'k57', null, now)
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.message).toContain('matches 2 browsers')
  })

  it('says when the named browser is offline and since when', () => {
    const r = pickDevice([laptop, phone], 'phone', null, now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('is offline (last seen 14 min ago)')
  })

  it('says how to bring a browser online when none is', () => {
    const r = pickDevice([phone], undefined, null, now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('Agents from your Zenium account')
  })
})

describe('tools through the relay', () => {
  it('adds zen_devices and a device argument to every tool', () => {
    const tools = augmentTools([
      {
        name: 'browser_navigate',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false
        }
      }
    ]) as {
      name: string
      inputSchema: { properties: Record<string, unknown>; required?: string[] }
    }[]
    expect(tools.map((t) => t.name)).toEqual([DEVICES_TOOL, 'browser_navigate'])
    expect(Object.keys(tools[1].inputSchema.properties)).toEqual(['url', 'device'])
    expect(tools[1].inputSchema.required).toEqual(['url'])
  })

  it('lists browsers online first', () => {
    const text = describeDevices(
      [dev('a', 'Old', false, 3 * 3600_000), dev('b', 'New', true)],
      'b',
      now
    )
    expect(text.split('\n')[0]).toBe('- b: "New", laptop, online, you used it last')
    expect(text).toContain('- a: "Old", laptop, offline (last seen 3 h ago)')
  })

  it('negotiates the protocol version like the browser does', () => {
    expect(initializeResult({ protocolVersion: '2025-06-18' }).protocolVersion).toBe('2025-06-18')
    expect(initializeResult({ protocolVersion: '1999-01-01' }).protocolVersion).toBe('2025-11-25')
  })
})
