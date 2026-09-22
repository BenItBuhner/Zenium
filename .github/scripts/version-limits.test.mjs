import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LIMITS, androidVersionCodeProblem } from './version-limits.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'version-limits.mjs')

describe('androidVersionCodeProblem', () => {
  it('mirrors the ceilings in android/app/build.gradle.kts', () => {
    expect(LIMITS).toEqual({ major: 2100, minor: 99, patch: 99 })
  })

  it('accepts every field at its ceiling, pre-releases and build metadata included', () => {
    for (const version of ['0.3.99', '0.99.0', '2100.99.99', '0.4.0-beta.0', '1.2.3+build.7']) {
      expect(androidVersionCodeProblem(version)).toBeNull()
    }
  })

  it('refuses the patch bump after X.Y.99 and names the minor bump instead', () => {
    const problem = androidVersionCodeProblem('0.3.100')
    expect(problem).toContain('0.3.100 cannot be built for Android')
    expect(problem).toContain('patch 100 > 99')
    expect(problem).toContain('Bump minor instead: 0.4.0.')
  })

  it('refuses a minor past 99 and names the major bump instead', () => {
    const problem = androidVersionCodeProblem('0.100.0')
    expect(problem).toContain('minor 100 > 99')
    expect(problem).toContain('Bump major instead: 1.0.0.')
  })

  it('lists every field that is over and gives no advice when no single bump fixes it', () => {
    const problem = androidVersionCodeProblem('2101.100.100')
    expect(problem).toContain('major 2101 > 2100, minor 100 > 99, patch 100 > 99')
    expect(problem).not.toContain('instead')
  })

  it('rejects text that is not semver', () => {
    expect(androidVersionCodeProblem('0.3')).toContain('is not a semver string')
    expect(androidVersionCodeProblem('v0.3.4')).toContain('is not a semver string')
  })
})

describe('the command line', () => {
  const run = (...args) => {
    try {
      execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' })
      return { status: 0, stderr: '' }
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) }
    }
  }

  it('is silent and exits 0 for a version Android can build', () => {
    expect(run('0.3.99')).toEqual({ status: 0, stderr: '' })
  })

  it('exits 1 with the problem for a version it cannot', () => {
    const result = run('0.3.100')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Bump minor instead: 0.4.0.')
  })

  it('exits 2 without a version', () => {
    expect(run().status).toBe(2)
  })
})
