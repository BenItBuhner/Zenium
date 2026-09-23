import { describe, expect, it } from 'vitest'
import {
  TOOLBAR_LAYOUT_LABELS,
  TOOLBAR_LAYOUTS,
  forcesRail,
  hasTopToolbar,
  isHorizontalTabs,
  sanitizeToolbarLayout
} from '../toolbarLayout'

describe('toolbar layout (v2 §9.37, §10.4)', () => {
  it('offers the four layouts in the card grid order, each with its caption', () => {
    expect(TOOLBAR_LAYOUTS).toEqual(['single', 'multiple', 'collapsed', 'horizontal'])
    expect(TOOLBAR_LAYOUTS.map((l) => TOOLBAR_LAYOUT_LABELS[l])).toEqual([
      'Only sidebar',
      'Sidebar and top toolbar',
      'Collapsed sidebar',
      'Horizontal tabs'
    ])
  })

  it('keeps the values older profiles wrote unchanged (the migration changes nothing)', () => {
    for (const stored of ['single', 'multiple', 'collapsed'] as const) {
      expect(sanitizeToolbarLayout(stored, 'single')).toBe(stored)
    }
  })

  it('takes the new value and falls anything else back to the default', () => {
    expect(sanitizeToolbarLayout('horizontal', 'single')).toBe('horizontal')
    expect(sanitizeToolbarLayout('vertical', 'single')).toBe('single')
    expect(sanitizeToolbarLayout(undefined, 'single')).toBe('single')
    expect(sanitizeToolbarLayout(null, 'multiple')).toBe('multiple')
    expect(sanitizeToolbarLayout(3, 'single')).toBe('single')
  })

  it('tells the horizontal layout and the layouts with a top toolbar row apart', () => {
    expect(isHorizontalTabs('horizontal')).toBe(true)
    expect(isHorizontalTabs('multiple')).toBe(false)
    expect(hasTopToolbar('multiple')).toBe(true)
    expect(hasTopToolbar('horizontal')).toBe(true)
    expect(hasTopToolbar('single')).toBe(false)
    expect(hasTopToolbar('collapsed')).toBe(false)
  })

  it('names the layouts that fix the sidebar at the rail: Collapsed sidebar and Horizontal tabs, not the two that leave the width to the setting', () => {
    expect(forcesRail('collapsed')).toBe(true)
    expect(forcesRail('horizontal')).toBe(true)
    expect(forcesRail('single')).toBe(false)
    expect(forcesRail('multiple')).toBe(false)
  })
})
