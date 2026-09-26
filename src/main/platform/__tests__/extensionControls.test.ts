import { describe, expect, it } from 'vitest'
import type { ExtensionControl } from '../../../shared/types'
import { ExtensionControls, extensionName } from '../extensionApi/controls'
import type { ApiHost } from '../extensionApi/types'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('ExtensionControls', () => {
  it('merges every API’s map, drops a publish that changes nothing and an API’s empty map', () => {
    const published: Array<Record<string, ExtensionControl>> = []
    const controls = new ExtensionControls({
      setExtensionControls: (map) => {
        published.push(map)
      }
    })
    const fonts = { 'fonts.standard': { extensionId: OLD, name: 'Older Fonts' } }
    const privacy = { 'privacy.networkPredictionEnabled': { extensionId: NEW, name: 'Guard' } }
    controls.publish('fontSettings', fonts)
    controls.publish('privacy', privacy)
    expect(published).toEqual([fonts, { ...fonts, ...privacy }])
    // The same map again reaches no one.
    controls.publish('fontSettings', { ...fonts })
    expect(published).toHaveLength(2)
    // One API letting go keeps the other's keys.
    controls.publish('fontSettings', {})
    expect(published.at(-1)).toEqual(privacy)
    expect(controls.current).toEqual(privacy)
    controls.publish('privacy', {})
    expect(published.at(-1)).toEqual({})
    // An empty map published into an empty state is no change.
    controls.publish('proxy', {})
    expect(published).toHaveLength(4)
  })

  it("republishes when the same extension moves its own value: the value is what the row's disabled control shows", () => {
    const published: Array<Record<string, ExtensionControl>> = []
    const controls = new ExtensionControls({
      setExtensionControls: (map) => {
        published.push(map)
      }
    })
    controls.publish('proxy', { proxy: { extensionId: OLD, name: 'Tunnel', value: 'pac_script' } })
    controls.publish('proxy', { proxy: { extensionId: OLD, name: 'Tunnel', value: 'pac_script' } })
    expect(published).toHaveLength(1)
    controls.publish('proxy', { proxy: { extensionId: OLD, name: 'Tunnel', value: 'direct' } })
    expect(published).toHaveLength(2)
    expect(published.at(-1)).toEqual({
      proxy: { extensionId: OLD, name: 'Tunnel', value: 'direct' }
    })
    // A value appearing or going is a change as well.
    controls.publish('proxy', { proxy: { extensionId: OLD, name: 'Tunnel' } })
    expect(published).toHaveLength(3)
  })

  it("names an extension as the Extensions page does, falling back to the engine's record, then the id", () => {
    const host = {
      browser: { extensions: { list: () => [{ id: OLD, name: 'Tunnel' }] } },
      loaded: (id: string) => (id === NEW ? { extension: { name: 'Guard (engine)' } } : undefined)
    } as unknown as ApiHost
    expect(extensionName(host, OLD)).toBe('Tunnel')
    expect(extensionName(host, NEW)).toBe('Guard (engine)')
    expect(extensionName(host, 'cccccccccccccccccccccccccccccccc')).toBe(
      'cccccccccccccccccccccccccccccccc'
    )
  })
})
