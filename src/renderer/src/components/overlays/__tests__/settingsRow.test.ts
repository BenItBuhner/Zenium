import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { rowControl, rowIsLabel, rowStacks, type ControlTypes } from '../settingsRow'

const Switch = (): null => null
const Choice = (): null => null
const Input = (): null => null
const Segmented = (): null => null
const Button = (): null => null

const TYPES: ControlTypes = [
  [Switch, 'switch'],
  [Choice, 'select'],
  [Input, 'input'],
  [Segmented, 'segmented']
]

const three = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' }
]

describe('rowControl', () => {
  it('recognises a single known control', () => {
    expect(rowControl(createElement(Switch), TYPES)).toBe('switch')
    expect(rowControl(createElement(Choice), TYPES)).toBe('select')
    expect(rowControl(createElement(Input), TYPES)).toBe('input')
    expect(rowControl(createElement(Segmented, { options: three }), TYPES)).toBe('segmented')
  })

  it('ignores conditionals that rendered nothing around the control', () => {
    expect(rowControl([null, createElement(Switch), false, undefined], TYPES)).toBe('switch')
  })

  it('is null for buttons, several controls and plain text', () => {
    expect(rowControl(createElement(Button), TYPES)).toBeNull()
    expect(rowControl([createElement(Switch), createElement(Input)], TYPES)).toBeNull()
    expect(rowControl('Type a keyword', TYPES)).toBeNull()
    expect(rowControl(createElement('span'), TYPES)).toBeNull()
  })
})

describe('rowIsLabel', () => {
  it('labels a switch, a select or a field but not a radio group or nothing', () => {
    expect(rowIsLabel('switch')).toBe(true)
    expect(rowIsLabel('select')).toBe(true)
    expect(rowIsLabel('input')).toBe(true)
    expect(rowIsLabel('segmented')).toBe(false)
    expect(rowIsLabel(null)).toBe(false)
  })
})

describe('rowStacks', () => {
  it('stacks fields and selects, and a segmented pill of three', () => {
    expect(rowStacks('input', createElement(Input))).toBe(true)
    expect(rowStacks('select', createElement(Choice))).toBe(true)
    expect(rowStacks('segmented', createElement(Segmented, { options: three }))).toBe(true)
  })

  it('keeps a switch and a short two-way pill beside the label', () => {
    expect(rowStacks('switch', createElement(Switch))).toBe(false)
    const short = [
      { value: 'bottom', label: 'Bottom' },
      { value: 'top', label: 'Top' }
    ]
    expect(rowStacks('segmented', createElement(Segmented, { options: short }))).toBe(false)
    expect(rowStacks(null, 'text')).toBe(false)
  })

  it('stacks a two-way pill whose labels would not fit beside the label', () => {
    const long = [
      { value: 'end', label: 'At the end' },
      { value: 'after-current', label: 'Below the current tab' }
    ]
    expect(rowStacks('segmented', createElement(Segmented, { options: long }))).toBe(true)
  })
})
