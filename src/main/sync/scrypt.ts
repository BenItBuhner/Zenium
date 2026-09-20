import { scrypt } from 'node:crypto'
import type { SyncScryptFn } from '../../core/platform'

/**
 * Node's scrypt for the desktop: the same parameters as the shared scrypt-js implementation and
 * the same key bit for bit (`__tests__/host.test.ts` and `core/sync/__tests__/crypto.test.ts`
 * pin it), an order of magnitude quicker than the JavaScript one.
 */
export const nodeScrypt: SyncScryptFn = (passphrase, salt, params) =>
  new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      params.dkLen,
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
      (error, key) => (error ? reject(error) : resolve(new Uint8Array(key)))
    )
  })
