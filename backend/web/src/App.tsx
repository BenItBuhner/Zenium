import { SignIn, UserButton } from '@clerk/clerk-react'
import { useConvexAuth, useMutation } from 'convex/react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../../convex/_generated/api'
import { describeError } from './errors'
import { HomePage } from './HomePage'
import { LinkPage } from './LinkPage'

function Layout({ children, signedIn }: { children: ReactNode; signedIn: boolean }) {
  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/">
          <span className="mark" aria-hidden="true" />
          Zenium
        </a>
        {signedIn && <UserButton />}
      </header>
      <main className="content">{children}</main>
      <footer className="foot">
        Your synced data is end-to-end encrypted. We never see your passphrase.
      </footer>
    </div>
  )
}

/** The account row exists from the first signed-in visit on (the Clerk webhook may lag). */
function useEnsureAccount(enabled: boolean): { ready: boolean; error: string | null } {
  const ensure = useMutation(api.account.ensure)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    ensure({})
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeError(e))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, ensure])
  return { ready, error }
}

export function App() {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const account = useEnsureAccount(isAuthenticated)
  const isLink = window.location.pathname.replace(/\/+$/, '') === '/link'

  if (isLoading)
    return (
      <Layout signedIn={false}>
        <p className="muted centre">Loading…</p>
      </Layout>
    )

  if (!isAuthenticated)
    return (
      <Layout signedIn={false}>
        <section className="intro">
          <h1>{isLink ? 'Sign in to link Zenium' : 'Your Zenium account'}</h1>
          <p className="muted">
            {isLink
              ? 'Sign in or create an account, then confirm the code Zenium shows.'
              : 'Sync your tabs, bookmarks and settings across your devices.'}
          </p>
        </section>
        <div className="clerk">
          <SignIn
            routing="hash"
            withSignUp
            forceRedirectUrl={window.location.href}
            signUpForceRedirectUrl={window.location.href}
          />
        </div>
      </Layout>
    )

  return (
    <Layout signedIn>
      {account.error ? (
        <p className="error">{account.error}</p>
      ) : !account.ready ? (
        <p className="muted centre">Loading…</p>
      ) : isLink ? (
        <LinkPage />
      ) : (
        <HomePage />
      )}
    </Layout>
  )
}
