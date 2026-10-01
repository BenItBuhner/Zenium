/**
 * The default group names – ONE module for the core (`menus.ts`, `browser.ts`) and the renderer,
 * so a group made with no name of its own, and every test of "the default name", read the same
 * words. The words live in the string table's `strings/nouns.ts` (spec §9 item 10) and are
 * re-exported here for the callers that read them from this address; that module imports
 * nothing, and `formFactor.ts` reads it too, never the other way round.
 */
export { TOUCH_GROUP_DEFAULT_NAME, NEW_FOLDER_NAME, isDefaultGroupName } from './strings/nouns'
