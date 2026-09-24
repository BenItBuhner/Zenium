import type { JSX } from 'react'
import type { UpdateTarget } from '@shared/updates'
import { copyrightLine, versionLine } from '@renderer/lib/about'

/**
 * About's head (settings-73): the wordmark at §4's display size, the version with its channel,
 * the engine the chrome runs on, and the copyright and licence line – Chrome's About block, as
 * one custom row so the four lines stand together at the row's gutter.
 */
export function AboutVersionBlock({
  version,
  target,
  engineHost
}: {
  version: string
  target: Pick<UpdateTarget, 'kind'>
  engineHost: string
}): JSX.Element {
  return (
    <div className="zen-settings-about" data-testid="about-version">
      <span className="zen-settings-about-wordmark">Zenium</span>
      <span className="zen-settings-label">{versionLine(version, target)}</span>
      <span className="zen-settings-description zen-settings-description-full">
        Running on Chromium via {engineHost}
      </span>
      <span className="zen-settings-description zen-settings-description-full">
        {copyrightLine()}
      </span>
    </div>
  )
}
