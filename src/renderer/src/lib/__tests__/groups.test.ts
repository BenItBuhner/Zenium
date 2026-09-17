import { describe, expect, it } from 'vitest'
import type { Folder, UIState } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { groupColorChannels, nextGroupColor } from '../groups'

function stateWithFolders(folders: Folder[]): UIState {
  return {
    folders: Object.fromEntries(folders.map((f) => [f.id, f]))
  } as unknown as UIState
}

const folder = (id: string, spaceId: string, color?: Folder['color']): Folder => ({
  id,
  spaceId,
  name: id,
  icon: '📁',
  collapsed: false,
  ...(color ? { color } : {})
})

describe('group colours', () => {
  it('gives a new group the first colour its space is not using', () => {
    const palette = Object.keys(FOLDER_COLORS)
    expect(nextGroupColor(stateWithFolders([]), 's1')).toBe(palette[0])
    const used = stateWithFolders([folder('a', 's1', 'blue'), folder('b', 's1', 'green')])
    expect(nextGroupColor(used, 's1')).toBe('orange')
  })

  it('ignores the groups of other spaces and colourless folders', () => {
    const state = stateWithFolders([folder('a', 's2', 'blue'), folder('b', 's1')])
    expect(nextGroupColor(state, 's1')).toBe('blue')
  })

  it('cycles once every colour is taken', () => {
    const palette = Object.keys(FOLDER_COLORS) as Array<Folder['color'] & string>
    const all = palette.map((c, i) => folder(`f${i}`, 's1', c))
    expect(nextGroupColor(stateWithFolders(all), 's1')).toBe(palette[0])
    expect(nextGroupColor(stateWithFolders([...all, folder('x', 's1', 'blue')]), 's1')).toBe(
      palette[1]
    )
  })

  it('paints colourless folders grey', () => {
    expect(groupColorChannels(undefined)).toBe(groupColorChannels('grey'))
    expect(groupColorChannels('blue')).toBe('76 141 255')
  })
})
