/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import rateLimiter from '@convex-dev/rate-limiter/test'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import schema from '../convex/schema'

export const SITE_URL = 'https://test-deployment.convex.site'
export const CLERK_ISSUER = 'https://clerk.test.example'
export const ACCOUNTS_SITE = 'https://accounts.test.example'
export const WEBHOOK_SECRET = 'whsec_' + btoa('zenium-test-webhook-secret-32bytes!')

const modules = import.meta.glob('../convex/**/*.*s')

export type T = ReturnType<typeof makeT>

export function makeT() {
  const t = convexTest(schema, modules)
  rateLimiter.register(t)
  return t
}

/** The website, signed in with Clerk as `clerkUserId`. */
export function asClerkUser(t: T, clerkUserId: string, email = `${clerkUserId}@example.com`) {
  return t.withIdentity({ issuer: CLERK_ISSUER, subject: clerkUserId, email })
}

/** A linked device's identity, as its device JWT would present it. */
export function asDevice(t: T, clerkUserId: string, sessionId: string) {
  return t.withIdentity({ issuer: SITE_URL, subject: clerkUserId, sid: sessionId })
}

export async function postJson(t: T, path: string, body: unknown) {
  const res = await t.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface Linked {
  refreshToken: string
  accessToken: string
  sessionId: Id<'deviceSessions'>
  email: string
}

/** The whole device-link flow over HTTP: start, approve on the website, exchange. */
export async function linkDevice(
  t: T,
  clerkUserId: string,
  deviceName = 'Test desktop'
): Promise<Linked> {
  const secret = randomSecret()
  const start = await postJson(t, '/auth/device/start', {
    secretHash: await sha256Hex(secret),
    deviceName,
    kind: 'desktop'
  })
  if (start.status !== 200) throw new Error(`start failed: ${JSON.stringify(start.body)}`)
  await asClerkUser(t, clerkUserId).mutation(api.links.approve, {
    userCode: String(start.body['userCode'])
  })
  const token = await postJson(t, '/auth/device/token', {
    linkId: start.body['linkId'],
    deviceSecret: secret
  })
  if (token.body['status'] !== 'approved')
    throw new Error(`exchange failed: ${JSON.stringify(token.body)}`)
  const account = token.body['account'] as { email: string }
  return {
    refreshToken: String(token.body['refreshToken']),
    accessToken: String(token.body['accessToken']),
    sessionId: token.body['sessionId'] as Id<'deviceSessions'>,
    email: account.email
  }
}

/** The `code` of the typed `ConvexError` a call was refused with. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === 'object' && 'code' in data) return String(data.code)
    throw error
  }
  throw new Error('Expected the call to be refused')
}
