import type { LoadURLOptions } from 'electron'
import { bakeImagePost, type ImagePost } from '../../shared/imageUpload'

/**
 * The image-search upload's desktop half (CT-32, Chrome's `image_url_post_params`): the body
 * `shared/imageUpload.ts` describes goes into `webContents.loadURL`'s post data – the way
 * Chrome's `CoreTabHelper::PostContentToURL` navigates with `UploadRawData` and a content-type
 * header – and the bytes of an image the page's script may not read are found in the
 * renderer's resource tree (`ElectronTabView.readImageResource`).
 */

/**
 * `webContents.loadURL`'s options for the upload: the baked body as one raw-data element and
 * its content type as the request's header (a multipart's boundary rides in it).
 */
export function imagePostLoadOptions(post: ImagePost, boundary?: string): LoadURLOptions {
  const body = bakeImagePost(post, boundary)
  return {
    postData: [{ type: 'rawData', bytes: Buffer.from(body.bytes) }],
    extraHeaders: `Content-Type: ${body.contentType}`
  }
}

/** `Page.getResourceTree`'s answer, the part read here: each frame's id and the resources it lists. */
export interface ResourceFrameTree {
  frame: { id: string }
  resources?: Array<{ url: string; mimeType?: string; contentSize?: number }>
  childFrames?: ResourceFrameTree[]
}

/** Where a frame's resource list carries the image: the frame, the type and size the listing gives it. */
export interface ImageResourceListing {
  frameId: string
  /** `''` when the listing has none. */
  mimeType: string
  /** The encoded size the listing reports; null when it reports none. */
  contentSize: number | null
}

/**
 * The frames whose resource lists carry the image, outermost first: where
 * `Page.getResourceContent` is asked for it.
 */
export function imageResourceFrames(tree: ResourceFrameTree, url: string): ImageResourceListing[] {
  const out: ImageResourceListing[] = []
  const walk = (node: ResourceFrameTree): void => {
    const listed = node.resources?.find((r) => r.url === url)
    if (listed)
      out.push({
        frameId: node.frame.id,
        mimeType: listed.mimeType ?? '',
        contentSize:
          typeof listed.contentSize === 'number' && Number.isFinite(listed.contentSize)
            ? listed.contentSize
            : null
      })
    for (const child of node.childFrames ?? []) walk(child)
  }
  walk(tree)
  return out
}
