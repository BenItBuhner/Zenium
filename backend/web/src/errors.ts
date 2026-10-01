import { ConvexError } from 'convex/values'

const MESSAGES: Record<string, string> = {
  'link-not-found': 'That code isn’t valid. Check it against the one Zenium shows.',
  'link-expired': 'That code has expired. Start signing in again in Zenium for a new one.',
  'link-used': 'That code has already been used.',
  'rate-limited': 'Too many attempts. Wait a minute and try again.',
  forbidden: 'That device isn’t on your account.',
  'account-deleted': 'This account is being deleted.',
  unauthenticated: 'Sign in to continue.'
}

/** The site phrases every refusal itself; server messages are for logs. */
export function describeError(error: unknown): string {
  if (error instanceof ConvexError) {
    const code = (error.data as { code?: unknown } | null)?.code
    if (typeof code === 'string' && code in MESSAGES) return MESSAGES[code] ?? ''
  }
  return 'Something went wrong. Try again in a moment.'
}
