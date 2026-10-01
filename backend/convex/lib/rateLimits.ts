import { MINUTE, HOUR, RateLimiter } from '@convex-dev/rate-limiter'
import { components } from '../_generated/api'

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  /** Unauthenticated: anyone can ask for a link code. Global, so a flood cannot fill the table. */
  linkStart: { kind: 'token bucket', rate: 300, period: MINUTE, capacity: 300 },
  /** Polling a pending link, per link: every 2 s is 30 a minute. */
  linkPoll: { kind: 'token bucket', rate: 40, period: MINUTE, capacity: 40 },
  /** Approving codes, per account: guessing codes from a signed-in account is throttled. */
  linkApprove: { kind: 'token bucket', rate: 10, period: MINUTE, capacity: 10 },
  /** Refreshing an access token, per session: hourly in normal use. */
  refresh: { kind: 'token bucket', rate: 60, period: HOUR, capacity: 20 }
})
