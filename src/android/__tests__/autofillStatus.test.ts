import { describe, expect, it } from 'vitest'
import { statusFrom } from '../platform'

describe('statusFrom (Kotlin’s autofill.status reply)', () => {
  it('reads the enabled flag and the service name, field by field', () => {
    expect(statusFrom({ enabled: true, service: 'com.example/.Service' })).toEqual({
      enabled: true,
      service: 'com.example/.Service'
    })
    expect(statusFrom({ enabled: true, service: '' })).toEqual({ enabled: true, service: null })
    expect(statusFrom({ enabled: 'yes', service: 42 })).toEqual({ enabled: false, service: null })
  })

  it('treats a missing or malformed reply as no service', () => {
    expect(statusFrom(null)).toEqual({ enabled: false, service: null })
    expect(statusFrom(undefined)).toEqual({ enabled: false, service: null })
    expect(statusFrom('enabled')).toEqual({ enabled: false, service: null })
    expect(statusFrom({})).toEqual({ enabled: false, service: null })
  })
})
