import { describe, expect, it } from 'vitest'
import type { Folder, UIState } from '@shared/types'
import { FOLDER_COLORS_DARK, FOLDER_COLORS_LIGHT } from '@shared/defaults'
import { hexToRgb } from '@shared/theme'
import { groupColorChannels, groupColorHex, groupColorVars, nextGroupColor } from '../groups'

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
    const palette = Object.keys(FOLDER_COLORS_LIGHT)
    expect(nextGroupColor(stateWithFolders([]), 's1')).toBe(palette[0])
    const used = stateWithFolders([folder('a', 's1', 'blue'), folder('b', 's1', 'green')])
    expect(nextGroupColor(used, 's1')).toBe('orange')
  })

  it('ignores the groups of other spaces and colourless folders', () => {
    const state = stateWithFolders([folder('a', 's2', 'blue'), folder('b', 's1')])
    expect(nextGroupColor(state, 's1')).toBe('blue')
  })

  it('cycles once every colour is taken', () => {
    const palette = Object.keys(FOLDER_COLORS_LIGHT) as Array<Folder['color'] & string>
    const all = palette.map((c, i) => folder(`f${i}`, 's1', c))
    expect(nextGroupColor(stateWithFolders(all), 's1')).toBe(palette[0])
    expect(nextGroupColor(stateWithFolders([...all, folder('x', 's1', 'blue')]), 's1')).toBe(
      palette[1]
    )
  })

  it('cycles the same nine keys in both schemes', () => {
    expect(Object.keys(FOLDER_COLORS_DARK)).toEqual(Object.keys(FOLDER_COLORS_LIGHT))
  })

  // §9.14: one set a scheme – the scheme is an argument, never read from the environment.
  it('picks the scheme’s set', () => {
    expect(groupColorHex('blue', 'light')).toBe(FOLDER_COLORS_LIGHT.blue)
    expect(groupColorHex('blue', 'dark')).toBe(FOLDER_COLORS_DARK.blue)
    expect(groupColorHex('blue', 'light')).not.toBe(groupColorHex('blue', 'dark'))
    expect(groupColorChannels('blue', 'light')).toBe(hexToRgb(FOLDER_COLORS_LIGHT.blue)!.join(' '))
    expect(groupColorChannels('blue', 'dark')).toBe(hexToRgb(FOLDER_COLORS_DARK.blue)!.join(' '))
    expect(groupColorChannels('blue', 'light')).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
  })

  it('paints colourless folders grey in either scheme', () => {
    expect(groupColorHex(undefined, 'light')).toBe(FOLDER_COLORS_LIGHT.grey)
    expect(groupColorHex(null, 'dark')).toBe(FOLDER_COLORS_DARK.grey)
    expect(groupColorChannels(undefined, 'light')).toBe(groupColorChannels('grey', 'light'))
    expect(groupColorChannels(null, 'dark')).toBe(groupColorChannels('grey', 'dark'))
  })

  // The pair an element carries, from which main.css derives `--zen-group-rgb` per theme.
  it('hands an element both schemes’ channels', () => {
    expect(groupColorVars('green')).toEqual({
      '--zen-group-rgb-light': groupColorChannels('green', 'light'),
      '--zen-group-rgb-dark': groupColorChannels('green', 'dark')
    })
    expect(groupColorVars(undefined)).toEqual(groupColorVars('grey'))
  })
})
