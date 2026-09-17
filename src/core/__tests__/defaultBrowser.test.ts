import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '../browser'
import { DefaultBrowserService } from '../defaultBrowser'
import { DEFAULT_PROMO_STATE, PROMO_FIRST_SESSION } from '../../shared/defaultBrowser'
import type { DefaultBrowserPromoState } from '../../shared/types'

interface Fake {
  browser: Browser
  settings: { onboardingDone: boolean; defaultBrowserPromo: DefaultBrowserPromoState }
  host: { isDefault: boolean | null; requests: number; requestAnswer: boolean | null }
  commit: ReturnType<typeof vi.fn>
}

function fake(options: {
  supported?: boolean
  onboardingDone?: boolean
  isDefault?: boolean | null
  requestAnswer?: boolean | null
  promo?: Partial<DefaultBrowserPromoState>
}): Fake {
  const settings = {
    onboardingDone: options.onboardingDone ?? true,
    defaultBrowserPromo: { ...DEFAULT_PROMO_STATE, ...options.promo }
  }
  const host = {
    isDefault: options.isDefault ?? false,
    requests: 0,
    requestAnswer: options.requestAnswer ?? null
  }
  const commit = vi.fn()
  const browser = {
    platform: {
      app: {
        isDefaultBrowser: async () => host.isDefault,
        requestDefaultBrowser: async () => {
          host.requests++
          if (host.requestAnswer !== null) host.isDefault = host.requestAnswer
          return host.requestAnswer
        }
      }
    },
    state: {
      capabilities: { defaultBrowser: options.supported ?? true },
      settings,
      commit
    }
  }
  return { browser: browser as unknown as Browser, settings, host, commit }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('DefaultBrowserService', () => {
  it('stays inert on hosts without the capability', async () => {
    const { browser, settings, commit } = fake({ supported: false })
    const service = new DefaultBrowserService(browser)
    service.start()
    service.onForeground()
    await settle()
    expect(settings.defaultBrowserPromo.sessions).toBe(0)
    expect(service.status()).toEqual({ isDefault: null, prompt: null })
    expect(commit).not.toHaveBeenCalled()
    expect(await service.request('sheet')).toBeNull()
  })

  it('counts a session per start once onboarding is done and asks the host for the role', async () => {
    const { browser, settings } = fake({ isDefault: false })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(settings.defaultBrowserPromo.sessions).toBe(1)
    expect(service.status()).toEqual({ isDefault: false, prompt: null })
  })

  it('does not count sessions before onboarding; finishing onboarding is the first one', async () => {
    const { browser, settings } = fake({ onboardingDone: false })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(settings.defaultBrowserPromo.sessions).toBe(0)
    settings.onboardingDone = true
    service.onOnboardingDone()
    await settle()
    expect(settings.defaultBrowserPromo.sessions).toBe(1)
  })

  it('puts the sheet up in the session the rules say, and remembers it', async () => {
    const { browser, settings } = fake({ promo: { sessions: PROMO_FIRST_SESSION - 1 } })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(service.status().prompt).toBe('sheet')
    expect(settings.defaultBrowserPromo.promptedAt).toBe(PROMO_FIRST_SESSION)
    // Coming back to the foreground keeps the open sheet, it does not stack another prompt.
    service.onForeground()
    await settle()
    expect(service.status().prompt).toBe('sheet')
  })

  it('"Not now" counts a dismissal and takes the sheet down', async () => {
    const { browser, settings, commit } = fake({ promo: { sessions: PROMO_FIRST_SESSION - 1 } })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    service.dismiss('sheet')
    expect(service.status().prompt).toBeNull()
    expect(settings.defaultBrowserPromo.dismissals).toBe(1)
    expect(commit).toHaveBeenCalled()
  })

  it('"Set as default" hands over to the host, ends the campaign and reads the role back', async () => {
    const { browser, settings, host } = fake({
      promo: { sessions: PROMO_FIRST_SESSION - 1 },
      requestAnswer: true
    })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(service.status().prompt).toBe('sheet')
    const result = await service.request('sheet')
    expect(result).toBe(true)
    expect(host.requests).toBe(1)
    expect(settings.defaultBrowserPromo.done).toBe(true)
    expect(service.status()).toEqual({ isDefault: true, prompt: null })
  })

  it('a request from onboarding does not end the campaign', async () => {
    const { browser, settings } = fake({ onboardingDone: false, requestAnswer: false })
    const service = new DefaultBrowserService(browser)
    await service.request('onboarding')
    expect(settings.defaultBrowserPromo.done).toBe(false)
  })

  it('reads the role again when the host cannot answer the request (settings screen)', async () => {
    const { browser, host } = fake({ requestAnswer: null })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    host.isDefault = true
    expect(await service.request('settings')).toBe(true)
    expect(service.status().isDefault).toBe(true)
  })

  it('drops any prompt the moment the role turns out to be held', async () => {
    const { browser, host } = fake({ promo: { sessions: PROMO_FIRST_SESSION - 1 } })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(service.status().prompt).toBe('sheet')
    host.isDefault = true
    service.onForeground()
    await settle()
    expect(service.status()).toEqual({ isDefault: true, prompt: null })
  })

  it('shows the banner in a session between sheets', async () => {
    const { browser } = fake({
      promo: { sessions: PROMO_FIRST_SESSION, promptedAt: PROMO_FIRST_SESSION, dismissals: 1 }
    })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(service.status().prompt).toBe('banner')
    service.dismiss('banner')
    expect(service.status().prompt).toBeNull()
  })
})
