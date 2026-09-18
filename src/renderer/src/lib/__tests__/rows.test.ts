import { describe, expect, it } from 'vitest'
import { ROW_CONTROL_PADDING, rowBase, rowMinHeight } from '../rows'

describe('rows that hold a control (design language §9.21)', () => {
  it('grow around the control: a 32 px menulist makes a 40 px row on a desktop', () => {
    expect(rowMinHeight(32, false)).toBe(40)
    expect(ROW_CONTROL_PADDING).toBe(4)
  })

  it('never shrink under the base height: a 20 px switch keeps the 32 px base', () => {
    expect(rowBase(false)).toBe(32)
    expect(rowMinHeight(20, false)).toBe(32)
    expect(rowMinHeight(16, false)).toBe(32)
  })

  it('use the 44 px phone base, which a 32 px menulist does not exceed', () => {
    expect(rowBase(true)).toBe(44)
    expect(rowMinHeight(32, true)).toBe(44)
    expect(rowMinHeight(40, true)).toBe(48)
  })
})
