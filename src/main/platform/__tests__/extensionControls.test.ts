import { describe, expect, it } from 'vitest'
import type { ExtensionControl } from '../../../shared/types'
import { ExtensionControls } from '../extensionApi/controls'

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

  it('a key whose value changed is a change – a list by its entries (startup pages)', () => {
    const published: Array<Record<string, ExtensionControl>> = []
    const controls = new ExtensionControls({
      setExtensionControls: (map) => {
        published.push(map)
      }
    })
    const pages = (value: string[]): Record<string, ExtensionControl> => ({
      'startup.pages': { extensionId: NEW, name: 'Pages', value }
    })
    controls.publish('startupPages', pages(['https://a.example/']))
    controls.publish('startupPages', pages(['https://a.example/']))
    expect(published).toHaveLength(1)
    controls.publish('startupPages', pages(['https://a.example/', 'https://b.example/']))
    expect(published).toHaveLength(2)
    controls.publish('startupPages', pages(['https://b.example/', 'https://a.example/']))
    expect(published).toHaveLength(3)
    // A scalar value the same way; a list against a scalar is a change.
    const mode = (value: string | string[]): Record<string, ExtensionControl> => ({
      'startup.mode': { extensionId: NEW, name: 'Pages', value }
    })
    controls.publish('startupPages', mode('pages'))
    controls.publish('startupPages', mode('pages'))
    expect(published).toHaveLength(4)
    controls.publish('startupPages', mode(['pages']))
    expect(published).toHaveLength(5)
  })
})
