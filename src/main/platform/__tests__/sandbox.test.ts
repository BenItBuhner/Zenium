import { describe, expect, it } from 'vitest'
import { sandboxRequest } from '../sandbox'

describe('the sandboxed renderer client request', () => {
  it('asks for it on every platform for an ordinary user', () => {
    expect(sandboxRequest({ platform: 'linux', uid: 1000 })).toEqual({ enable: true, reason: null })
    expect(sandboxRequest({ platform: 'darwin', uid: 501 })).toEqual({ enable: true, reason: null })
    // Windows has no uid to read.
    expect(sandboxRequest({ platform: 'win32', uid: null })).toEqual({ enable: true, reason: null })
  })

  it('leaves it off for root on Linux, where Electron refuses it, and says why', () => {
    const request = sandboxRequest({ platform: 'linux', uid: 0 })
    expect(request.enable).toBe(false)
    expect(request.reason).toMatch(/running as root/)
    expect(request.reason).toMatch(/crbug\.com\/638180/)
    expect(request.reason).toMatch(/service-worker preload/)
  })

  it('does not take root on another platform for the Linux case', () => {
    expect(sandboxRequest({ platform: 'darwin', uid: 0 })).toEqual({ enable: true, reason: null })
  })
})
