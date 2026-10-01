/**
 * Where the Zenium account service lives: the Convex deployment's data API (`/api/query`,
 * `/api/mutation`), its HTTP actions (the device sign-in and the token refresh), and the accounts
 * website a sign-in opens in a new tab. A build talks to one set, fixed when it is built:
 * production unless `ZENIUM_ACCOUNTS_ENV=dev` was set for the build (`define` in
 * electron.vite.config.ts and vite.android.config.ts); a build without the constant – the test
 * runner – is production too, and a suite that wants the development deployment names it.
 */

export type AccountsEnv = 'dev' | 'prod'

export interface AccountEndpoints {
  env: AccountsEnv
  /** The Convex deployment (`https://<name>.convex.cloud`): the data API. */
  cloudUrl: string
  /** The deployment's HTTP actions (`https://<name>.convex.site`): sign-in and refresh. */
  siteUrl: string
  /** The accounts website: what a person signs in on (the new tab's origin). */
  websiteUrl: string
}

/**
 * The two deployments. PRODUCTION IS NOT DEPLOYED YET: its Convex URLs are placeholders that
 * resolve nowhere (a build against them reports the service as unreachable), to be replaced here
 * – and only here – once the production deployment exists.
 */
export const ACCOUNT_ENDPOINTS: Readonly<Record<AccountsEnv, AccountEndpoints>> = {
  dev: {
    env: 'dev',
    cloudUrl: 'https://lovable-butterfly-908.convex.cloud',
    siteUrl: 'https://lovable-butterfly-908.convex.site',
    websiteUrl: 'https://dev.zenium-accounts.pages.dev'
  },
  prod: {
    env: 'prod',
    cloudUrl: 'https://PROD-PENDING.convex.cloud',
    siteUrl: 'https://PROD-PENDING.convex.site',
    websiteUrl: 'https://zenium.techlitnow.com'
  }
}

/** Replaced at build time with `"dev"` or `"prod"`; undeclared where nothing defines it (tests). */
declare const __ZENIUM_ACCOUNTS_ENV__: string | undefined

/** The deployment this build was made for (`ZENIUM_ACCOUNTS_ENV`; production when unset or unknown). */
export function buildAccountsEnv(): AccountsEnv {
  const env = typeof __ZENIUM_ACCOUNTS_ENV__ === 'string' ? __ZENIUM_ACCOUNTS_ENV__ : ''
  return env === 'dev' ? 'dev' : 'prod'
}

export function accountEndpoints(env: AccountsEnv = buildAccountsEnv()): AccountEndpoints {
  return ACCOUNT_ENDPOINTS[env]
}
