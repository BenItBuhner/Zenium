import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The polyfills run once, at import, and only where the engine lacks the API: the natives are
 * taken away first, so what the tests exercise is what a Chromium 113 WebView would run.
 */

/** A stream with the async iteration the project's TypeScript lib leaves out. */
type IterableStream<T> = ReadableStream<T> & {
  values(options?: { preventCancel?: boolean }): AsyncIterableIterator<T>
  [Symbol.asyncIterator](): AsyncIterableIterator<T>
}

function iterable<T>(stream: ReadableStream<T>): IterableStream<T> {
  return stream as IterableStream<T>
}

type Natives = {
  transfer: PropertyDescriptor | undefined
  withResolvers: PropertyDescriptor | undefined
  any: PropertyDescriptor | undefined
  values: PropertyDescriptor | undefined
  asyncIterator: PropertyDescriptor | undefined
}

const natives: Natives = {
  transfer: Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transferToFixedLength'),
  withResolvers: Object.getOwnPropertyDescriptor(Promise, 'withResolvers'),
  any: Object.getOwnPropertyDescriptor(AbortSignal, 'any'),
  values: Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'values'),
  asyncIterator: Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator)
}

function restore(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else delete (target as Record<PropertyKey, unknown>)[key]
}

beforeAll(async () => {
  delete (ArrayBuffer.prototype as Partial<ArrayBuffer>).transferToFixedLength
  delete (Promise as Partial<PromiseConstructor>).withResolvers
  delete (AbortSignal as Partial<typeof AbortSignal>).any
  delete (ReadableStream.prototype as Partial<IterableStream<unknown>>).values
  delete (ReadableStream.prototype as Partial<IterableStream<unknown>>)[Symbol.asyncIterator]
  vi.resetModules()
  // @ts-expect-error -- a script without exports, imported for what it installs
  await import('../pdfViewerPolyfills')
})

afterAll(() => {
  restore(ArrayBuffer.prototype, 'transferToFixedLength', natives.transfer)
  restore(Promise, 'withResolvers', natives.withResolvers)
  restore(AbortSignal, 'any', natives.any)
  restore(ReadableStream.prototype, 'values', natives.values)
  restore(ReadableStream.prototype, Symbol.asyncIterator, natives.asyncIterator)
})

describe('the viewer’s polyfills for an older WebView', () => {
  it('lets a ReadableStream be read with for await, as getTextContent reads its stream', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('High water')
        controller.enqueue('Low water')
        controller.close()
      }
    })
    const chunks: string[] = []
    for await (const chunk of iterable(stream)) chunks.push(chunk)
    expect(chunks).toEqual(['High water', 'Low water'])
    // The loop's reader let go of the stream when it ended.
    expect(stream.locked).toBe(false)
  })

  it('cancels the stream when the loop leaves early, unless asked not to', async () => {
    let cancelled: unknown = 'not cancelled'
    const make = (): ReadableStream<number> =>
      new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1)
          controller.enqueue(2)
        },
        cancel(reason) {
          cancelled = reason ?? 'cancelled'
        }
      })
    const stream = make()
    for await (const chunk of iterable(stream)) {
      expect(chunk).toBe(1)
      break
    }
    expect(cancelled).toBe('cancelled')
    expect(stream.locked).toBe(false)

    cancelled = 'not cancelled'
    const kept = make()
    for await (const chunk of iterable(kept).values({ preventCancel: true })) {
      expect(chunk).toBe(1)
      break
    }
    expect(cancelled).toBe('not cancelled')
    expect(kept.locked).toBe(false)
  })

  it('copies a buffer for transferToFixedLength, to the length asked', () => {
    const source = new Uint8Array([1, 2, 3, 4]).buffer
    const same = source.transferToFixedLength()
    expect(Array.from(new Uint8Array(same))).toEqual([1, 2, 3, 4])
    expect(Array.from(new Uint8Array(source.transferToFixedLength(2)))).toEqual([1, 2])
    expect(Array.from(new Uint8Array(source.transferToFixedLength(6)))).toEqual([1, 2, 3, 4, 0, 0])
    expect(same.resizable).toBe(false)
  })

  it('gives Promise.withResolvers a promise with its two settlers', async () => {
    const { promise, resolve } = Promise.withResolvers<string>()
    resolve('done')
    await expect(promise).resolves.toBe('done')
    const failing = Promise.withResolvers<never>()
    failing.reject(new Error('no'))
    await expect(failing.promise).rejects.toThrow('no')
  })

  it('aborts AbortSignal.any when any of its signals does, with that signal’s reason', () => {
    const a = new AbortController()
    const b = new AbortController()
    const both = AbortSignal.any([a.signal, b.signal])
    expect(both.aborted).toBe(false)
    b.abort('b went')
    expect(both.aborted).toBe(true)
    expect(both.reason).toBe('b went')
    // One that is aborted already aborts the combined signal at once.
    expect(AbortSignal.any([a.signal, AbortSignal.abort('gone')]).reason).toBe('gone')
  })
})
