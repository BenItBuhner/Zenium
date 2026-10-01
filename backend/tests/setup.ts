import { SITE_URL, CLERK_ISSUER, ACCOUNTS_SITE, WEBHOOK_SECRET } from './harness'

/** A throwaway signing key per run: tests never share one with a deployment. */
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify'
])
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)

process.env['CONVEX_SITE_URL'] = SITE_URL
process.env['CLERK_JWT_ISSUER_DOMAIN'] = CLERK_ISSUER
process.env['CLERK_SECRET_KEY'] = 'sk_test_unused'
process.env['CLERK_WEBHOOK_SECRET'] = WEBHOOK_SECRET
process.env['ACCOUNTS_SITE_URL'] = ACCOUNTS_SITE
process.env['DEVICE_JWT_PRIVATE_KEY'] = JSON.stringify({ ...jwk, kid: 'test-key' })
