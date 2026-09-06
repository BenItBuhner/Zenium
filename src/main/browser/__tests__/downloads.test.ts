import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uniquePath } from '../downloads'

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
