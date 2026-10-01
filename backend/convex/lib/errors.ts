import { ConvexError } from 'convex/values'

/**
 * Every refusal a client is expected to act on. Clients read `data.code` (the Convex HTTP API
 * returns it as `errorData`) and phrase it themselves; the message is for logs.
 */
export type ErrorCode =
  | 'unauthenticated'
  | 'revoked'
  | 'account-deleted'
  | 'bad-name'
  | 'too-large'
  | 'quota'
  | 'link-not-found'
  | 'link-expired'
  | 'link-used'
  | 'rate-limited'
  | 'forbidden'

export function fail(code: ErrorCode, message: string): never {
  throw new ConvexError({ code, message })
}
