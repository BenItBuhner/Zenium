import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (text: string) => unknown }

describe('electron-builder mac.extendInfo', () => {
  it('is a mapping of the three TCC usage-description keys', () => {
    const parsed = yaml.load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8'))
    expect(parsed && typeof parsed === 'object').toBe(true)
    const mac = (parsed as { mac?: { extendInfo?: unknown } }).mac
    const info = mac?.extendInfo
    expect(info && typeof info === 'object' && !Array.isArray(info)).toBe(true)
    const map = info as Record<string, string>
    expect(map.NSCameraUsageDescription).toMatch(/Zenium/)
    expect(map.NSMicrophoneUsageDescription).toMatch(/Zenium/)
    expect(map.NSDownloadsFolderUsageDescription).toMatch(/Zenium/)
    expect(map).not.toHaveProperty('0')
    expect(map).not.toHaveProperty('length')
  })
})
