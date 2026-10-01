import { ClerkProvider, useAuth } from '@clerk/clerk-react'
import { ConvexReactClient } from 'convex/react'
import { ConvexProviderWithClerk } from 'convex/react-clerk'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const convex = new ConvexReactClient(import.meta.env.ZENIUM_CONVEX_URL)
const root = document.getElementById('root')
if (!root) throw new Error('#root is missing')

createRoot(root).render(
  <StrictMode>
    {/* Sign-in methods come from the Clerk instance's settings, so a provider enabled there
        (Google, later) appears here without a code change. */}
    <ClerkProvider
      publishableKey={import.meta.env.ZENIUM_CLERK_PUBLISHABLE_KEY}
      afterSignOutUrl="/"
      appearance={{ variables: { colorPrimary: '#5b5bd6', borderRadius: '10px' } }}
    >
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <App />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  </StrictMode>
)
