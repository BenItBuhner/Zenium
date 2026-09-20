import { describe, expect, it, vi } from 'vitest'
import { protocol } from 'electron'
import { EXTENSION_RESOURCE_SCHEME } from '../extensionApi/resourceOrigin'
import { CHROME_EXTENSION_SCHEME, privilegedSchemes, registerZenScheme } from '../protocol'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn() } }))

describe('privilegedSchemes', () => {
  it('names zen, zen-extension and chrome-extension as standard schemes', () => {
    const schemes = privilegedSchemes()
    expect(schemes.map((s) => s.scheme)).toEqual([
      'zen',
      EXTENSION_RESOURCE_SCHEME,
      CHROME_EXTENSION_SCHEME
    ])
    for (const scheme of schemes) expect(scheme.privileges?.standard).toBe(true)
    // zen:// is a secure origin pages may fetch from; nothing more than standard is claimed for
    // chrome-extension:// (the engine already gives it the rest).
    expect(schemes[0].privileges).toMatchObject({ secure: true, supportFetchAPI: true })
    expect(schemes[2].privileges).toEqual({ standard: true })
  })

  it('registers exactly that list with the engine', () => {
    registerZenScheme()
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith(privilegedSchemes())
  })
})
