import { defineApp } from 'convex/server'
import { v } from 'convex/values'
import rateLimiter from '@convex-dev/rate-limiter/convex.config'

const app = defineApp({
  env: {
    /** Clerk Frontend API URL, the issuer of the website's JWTs (`https://clerk.<domain>`). */
    CLERK_JWT_ISSUER_DOMAIN: v.string(),
    /** Clerk Backend API key: deleting a user from the website. */
    CLERK_SECRET_KEY: v.string(),
    /** Svix signing secret of the Clerk webhook endpoint (`whsec_…`). */
    CLERK_WEBHOOK_SECRET: v.optional(v.string()),
    /** The accounts website, where a device's link code is entered. */
    ACCOUNTS_SITE_URL: v.string(),
    /** P-256 private JWK with a `kid`: signs linked devices' access tokens. */
    DEVICE_JWT_PRIVATE_KEY: v.string()
  }
})
app.use(rateLimiter)

export default app
