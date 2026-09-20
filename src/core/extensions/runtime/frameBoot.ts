import { contentScriptAppliesTo, inheritsOrigin, type FrameContext } from '../api/matchPattern'
import type { BootGroup, ExtensionBoot } from './boot'

/**
 * What one unit's copy of the content bootstrap does in one frame. Chrome's rules decide which
 * declarations run (`contentScriptAppliesTo`: `all_frames`, the match patterns, and for a frame
 * on an inherited origin the `match_about_blank` / `match_origin_as_fallback` opt-in matched on
 * the precursor's URL). Two further decisions belong to the `with` fallback, where every unit
 * shares the page's one main world:
 *
 *  - `touch`: whether the copy leaves anything behind at all. In an isolated world the bootstrap
 *    is invisible to the page, so it may install its transport and slots in every frame; in the
 *    main world of a frame Chrome would not inject into, it must not: a script the page runs
 *    inside such a frame (Tampermonkey's natives harvest in its `javascript:void 0` sandbox
 *    frame) sees exactly the platform, as it does in Chrome. A late boot always touches: the
 *    host evaluated it so that `scripting.executeScript` has a scope.
 *  - `pristine`: whether the frame's prototypes stay the page's even though a content script runs
 *    there. The Trusted Types shield redefines the DOM sinks of the realm it runs in; in a frame
 *    on an inherited origin under the `with` fallback that realm is the one the page's own
 *    scripts may borrow natives from once the frame is gone, so the shield stays out and a
 *    content script there works under the page's own Trusted Types policy (the frame inherits
 *    it), the one deviation from Chrome's isolated-world behaviour in these frames.
 */
export interface FrameBootDecision {
  /** The groups that run in this frame, in declaration order. */
  groups: BootGroup[]
  touch: boolean
  pristine: boolean
}

export function decideFrameBoot(
  ext: ExtensionBoot,
  frame: FrameContext,
  late: boolean
): FrameBootDecision {
  const groups = late ? [] : ext.groups.filter((group) => contentScriptAppliesTo(group, frame))
  const inherited = ext.isolation === 'with' && inheritsOrigin(frame)
  return {
    groups,
    touch: late || groups.length > 0 || !inherited,
    pristine: inherited
  }
}
