import { describe, expect, it } from 'vitest'
import { installExtensionPolyfills } from '../extensionPolyfills'

/** A realm's `Promise` as WebView 113 has it: no `withResolvers`. */
function promiseWithout(): PromiseConstructor {
  const Without = class extends Promise<unknown> {} as unknown as PromiseConstructor
  Object.defineProperty(Without, 'withResolvers', {
    value: undefined,
    writable: true,
    configurable: true
  })
  return Without
}

describe('the engine builtins an extension realm lacks', () => {
  it("gives a realm without Promise.withResolvers the engine's own shape of it (Adobe Photoshop's worker on WebView 113)", async () => {
    const Without = promiseWithout()
    expect(installExtensionPolyfills({ Promise: Without })).toEqual(['Promise.withResolvers'])
    const descriptor = Object.getOwnPropertyDescriptor(Without, 'withResolvers')
    expect(descriptor).toMatchObject({ writable: true, configurable: true, enumerable: false })
    const withResolvers = Without.withResolvers
    expect(withResolvers.name).toBe('withResolvers')
    expect(withResolvers.length).toBe(0)
    // Adobe's line: `const { promise, resolve, reject } = Promise.withResolvers()`.
    const { promise, resolve, reject } = Without.withResolvers<string>()
    expect(promise).toBeInstanceOf(Without)
    expect(typeof reject).toBe('function')
    resolve('init')
    await expect(promise).resolves.toBe('init')
    const rejected = Without.withResolvers<never>()
    rejected.reject(new Error('no'))
    await expect(rejected.promise).rejects.toThrow('no')
    // `this` is the constructor called on, as the engine's: a subclass gets its own promise.
    const Sub = class extends Without<unknown> {} as unknown as PromiseConstructor
    expect(Sub.withResolvers().promise).toBeInstanceOf(Sub)
  })

  it('leaves a realm that has it, and a realm without a Promise, alone', () => {
    const native = Promise.withResolvers
    expect(installExtensionPolyfills({ Promise })).toEqual([])
    expect(Promise.withResolvers).toBe(native)
    expect(installExtensionPolyfills({})).toEqual([])
    // Installed once: a second boot of the same realm finds the first's.
    const Without = promiseWithout()
    installExtensionPolyfills({ Promise: Without })
    const first = Without.withResolvers
    expect(installExtensionPolyfills({ Promise: Without })).toEqual([])
    expect(Without.withResolvers).toBe(first)
  })
})
