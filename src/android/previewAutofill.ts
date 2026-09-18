import type { Browser } from '@core/browser'
import { normalizeOrigin, siteLabel } from '@core/credentials/origins'
import type { FormFieldKind, FormGroup, Tab } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import {
  cancelPassphrase,
  closeAutofillEdit,
  openAutofillEdit,
  withPassphrase
} from '@renderer/lib/autofill'
import { browserStore, openOverlay, uiStore } from '@renderer/lib/ui'
import type { HostGlobal } from './boot'
import type { PreviewAutofillSurface } from './previewSpec'

/*
 * The autofill surfaces staged for the preview host (`autofill=<surface>` in a preview state):
 * prompts queued and pickers shown through the core's own doors (`AutofillService.present`,
 * `presentPicker`), so the chrome renders them exactly as the engine's would arrive, with
 * sample data and nothing saved behind them; the managers on a vault unlocked through the
 * preview's keystore stand-in and seeded with an address, two cards and a passkey record.
 */

/** The sample site when no tab is open to take one from. */
const SITE = 'shop.example'
const ORIGIN = `https://${SITE}`

/**
 * The site a prompt names, taken from the active tab the way the engine takes it from the
 * submitted page, so the URL bar and the prompt agree; the sample site when there is no tab.
 */
function siteOf(tab: Tab | null): { origin: string; site: string } {
  const origin = tab ? normalizeOrigin(tab.url) : ''
  return origin ? { origin, site: siteLabel(origin) } : { origin: ORIGIN, site: SITE }
}

/** A stand-in favicon for `site`: a 16 px tile with its initial. */
function faviconFor(site: string): string {
  const initial = (site.replace(/^www\./, '').charAt(0) || 's').toUpperCase()
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='3' fill='#2b7de9'/><text x='8' y='12' text-anchor='middle' font-family='sans-serif' font-size='11' font-weight='700' fill='#fff'>${initial}</text></svg>`
    )
  )
}

/** The host's entry for a view's events (`bootAndroid` publishes it as `__zenHost`). */
function previewHost(): HostGlobal {
  return (window as unknown as { __zenHost: HostGlobal }).__zenHost
}

/** Put every autofill surface away, so a new state starts from none (the states do not stack). */
export async function clearAutofill(browser: Browser): Promise<void> {
  const state = browserStore.get().state
  for (const prompt of state?.autofill.prompts ?? []) browser.autofill.respond(prompt.id, null)
  if (state?.autofill.picker) await browser.autofill.pick(state.autofill.picker.id, null)
  closeAutofillEdit()
  // A passphrase ask in flight ends refused, so the next state's ask is not turned away.
  cancelPassphrase()
  uiStore.set({ autofillPassphrase: null, autofillPromptCollapsed: null })
}

/** Stage `surface` for the active tab. Prompts and pickers need a tab; the managers do not. */
export async function stageAutofill(
  browser: Browser,
  surface: PreviewAutofillSurface,
  tab: Tab | null
): Promise<void> {
  const tabId = tab?.id ?? null
  const { origin, site } = siteOf(tab)
  switch (surface) {
    case 'save-login':
    case 'update-login':
      if (!tabId) return
      // The site's favicon is the desktop prompt's title glyph: a cross-origin frame's cannot
      // be read, so a stand-in arrives the way a page's would, through the view's favicon event.
      previewHost().viewEvent(tabId, 'favicon', JSON.stringify({ url: faviconFor(site) }))
      void browser.autofill.present({
        id: `preview-${surface}`,
        kind: surface,
        tabId,
        origin,
        site,
        username: 'ada@example.com',
        existingId: surface === 'update-login' ? 'preview-existing' : null
      })
      return
    case 'save-address':
      if (!tabId) return
      void browser.autofill.present({
        id: 'preview-save-address',
        kind: 'save-address',
        tabId,
        origin,
        site,
        address: {
          country: 'GB',
          name: 'Ada Lovelace',
          organization: '',
          streetAddress: '12 St James\u2019s Square',
          locality: 'London',
          region: '',
          postalCode: 'SW1Y 4LB',
          sortingCode: '',
          phone: '+44 20 7946 0000',
          email: 'ada@example.com'
        },
        preview: '12 St James\u2019s Square, London SW1Y 4LB'
      })
      return
    case 'save-card':
      if (!tabId) return
      void browser.autofill.present({
        id: 'preview-save-card',
        kind: 'save-card',
        tabId,
        origin,
        site,
        last4: '4242',
        network: 'visa',
        expMonth: 12,
        expYear: 2031,
        name: 'Ada Lovelace'
      })
      return
    case 'passkey-account':
      void browser.autofill.present({
        id: 'preview-passkey-account',
        kind: 'passkey-account',
        tabId,
        rpId: site,
        accounts: [
          { credentialId: 'preview-cred-1', userName: 'ada@example.com' },
          { credentialId: 'preview-cred-2', userName: 'ada.lovelace' }
        ]
      })
      return
    case 'picker':
    case 'picker-address':
    case 'picker-card': {
      if (!tabId) return
      // The picker is the core's own, built from a seeded vault by the focus event the forms
      // script would send: its rows fill (into nothing, here) and ask for the passphrase behind
      // a passphrase vault (`?vault=none`), where they wear the lock.
      await unlockAndSeed(browser, { logins: origin })
      const group: FormGroup =
        surface === 'picker-address' ? 'address' : surface === 'picker-card' ? 'card' : 'login'
      const kind: FormFieldKind =
        group === 'address' ? 'name' : group === 'card' ? 'cc-number' : 'username'
      browser.autofill.handleEvent(tabId, {
        type: 'focus',
        group,
        formId: 'preview-form',
        fieldId: 'preview-field',
        kind,
        // The field, somewhere in the page; the strip docks above the keyboard regardless.
        rect: { x: 16, y: 320, width: 380, height: 44 },
        hasValue: false,
        fields: [{ id: 'preview-field', kind, hasValue: false }]
      })
      return
    }
    case 'manager-locked':
      // The vault as the preview starts it – locked, so the section shows its gate – which an
      // earlier state's unlock must not have undone.
      browser.passwords.lock()
      await openOverlay('settings', tabId, null, null, 'autofill')
      return
    case 'manager-empty':
      await unlockAndSeed(browser, { seed: false })
      await openOverlay('settings', tabId, null, null, 'autofill')
      return
    case 'manager':
    case 'edit-address':
    case 'edit-card':
    case 'passphrase': {
      const seeded = await unlockAndSeed(browser)
      await openOverlay('settings', tabId, null, null, 'autofill')
      if (surface === 'edit-address') openAutofillEdit({ kind: 'address', id: null })
      else if (surface === 'edit-card') openAutofillEdit({ kind: 'card', id: seeded.cardId })
      else if (surface === 'passphrase') {
        const copy = {
          title: 'Unlock to copy',
          description:
            'Your vault passphrase copies the number of Visa \u2022\u2022\u2022\u2022 4242.'
        }
        // Behind a passphrase vault (`?vault=none`) the copy asks for the passphrase itself, so
        // the dialog is the real one (`preview` is right; anything else shows its error). The
        // keystore stand-in approves on its own, so there the dialog is staged.
        if (seeded.passphraseVault && seeded.cardId) {
          const cardId = seeded.cardId
          void withPassphrase(copy, (passphrase) =>
            cmd('autofill.copyCardNumber', { id: cardId, passphrase })
          )
        } else uiStore.set({ autofillPassphrase: { ...copy, error: null, busy: false } })
      }
      return
    }
  }
}

/**
 * The vault open (through the preview's keystore stand-in; a passphrase vault gets `preview`
 * as its passphrase) and, unless `seed` is off, holding the sample entries the managers show.
 * With `logins`, two logins for that origin as well (one of them on its accounts subdomain), so
 * the login picker has rows and auto sign-in has no lone login to fill. Returns the first card's
 * id for the card editor and whether the vault is behind a passphrase (`?vault=none`): there,
 * re-authentication asks for the passphrase in the chrome, and since unlocking with it starts
 * the grace period, that runs out here first – the staged states are the ones a minute after
 * the unlock (rows wearing the lock, the passphrase dialog), not the ones right after it.
 */
async function unlockAndSeed(
  browser: Browser,
  { seed = true, logins }: { seed?: boolean; logins?: string } = {}
): Promise<{ cardId: string | null; passphraseVault: boolean }> {
  const passwords = browser.passwords
  let outcome = await passwords.unlock()
  if (outcome.status === 'setup-passphrase' || outcome.status === 'passphrase')
    outcome = await passwords.unlock('preview')
  const status = passwords.status()
  const passphraseVault = status.protection.passphrase && !status.osReauth
  const settings = browser.state.settings.passwords
  if (passphraseVault && settings.reauthGraceSeconds !== 0)
    await cmd('settings.update', { passwords: { ...settings, reauthGraceSeconds: 0 } })
  if (outcome.status !== 'ok' || !seed) return { cardId: null, passphraseVault }
  const store = browser.passwords.store
  if (logins && store.findForOrigin(logins).length === 0) {
    store.add({ url: logins, username: 'ada@example.com', password: 'correct-horse-battery' })
    const accounts = new URL(logins)
    accounts.hostname = `accounts.${accounts.hostname.replace(/^www\./, '')}`
    store.add({ url: accounts.origin, username: 'ada.lovelace', password: 'staple-battery' })
  }
  const autofill = browser.autofill
  if (autofill.listAddresses().length === 0) {
    autofill.addAddress({
      country: 'GB',
      name: 'Ada Lovelace',
      organization: '',
      streetAddress: '12 St James\u2019s Square',
      locality: 'London',
      region: '',
      postalCode: 'SW1Y 4LB',
      sortingCode: '',
      phone: '+44 20 7946 0000',
      email: 'ada@example.com'
    })
    autofill.addAddress({
      country: 'US',
      name: 'Ada Lovelace',
      organization: 'Analytical Engines',
      streetAddress: '1 Difference Way\nSuite 400',
      locality: 'San Francisco',
      region: 'CA',
      postalCode: '94103',
      sortingCode: '',
      phone: '',
      email: ''
    })
  }
  let cards = autofill.listCards()
  if (cards.length === 0) {
    autofill.addCard({
      number: '4242424242424242',
      expMonth: 12,
      expYear: 2031,
      name: 'Ada Lovelace',
      nickname: ''
    })
    autofill.addCard({
      number: '5555555555554444',
      expMonth: 3,
      expYear: 2029,
      name: 'Ada Lovelace',
      nickname: 'Work card'
    })
    cards = autofill.listCards()
  }
  if (store.listPasskeys().length === 0) {
    store.addPasskey({
      rpId: SITE,
      rpName: 'Example Shop',
      userName: 'ada@example.com',
      userDisplayName: 'Ada Lovelace',
      credentialId: 'preview-cred-1',
      origin: ORIGIN
    })
  }
  return { cardId: cards[0]?.id ?? null, passphraseVault }
}
