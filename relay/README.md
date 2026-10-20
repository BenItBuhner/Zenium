# Zenium relay

The hosted MCP endpoint: an agent adds `https://<relay>/mcp`, signs in with a Zenium account,
and drives any of that account's browsers that are online. The browser still runs every tool
itself; the relay only checks tokens, picks the browser, and passes JSON-RPC messages along.

```
agent ──HTTPS /mcp──▶ Worker (index.ts) ──▶ AccountRelay (one Durable Object per account)
                                                   │  WebSocket opened by the browser
                                                   ▼
                                    Zenium (src/core/agent/relay.ts → the browser's MCP core)
```

- **Agents** authenticate with an OAuth access token from the account's Clerk instance. The
  relay publishes protected-resource metadata (RFC 9728) at
  `/.well-known/oauth-protected-resource/mcp` naming Clerk as the authorization server, and
  answers 401 with a `WWW-Authenticate` that points there, so MCP clients find the sign-in on
  their own.
- **Browsers** connect to `/connect` with the device access token they already hold from the
  Zenium account (ES256, issued by the Convex deployment), offered as a WebSocket subprotocol.
  Settings → AI Agents → "Agents from your Zenium account" turns this on per browser.
- **Picking a browser**: the relay adds a `zen_devices` tool and a `device` argument to every
  tool. Without `device`, a call goes to the browser the session used last, or to the only one
  online.
- **Approval**: each browser asks its user the first time an OAuth client connects, and
  remembers the answer by client id.

The wire format between the two ends is `src/shared/agentRelay.ts`.

## Run it locally

```bash
cd relay
npm install
cat > .dev.vars <<'EOF'
# Development Convex deployment (the one a `ZENIUM_ACCOUNTS_ENV=dev` build signs in to).
DEVICE_JWT_ISSUER=https://lovable-butterfly-908.convex.site
# Lets an agent in without OAuth, as the account of the browser that connected last.
DEV_AGENT_TOKEN=pick-a-long-random-string
EOF
npm run dev   # http://localhost:8787
```

Then, in a Zenium build signed in to the same deployment (Settings → Account):

1. Settings → AI Agents → turn on **Agents from your Zenium account**.
2. Set **Relay address** to `http://localhost:8787`. The row should say "Connected as …".
3. Point an MCP client at the relay with the development token:

   ```json
   {
     "mcpServers": {
       "zenium-relay": {
         "url": "http://localhost:8787/mcp",
         "headers": { "Authorization": "Bearer pick-a-long-random-string" }
       }
     }
   }
   ```

4. Call `zen_devices`, then any tool. The browser asks once before the agent may act.

`DEV_AGENT_TOKEN` must never be set on a deployed relay.

### Tests

```bash
npm run check                         # tsc + unit tests (token checks, device picking)
# End to end, with the relay running (`npm run dev`) and .dev.vars as in the test's header:
cd .. && RELAY_E2E_URL=http://127.0.0.1:8787 npx vitest run src/core/agent/__tests__/relayE2e.test.ts
```

## Deploy

Needs a Cloudflare account with Workers and Durable Objects (the free plan has both), and the
Clerk dashboard of the Zenium accounts instance.

1. **Clerk**: OAuth applications → Settings → Client onboarding → turn on _Publish CIMD
   support_ (so MCP clients register themselves by URL), and pick which scopes unknown clients
   may get. Note the Frontend API URL (`https://clerk.<domain>`).
2. **Variables** (`wrangler.jsonc` → `env.production.vars`, or the dashboard):
   - `DEVICE_JWT_ISSUER` – the production Convex site URL (already set).
   - `AGENT_JWT_ISSUER` – the Clerk Frontend API URL from step 1.
   - `AGENT_AUDIENCE` – optional: the relay's `https://…/mcp`, once Clerk issues tokens with
     that audience.
3. **Secret** (only if Clerk issues opaque OAuth access tokens rather than JWTs):
   `npx wrangler secret put CLERK_SECRET_KEY --env production`.
4. `npx wrangler deploy --env production`, and optionally a custom domain such as
   `mcp.zenium.techlitnow.com` on the Worker.
5. Put the deployed URL in `relayUrl` in `src/core/sync/accountEndpoints.ts` for that
   environment, so browsers find it without a Relay address.
