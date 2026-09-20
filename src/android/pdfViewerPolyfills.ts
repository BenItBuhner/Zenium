/**
 * What pdf.js 6's legacy build still asks of the engine and an older system WebView does not
 * have: `Promise.withResolvers` (Chromium 119), `AbortSignal.any` (Chromium 116),
 * `ArrayBuffer.prototype.transferToFixedLength` (Chromium 114; the worker's font and stream
 * decoding fail without it, and the pages come out blank) and a `ReadableStream` that can be
 * iterated with `for await` (Chromium 124; `getTextContent` reads its stream that way, so find
 * comes up empty without it, and the worker's native Flate decoding falls back to its own).
 * The API 34 emulator image ships Chromium 113 as its WebView, and a device's WebView is
 * whatever Play last delivered, so the viewer carries the four. The viewer script imports this
 * first (`pdfViewer.ts`); the build prepends the same code to pdf.js's worker, which runs on
 * its own global (`vite.android.config.ts`). No imports, no exports: the file is a script
 * either way.
 */

if (typeof ArrayBuffer.prototype.transferToFixedLength !== 'function') {
  // A copy where the engine would detach the source: pdf.js reads the result and drops the
  // source either way, and a resizable buffer (Chromium 111) copies into a fixed one.
  Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', {
    configurable: true,
    writable: true,
    value: function transferToFixedLength(this: ArrayBuffer, newByteLength?: number): ArrayBuffer {
      const length = newByteLength === undefined ? this.byteLength : newByteLength
      const copy = new ArrayBuffer(length)
      new Uint8Array(copy).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)))
      return copy
    }
  })
}

if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T>(this: PromiseConstructor): PromiseWithResolvers<T> {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new this<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  })
}

if (typeof AbortSignal.any !== 'function') {
  Object.defineProperty(AbortSignal, 'any', {
    configurable: true,
    writable: true,
    value: function any(signals: Iterable<AbortSignal>): AbortSignal {
      const controller = new AbortController()
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort(signal.reason)
          break
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), {
          once: true,
          signal: controller.signal
        })
      }
      return controller.signal
    }
  })
}

if (
  typeof ReadableStream === 'function' &&
  typeof ReadableStream.prototype[Symbol.asyncIterator] !== 'function'
) {
  // The streams standard's `values()`: one reader for the loop, released when the stream ends
  // or the loop leaves early (cancelling the stream then, unless `preventCancel`).
  const values = function values<T>(
    this: ReadableStream<T>,
    options?: { preventCancel?: boolean }
  ): AsyncIterableIterator<T> {
    const reader = this.getReader()
    const preventCancel = options?.preventCancel === true
    const iterator: AsyncIterableIterator<T> = {
      async next(): Promise<IteratorResult<T>> {
        let result: ReadableStreamReadResult<T>
        try {
          result = await reader.read()
        } catch (error) {
          reader.releaseLock()
          throw error
        }
        if (result.done) reader.releaseLock()
        return result.done ? { done: true, value: undefined } : { done: false, value: result.value }
      },
      async return(value?: unknown): Promise<IteratorResult<T>> {
        if (preventCancel) reader.releaseLock()
        else {
          const cancelled = reader.cancel(value)
          reader.releaseLock()
          await cancelled
        }
        return { done: true, value: undefined }
      },
      [Symbol.asyncIterator]() {
        return iterator
      }
    }
    return iterator
  }
  for (const name of ['values', Symbol.asyncIterator] as const)
    Object.defineProperty(ReadableStream.prototype, name, {
      configurable: true,
      writable: true,
      value: values
    })
}
