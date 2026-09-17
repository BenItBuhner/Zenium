import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ExternalProtocolRequest } from '@shared/types'
import { answerExternalProtocol, uiStore } from '@renderer/lib/ui'

/**
 * "Open <scheme> link?": a page asked for a link another application handles (`mailto:`,
 * `tel:`, a custom scheme). Cancel is the default answer; "Always allow" is a 16px checkbox,
 * offered only where the decision can be kept (a known site in a non-private window).
 *
 * The scrim lives inside the content frame (the sidebar stays undimmed). Surfaces follow the
 * v2 draft: opaque panel, radius 12, 32px radius-4 buttons at weight 500.
 */
export function ExternalProtocolDialog(): JSX.Element | null {
  const request = uiStore.use((s) => s.externalProtocol)
  if (!request) return null
  return <Dialog key={request.requestId} request={request} />
}

function Dialog({ request }: { request: ExternalProtocolRequest }): JSX.Element {
  const [remember, setRemember] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const decide = (allow: boolean): void =>
    answerExternalProtocol(
      request.requestId,
      allow,
      allow && remember && request.canRemember
    )

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      answerExternalProtocol(request.requestId, false, false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request.requestId])

  const site = request.site || 'This page'
  const titleId = `${request.requestId}-title`
  const bodyId = `${request.requestId}-body`
  return (
    <div
      className="zen-dialog-scrim zen-animate-fade absolute inset-0 z-50 flex items-center justify-center"
      onMouseDown={() => decide(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="zen-dialog zen-animate-pop w-[400px] max-w-[calc(100%-32px)] p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2
          id={titleId}
          className="text-[17px] font-semibold leading-tight tracking-[-0.012em] text-[var(--zen-fg)]"
        >
          Open {request.scheme} link?
        </h2>
        <p
          id={bodyId}
          className="mt-2 text-[15px] font-normal leading-snug text-[var(--zen-fg)] opacity-[0.69]"
        >
          {site} wants to open this link in another app.
        </p>
        {request.canRemember && (
          <label className="mt-3 flex min-h-8 cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="zen-protocol-check mt-0.5"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="min-w-0 flex-1 text-[15px] leading-5">
              Always allow {request.site} to open links of this type
            </span>
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="zen-protocol-btn zen-protocol-btn-secondary"
            onClick={() => decide(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="zen-protocol-btn zen-protocol-btn-primary"
            onClick={() => decide(true)}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  )
}
