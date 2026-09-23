import { describe, expect, it, vi } from 'vitest'
import type { Browser } from '../browser'
import { DefaultBrowserService, PROMPT_SURFACES } from '../defaultBrowser'
import { DEFAULT_PROMO_STATE, PROMO_FIRST_SESSION } from '../../shared/defaultBrowser'
import type { AppLinkState, DefaultBrowserPromoState, Platform } from '../../shared/types'

interface Fake {
  browser: Browser
  settings: { onboardingDone: boolean; defaultBrowserPromo: DefaultBrowserPromoState }
  host: {
    isDefault: boolean | null
    requests: number
    requestAnswer: boolean | null
    /** The "Open by default" reading the host gives (DEF-06); `undefined` is a host without one. */
    appLinks: AppLinkState | null | undefined
    linkReads: number
  }
  commit: ReturnType<typeof vi.fn>
}

function fake(options: {
  supported?: boolean
  /** The host's platform; the Android chrome is where the prompts live. */
  platform?: Platform
  onboardingDone?: boolean
  isDefault?: boolean | null
  requestAnswer?: boolean | null
  appLinks?: AppLinkState | null
  promo?: Partial<DefaultBrowserPromoState>
}): Fake {
  const settings = {
    onboardingDone: options.onboardingDone ?? true,
    defaultBrowserPromo: { ...DEFAULT_PROMO_STATE, ...options.promo }
  }
  const host = {
    isDefault: options.isDefault ?? false,
    requests: 0,
    requestAnswer: options.requestAnswer ?? null,
    appLinks: options.appLinks,
    linkReads: 0
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
        },
        ...(options.appLinks !== undefined
          ? {
              appLinkState: async () => {
                host.linkReads++
                if (host.appLinks === undefined) throw new Error('no reading')
                return host.appLinks
              }
            }
          : {})
      }
    },
    state: {
      platform: options.platform ?? 'android',
      capabilities: { defaultBrowser: options.supported ?? true },
      settings,
      commit
    }
  }
  return { browser: browser as unknown as Browser, settings, host, commit }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The chrome has the sheet and the banner (as it does): what the campaign tests assume. */
const SURFACES = { promptSurfaces: true }
/** A chrome without them, for the gate that keeps the campaign inert there. */
const NO_SURFACES = { promptSurfaces: false }

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

  it('reads the "Open by default" state with the role, on the same round, and keeps it on the status (DEF-06)', async () => {
    const { browser, host } = fake({ isDefault: true, appLinks: 'allowed' })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(service.status()).toEqual({ isDefault: true, prompt: null, appLinks: 'allowed' })
    expect(host.linkReads).toBe(1)
    // The user flipped the switch in the system's screen: the return to the foreground reads it.
    host.appLinks = 'disallowed'
    service.onForeground()
    await settle()
    expect(service.status().appLinks).toBe('disallowed')
    expect(host.linkReads).toBe(2)
    // A host that cannot say this time keeps the last reading; one that throws likewise.
    host.appLinks = null
    service.onForeground()
    await settle()
    expect(service.status().appLinks).toBe('disallowed')
    host.appLinks = undefined
    service.onForeground()
    await settle()
    expect(service.status().appLinks).toBe('disallowed')
  })

  it('a host without the reading leaves the status without one', async () => {
    const { browser } = fake({ isDefault: true })
    const service = new DefaultBrowserService(browser)
    service.start()
    await settle()
    expect(service.status()).toEqual({ isDefault: true, prompt: null })
    expect(service.status()).not.toHaveProperty('appLinks')
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
    const service = new DefaultBrowserService(browser, SURFACES)
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
    const service = new DefaultBrowserService(browser, SURFACES)
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
    const service = new DefaultBrowserService(browser, SURFACES)
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
    const service = new DefaultBrowserService(browser, SURFACES)
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
    const service = new DefaultBrowserService(browser, SURFACES)
    service.start()
    await settle()
    expect(service.status().prompt).toBe('banner')
    service.dismiss('banner')
    expect(service.status().prompt).toBeNull()
  })

  describe('without prompt surfaces (a chrome with no sheet or banner)', () => {
    it('is not how the service is wired on Android: the surfaces exist and the campaign runs', async () => {
      expect(PROMPT_SURFACES).toBe(true)
      const { browser, settings } = fake({ promo: { sessions: PROMO_FIRST_SESSION - 1 } })
      const service = new DefaultBrowserService(browser)
      service.start()
      await settle()
      expect(service.status().prompt).toBe('sheet')
      expect(settings.defaultBrowserPromo.promptedAt).toBe(PROMO_FIRST_SESSION)
    })

    it('is how it is wired off Android, where the desktop program asks with its own strip', async () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        const { browser, settings } = fake({
          platform,
          promo: { sessions: PROMO_FIRST_SESSION - 1 }
        })
        const service = new DefaultBrowserService(browser)
        service.start()
        await settle()
        expect(service.status(), platform).toEqual({ isDefault: false, prompt: null })
        expect(settings.defaultBrowserPromo.sessions, platform).toBe(PROMO_FIRST_SESSION)
        expect(settings.defaultBrowserPromo.promptedAt, platform).toBeNull()
        service.dismiss('sheet')
        expect(settings.defaultBrowserPromo.dismissals, platform).toBe(0)
      }
    })

    it('counts sessions but never decides, marks or shows a prompt', async () => {
      const { browser, settings } = fake({ promo: { sessions: PROMO_FIRST_SESSION - 1 } })
      const service = new DefaultBrowserService(browser, NO_SURFACES)
      // Well past the first sheet and into where the banner and the second sheet would be due.
      for (let starts = 0; starts < PROMO_FIRST_SESSION + 10; starts++) {
        service.start()
        await settle()
        expect(service.status()).toEqual({ isDefault: false, prompt: null })
      }
      expect(settings.defaultBrowserPromo.sessions).toBe(2 * PROMO_FIRST_SESSION + 9)
      expect(settings.defaultBrowserPromo.promptedAt).toBeNull()
      expect(settings.defaultBrowserPromo.bannerAt).toBeNull()
      expect(settings.defaultBrowserPromo.dismissals).toBe(0)
      expect(settings.defaultBrowserPromo.done).toBe(false)
    })

    it('ignores a dismissal: there was nothing up to give up a turn on', async () => {
      const { browser, settings, commit } = fake({ promo: { sessions: PROMO_FIRST_SESSION } })
      const service = new DefaultBrowserService(browser, NO_SURFACES)
      service.dismiss('sheet')
      service.dismiss('banner')
      expect(settings.defaultBrowserPromo.dismissals).toBe(0)
      expect(settings.defaultBrowserPromo.bannerAt).toBeNull()
      expect(commit).not.toHaveBeenCalled()
    })

    it('still reads the role for the settings row and ends the campaign on its "Set as default"', async () => {
      const { browser, settings, host } = fake({ isDefault: false, requestAnswer: true })
      const service = new DefaultBrowserService(browser, NO_SURFACES)
      service.start()
      await settle()
      expect(service.status().isDefault).toBe(false)
      expect(await service.request('settings')).toBe(true)
      expect(host.requests).toBe(1)
      expect(settings.defaultBrowserPromo.done).toBe(true)
      expect(service.status()).toEqual({ isDefault: true, prompt: null })
    })
  })
})
