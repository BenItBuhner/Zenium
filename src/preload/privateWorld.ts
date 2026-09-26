import {
  IMAGE_THUMBNAIL_WORLD_ID,
  readPrivateWorldExecution,
  type PrivateWorldAnswer
} from '../shared/privateWorld'

/**
 * The frame's side of `shared/privateWorld.ts`: the desktop host asks this frame to run a
 * script in Zenium's private world (the image-search thumbnail in a sub-frame, where Electron
 * has no browser-side isolated-world call), the preload runs it through the frame's own
 * `webFrame.executeJavaScriptInIsolatedWorld` and answers under the token. The only world this
 * runs anything in is `IMAGE_THUMBNAIL_WORLD_ID`: a request naming another – the main world,
 * an extension's, the preload's own – is dropped unanswered, so the relay can never be a way
 * into a world that is not the browser's private one.
 */
export interface PrivateWorldBridge {
  /** Host → frame: an execution request, as sent (checked here). */
  onExecute(listener: (raw: unknown) => void): void
  /** `webFrame.executeJavaScriptInIsolatedWorld(worldId, [{ code }])`: the settled value. */
  executeInIsolatedWorld(worldId: number, code: string): Promise<unknown>
  /** Frame → host: the outcome. */
  answer(answer: PrivateWorldAnswer): void
}

export function installPrivateWorld(bridge: PrivateWorldBridge): void {
  bridge.onExecute((raw) => {
    const execution = readPrivateWorldExecution(raw)
    if (!execution || execution.worldId !== IMAGE_THUMBNAIL_WORLD_ID) return
    const { token } = execution
    Promise.resolve()
      .then(() => bridge.executeInIsolatedWorld(execution.worldId, execution.code))
      .then(
        (result) => bridge.answer({ token, result }),
        (error: unknown) => bridge.answer({ token, error: errorMessage(error) })
      )
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'The script failed'
}
