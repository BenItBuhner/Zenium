import { webFrameMain, type WebContents, type WebFrameMain } from 'electron'

/** Chrome's frame id: `0` for the outermost frame, the frame tree node id for every other frame. */
export function frameIdOf(frame: WebFrameMain): number {
  return frame.parent === null ? 0 : frame.frameTreeNodeId
}

/** Chrome's `parentFrameId`: `-1` for the outermost frame. */
export function parentFrameIdOf(frame: WebFrameMain): number {
  const parent = frame.parent
  return parent ? frameIdOf(parent) : -1
}

/** The live frame behind a Chrome frame id in a page, or null when it is gone. */
export function frameById(wc: WebContents, frameId: number): WebFrameMain | null {
  if (wc.isDestroyed()) return null
  const main = wc.mainFrame
  if (frameId === 0) return main
  for (const frame of main.framesInSubtree) {
    if (frame.parent !== null && frame.frameTreeNodeId === frameId) return frame
  }
  return null
}

/** The frame an engine event names by process and routing id, when it still exists. */
export function frameFromIds(processId: number, routingId: number): WebFrameMain | null {
  try {
    return webFrameMain.fromId(processId, routingId) ?? null
  } catch {
    return null
  }
}

/** Sub-frames of Chrome's `frame` context menu context: any frame below the top one. */
export function isSubFrame(frame: WebFrameMain | null | undefined): boolean {
  return Boolean(frame && frame.parent !== null)
}
