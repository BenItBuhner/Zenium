import type { AuthConfig } from 'convex/server'

/**
 * Two issuers. Clerk signs the accounts website in (JWT template `convex`); the deployment
 * itself signs linked devices' access tokens (`http.ts`, ES256, JWKS at
 * `/.well-known/jwks.json`). Further sign-in methods (Google, passkeys) are Clerk settings: they
 * change neither list.
 */
/* eslint-disable @convex-dev/no-process-env -- evaluated at push time, outside the function runtime that provides the typed `env` */
const clerkIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN ?? ''
const siteUrl = process.env.CONVEX_SITE_URL ?? ''
/* eslint-enable @convex-dev/no-process-env */

export default {
  providers: [
    {
      domain: clerkIssuer,
      applicationID: 'convex'
    },
    {
      type: 'customJwt',
      // DEVICE_AUDIENCE in lib/limits.ts; this file is evaluated on its own.
      applicationID: 'zenium-device',
      issuer: siteUrl,
      jwks: `${siteUrl}/.well-known/jwks.json`,
      algorithm: 'ES256'
    }
  ]
} satisfies AuthConfig
