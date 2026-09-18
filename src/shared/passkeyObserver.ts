/**
 * Watches `navigator.credentials.create` / `.get` for WebAuthn (`publicKey`) calls and posts a
 * report to the window (`{ __zeniumPasskey: … }`) that the forms script forwards to the browser,
 * so the password manager can list the passkeys a user created and when they were last used.
 *
 * It has to run in the page's own world (that is where `navigator.credentials` lives): Android
 * injects the page script there and installs it directly; Electron's page script lives in the
 * isolated world, so the core runs `PASSKEY_OBSERVER_SOURCE` in the main world at `dom-ready`.
 * The function is self-contained on purpose: `toString()` is what ships to the page.
 */
export function installPasskeyObserver(win: Window): void {
  const w = win as Window & { __zeniumPasskeyObserver?: boolean }
  if (w.__zeniumPasskeyObserver) return
  w.__zeniumPasskeyObserver = true
  const credentials = w.navigator.credentials
  if (!credentials) return
  const toBase64Url = (id: unknown): string => {
    try {
      if (typeof id === 'string') return id
      const bytes = id instanceof ArrayBuffer ? new Uint8Array(id) : null
      if (!bytes) return ''
      let binary = ''
      for (const b of bytes) binary += String.fromCharCode(b)
      return w.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    } catch {
      return ''
    }
  }
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const report = (payload: Record<string, string>): void => {
    try {
      w.postMessage({ __zeniumPasskey: payload }, '*')
    } catch {
      /* a page that rejects structured clones keeps its passkeys unlisted */
    }
  }
  const wrap = <K extends 'create' | 'get'>(name: K): void => {
    const native = credentials[name] as (options?: unknown) => Promise<unknown>
    if (typeof native !== 'function') return
    const wrapped = function (this: CredentialsContainer, options?: unknown): Promise<unknown> {
      const promise = native.call(this ?? credentials, options)
      const pk = (options as { publicKey?: Record<string, unknown> } | undefined)?.publicKey
      if (pk && promise && typeof (promise as Promise<unknown>).then === 'function') {
        void (promise as Promise<unknown>).then(
          (credential) => {
            if (!credential) return
            const id = toBase64Url((credential as { rawId?: unknown }).rawId ?? (credential as { id?: unknown }).id)
            if (name === 'create') {
              const rp = (pk.rp as { id?: unknown; name?: unknown } | undefined) ?? {}
              const user = (pk.user as { name?: unknown; displayName?: unknown } | undefined) ?? {}
              report({
                op: 'create',
                rpId: text(rp.id) || w.location.hostname,
                rpName: text(rp.name),
                userName: text(user.name),
                userDisplayName: text(user.displayName),
                credentialId: id
              })
            } else {
              report({
                op: 'get',
                rpId: text(pk.rpId) || w.location.hostname,
                rpName: '',
                userName: '',
                userDisplayName: '',
                credentialId: id
              })
            }
          },
          () => {}
        )
      }
      return promise
    }
    try {
      Object.defineProperty(credentials, name, { value: wrapped, configurable: true, writable: true })
    } catch {
      /* a frozen container keeps the native method; passkeys still work, just unlisted */
    }
  }
  wrap('create')
  wrap('get')
}

/** The observer as page source, for hosts that must inject it into the main world themselves. */
export const PASSKEY_OBSERVER_SOURCE = `(${installPasskeyObserver.toString()})(window)`
