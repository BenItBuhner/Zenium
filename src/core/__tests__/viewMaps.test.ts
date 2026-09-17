import { describe, expect, it } from 'vitest'
import { forgetViewRecord } from '../viewMaps'

describe('forgetViewRecord', () => {
  it('removes the view and owner on the first call and is a no-op after that', () => {
    const view = { id: 'v1' }
    const maps = {
      views: new Map<string, { id: string }>([['tab_1', view]]),
      owners: new Map<string, string>([['tab_1', 'win_1']]),
      extras: [new Map<string, string>([['tab_1', 'https']])]
    }

    expect(forgetViewRecord('tab_1', maps)).toBe(view)
    expect(maps.views.size).toBe(0)
    expect(maps.owners.size).toBe(0)
    expect(maps.extras[0].size).toBe(0)

    expect(forgetViewRecord('tab_1', maps)).toBeUndefined()
    expect(maps.views.size).toBe(0)
  })

  it('leaves other tabs in place', () => {
    const keep = { id: 'v2' }
    const maps = {
      views: new Map<string, { id: string }>([
        ['tab_1', { id: 'v1' }],
        ['tab_2', keep]
      ]),
      owners: new Map<string, string>([
        ['tab_1', 'win_1'],
        ['tab_2', 'win_2']
      ])
    }

    forgetViewRecord('tab_1', maps)
    expect([...maps.views.keys()]).toEqual(['tab_2'])
    expect(maps.owners.get('tab_2')).toBe('win_2')
  })
})
