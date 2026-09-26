// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CONTENT_RULES,
  type ContentRules,
  type ResolvedContentRulesFor
} from '@shared/contentRules'

/*
 * The Android half of the content settings no WebView switch covers (PS-58, PS-69 and motion
 * sensors): Kotlin prefixes the document-start script with the core's per-site rules
 * (`window.__zenContentRules`, `TabWebView.startScriptSource`) and, for a navigation the core
 * was asked about, its resolved answer for the destination (`window.__zenResolvedRules`, tagged
 * with the site); the script installs the page-world guards of a blocked site's document from
 * them – the answer first, the pushed rules where it does not speak for this document's site –
 * before any of the page's own script runs, the same `installContentGuards` the desktop preload
 * runs in the main world. The script is an IIFE that installs on import, so each document is a
 * fresh evaluation of the module.
 */

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

type Preamble = Window & {
  __zenPageBridge?: Bridge
  __zenPageInstalled?: boolean
  __zenContentRules?: ContentRules
  __zenResolvedRules?: ResolvedContentRulesFor | null
  PaymentRequest?: unknown
}

const w = window as unknown as Preamble

interface FakeRequest {
  show(): Promise<string>
  canMakePayment(): Promise<boolean>
}

/** A page's `PaymentRequest`, as the WebView would ship it with the API turned on – one class per document, as the guard rewrites the prototype. */
function paymentRequestClass(): new () => FakeRequest {
  return class {
    show(): Promise<string> {
      return Promise.resolve('shown')
    }
    canMakePayment(): Promise<boolean> {
      return Promise.resolve(true)
    }
  }
}

/** Kotlin's preamble with the rules (and the navigation's resolved answer), then the script, as a new document evaluates them. */
async function evaluateScript(
  rules: ContentRules | undefined,
  resolved?: ResolvedContentRulesFor | null
): Promise<new () => FakeRequest> {
  vi.resetModules()
  delete w.__zenPageInstalled
  w.__zenPageBridge = { postMessage: () => undefined, onmessage: null }
  const PaymentRequest = paymentRequestClass()
  w.PaymentRequest = PaymentRequest
  if (rules === undefined) delete w.__zenContentRules
  else w.__zenContentRules = rules
  if (resolved === undefined) delete w.__zenResolvedRules
  else w.__zenResolvedRules = resolved
  await import('../pageScript')
  return PaymentRequest
}

function rulesDenying(id: keyof ContentRules, site: string): ContentRules {
  return { ...EMPTY_CONTENT_RULES, [id]: { default: 'allow', sites: { [site]: 'deny' } } }
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  delete w.PaymentRequest
  document.body.innerHTML = ''
})

describe('the Android page script and the page-world content guards', () => {
  it('refuses a blocked site’s PaymentRequest from document start and leaves no trace of the rules', async () => {
    const PaymentRequest = await evaluateScript(
      rulesDenying('payment-handler', window.location.origin)
    )
    const request = new PaymentRequest()
    await expect(request.canMakePayment()).resolves.toBe(false)
    await expect(request.show()).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(w.__zenContentRules).toBeUndefined()
  })

  it('leaves an allowed site’s APIs alone, and a document without rules too', async () => {
    const Allowed = await evaluateScript(rulesDenying('payment-handler', 'https://other.example'))
    await expect(new Allowed().canMakePayment()).resolves.toBe(true)
    const Unruled = await evaluateScript(undefined)
    await expect(new Unruled().canMakePayment()).resolves.toBe(true)
    await expect(new Unruled().show()).resolves.toBe('shown')
  })

  it('reads the core’s resolved answer for the navigation first, the pushed rules where it is another site’s', async () => {
    // The pushed document allows payment handlers everywhere; the core's answer for this
    // document's site (an extension's rule the document cannot carry) refuses them.
    const Refused = await evaluateScript(EMPTY_CONTENT_RULES, {
      site: window.location.origin,
      allowed: { 'payment-handler': false }
    })
    await expect(new Refused().canMakePayment()).resolves.toBe(false)
    expect(w.__zenResolvedRules).toBeUndefined()
    // An answer left over from the previous navigation (another site's: a form's POST or a
    // history step the WebView did not announce) decides nothing; the pushed rules do.
    const Fallback = await evaluateScript(rulesDenying('payment-handler', window.location.origin), {
      site: 'https://previous.example',
      allowed: { 'payment-handler': true }
    })
    await expect(new Fallback().canMakePayment()).resolves.toBe(false)
    // The answer allowing what the pushed rules refuse is the word too (the row's own answer wins).
    const Allowed = await evaluateScript(rulesDenying('payment-handler', window.location.origin), {
      site: window.location.origin,
      allowed: { 'payment-handler': true }
    })
    await expect(new Allowed().canMakePayment()).resolves.toBe(true)
    // A row the answer is silent on falls back to the pushed rules; a null answer reads them alone.
    const Partial = await evaluateScript(rulesDenying('payment-handler', window.location.origin), {
      site: window.location.origin,
      allowed: { sensors: true }
    })
    await expect(new Partial().canMakePayment()).resolves.toBe(false)
    const Unanswered = await evaluateScript(EMPTY_CONTENT_RULES, null)
    await expect(new Unanswered().canMakePayment()).resolves.toBe(true)
  })

  it('silences a blocked site’s motion and orientation listeners (sensors)', async () => {
    await evaluateScript(rulesDenying('sensors', window.location.origin))
    const heard = vi.fn()
    window.addEventListener('devicemotion', heard)
    window.dispatchEvent(new Event('devicemotion'))
    expect(heard).not.toHaveBeenCalled()
    const other = vi.fn()
    window.addEventListener('zen-test', other)
    window.dispatchEvent(new Event('zen-test'))
    expect(other).toHaveBeenCalledTimes(1)
  })
})
