import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  NEW_WINDOW_FLAG,
  PRIVATE_WINDOW_FLAG,
  dockMenuTemplate,
  jumpListCategories,
  supportsWindowMaterial,
  windowsBuild
} from '../appShell'

describe('windows build detection', () => {
  it('reads the build number out of a Windows 10 / 11 release string', () => {
    expect(windowsBuild('10.0.22631')).toBe(22631)
    expect(windowsBuild('10.0.19045')).toBe(19045)
  })

  it('has no build for other kernels', () => {
    expect(windowsBuild('6.12.94+')).toBeNull()
    expect(windowsBuild('24.0.0')).toBeNull()
    expect(windowsBuild('6.1.7601')).toBeNull()
  })

  it('offers Mica from Windows 11 only', () => {
    expect(supportsWindowMaterial('win32', '10.0.22000')).toBe(true)
    expect(supportsWindowMaterial('win32', '10.0.26100')).toBe(true)
    expect(supportsWindowMaterial('win32', '10.0.19045')).toBe(false)
    expect(supportsWindowMaterial('linux', '10.0.22631')).toBe(false)
    expect(supportsWindowMaterial('darwin', '24.0.0')).toBe(false)
  })
})

describe('jump list', () => {
  const exe = 'C:\\Program Files\\Zenium\\zenium.exe'
  const categories = jumpListCategories(exe)

  it('lists the two new-window tasks first, then the recent documents', () => {
    expect(categories.map((c) => c.type)).toEqual(['tasks', 'recent'])
    const items = categories[0].items ?? []
    expect(items.map((i) => i.title)).toEqual(['New Window', 'New Private Window'])
    expect(items.map((i) => i.args)).toEqual([NEW_WINDOW_FLAG, PRIVATE_WINDOW_FLAG])
  })

  it('launches and draws its icon from the executable itself', () => {
    for (const item of categories[0].items ?? []) {
      expect(item.type).toBe('task')
      expect(item.program).toBe(exe)
      expect(item.iconPath).toBe(exe)
      expect(item.iconIndex).toBe(0)
    }
  })
})

describe('dock menu', () => {
  it('opens a synced or a private window in macOS title case', () => {
    const open = vi.fn()
    const template = dockMenuTemplate(open)
    expect(template.map((i) => i.label)).toEqual(['New Window', 'New Private Window'])
    const click = (item: MenuItemConstructorOptions): void => {
      const fn = item.click as (() => void) | undefined
      fn?.()
    }
    click(template[0])
    expect(open).toHaveBeenLastCalledWith('synced')
    click(template[1])
    expect(open).toHaveBeenLastCalledWith('private')
  })
})
