import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uniquePath } from '../uniquePath'

describe('uniquePath', () => {
  it('keeps the name when it is free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-dl-'))
    expect(uniquePath(dir, 'report.pdf')).toBe(join(dir, 'report.pdf'))
  })

  it('appends (n) before the extension until the name is free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-dl-'))
    writeFileSync(join(dir, 'report.pdf'), '')
    writeFileSync(join(dir, 'report(1).pdf'), '')
    expect(uniquePath(dir, 'report.pdf')).toBe(join(dir, 'report(2).pdf'))
  })

  it('handles names without an extension and dotfiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-dl-'))
    writeFileSync(join(dir, 'README'), '')
    expect(uniquePath(dir, 'README')).toBe(join(dir, 'README(1)'))
    writeFileSync(join(dir, '.env'), '')
    expect(uniquePath(dir, '.env')).toBe(join(dir, '.env(1)'))
  })
})

describe('uniquePath with reserved paths', () => {
  it('skips names that are reserved by in-flight downloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-dl-'))
    const reserved = new Set<string>([join(dir, 'a.png')])
    const taken = (p: string): boolean => reserved.has(p)
    const first = uniquePath(dir, 'a.png', taken)
    expect(first).toBe(join(dir, 'a(1).png'))
    reserved.add(first)
    expect(uniquePath(dir, 'a.png', taken)).toBe(join(dir, 'a(2).png'))
  })
})
