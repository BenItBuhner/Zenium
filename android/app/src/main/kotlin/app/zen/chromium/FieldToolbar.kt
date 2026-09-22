package app.zen.chromium

import org.json.JSONObject
import org.json.JSONTokener

/**
 * Paste and go in the omnibox field's floating toolbar (OMN-23), the parts that need no view.
 *
 * The chrome's WebView starts the system's floating action mode over its text fields with
 * Chromium's own callback – Paste and Select all on a tap of the insertion handle, Cut / Copy /
 * Paste / Share / Select all over a selection – and `ChromeWebView` wraps that callback with
 * `FieldActionMode`, which does its menu work through these. When the field in focus is the
 * omnibox's (`data-zen-menu="urlbar"`, the mark the desktop's context menu reads too; asked of
 * the chrome, since the mode knows only that some field is being edited) and the clipboard holds
 * text, one item of Zenium's joins the menu in a group of its own, which Chromium's rebuilds
 * leave alone, with the `order` of the system's Paste so the framework's toolbar lays it out
 * right after Paste: "Paste and go" for a link (the system's own classification of the clip,
 * `ClipboardPeek.pasteAction`, never a read), "Paste and search" for text the system read and
 * found no link in, in the system's sentence case beside its own Paste and Select all. A touch
 * sends `urlbar.paste` to the core (`platform.ts`), which closes the bar and runs the command the
 * chrome context menu's item runs (`urlbar.pasteAndGo` / `urlbar.pasteAndSearch`, #119); the
 * clipboard is read then, once, and the system's toast is its honest word about that read. No
 * Paste in the menu (a clipboard with nothing for the field, a selection outside a field), and
 * nothing is added.
 */
object FieldToolbar {
    /** Zenium's one item: the `urlbar.paste` action a touch sends ([GO] / [SEARCH]) and the title shown (and read out). */
    data class Item(val action: String, val title: String)

    /** One of the system's items in the action mode's menu, as the plan sees it: its group, its order and its title. */
    data class SystemItem(val groupId: Int, val order: Int, val title: String)

    /** The titles: the framework's public Paste (`android.R.string.paste`), the app's two items. */
    data class Strings(val paste: String, val pasteAndGo: String, val pasteAndSearch: String)

    /**
     * The field in focus as the chrome answers it: the omnibox's, editing for the tab named
     * (null for a field whose submit opens a new tab: the desktop's new-tab bar).
     */
    data class Field(val tabId: String?)

    /**
     * What to do to the menu: whether the system's Paste is there to anchor on (`anchored`: a
     * field the clipboard has something for), the `item` to add with `order` (Paste's), or none.
     */
    data class Plan(val anchored: Boolean, val order: Int, val item: Item?)

    /** The group our item goes into; Chromium removes only its own groups when it rebuilds the menu. */
    val GROUP: Int get() = R.id.zen_field_group

    /** Our item's menu id: a small int no resource id shares. */
    const val ITEM_ID = 1

    /** The `urlbar.paste` actions: go where typed text would (an address loads, anything else is searched); search whatever it is. */
    const val GO = "go"
    const val SEARCH = "search"

    /**
     * The element in focus, as the chrome answers `evaluateJavascript`: an object with the
     * omnibox field's tab (`data-zen-menu-tab`, null for none) when the field is the omnibox's,
     * null for anything else (another field of the chrome's, nothing).
     */
    const val FIELD_SCRIPT: String =
        "(function(){var e=document.activeElement;if(!e||e.getAttribute('data-zen-menu')!=='urlbar')return null;" +
            "return {tabId:e.getAttribute('data-zen-menu-tab')}})()"

    /** The field out of the script's answer: the omnibox's, or null for another element (or no answer). */
    fun parseField(raw: String?): Field? {
        val answer = runCatching { JSONTokener(raw ?: "").nextValue() as? JSONObject }.getOrNull() ?: return null
        return Field(answer.strOrNull("tabId")?.takeIf { it.isNotEmpty() })
    }

    /**
     * Where our item goes on the menu: after the system's Paste, with Paste's order – the only
     * anchor, since the mode over a field always has one when the clipboard has anything to
     * paste – and which item: go or search as the clipboard's `pasteAction` says
     * (`ClipboardPeek.pasteAction`: [GO], [SEARCH] or null for nothing to paste), when the
     * `field` in focus is the omnibox's. No Paste, no plan; another field, or nothing on the
     * clipboard, an anchored plan with no item.
     */
    fun plan(system: List<SystemItem>, field: Field?, pasteAction: String?, strings: Strings): Plan {
        val paste = system.firstOrNull { it.title == strings.paste } ?: return Plan(false, 0, null)
        val item = when {
            field == null -> null
            pasteAction == GO -> Item(GO, strings.pasteAndGo)
            pasteAction == SEARCH -> Item(SEARCH, strings.pasteAndSearch)
            else -> null
        }
        return Plan(true, paste.order, item)
    }

    /** The `urlbar.paste` host event for a touch on the item: which of the two, and the field's tab. */
    fun action(action: String, tabId: String?): JSONObject = json("action" to action, "tabId" to tabId)

    /**
     * The chrome's word on the field in focus for one action mode, kept current across its life.
     * The WebView keeps one mode across selection changes – a handle drag's end and Select all
     * both `invalidate()` the mode it has, so `onPrepareActionMode` runs again over the same menu
     * – and the answer is asynchronous (`evaluateJavascript`), so the first prepare shows the
     * system's items alone and ours joins when the answer comes: every anchored prepare asks the
     * chrome (`readField`), one ask at a time (a prepare during one is remembered and asked
     * after it), and an answer that differs from [field] is kept and the mode invalidated, whose
     * prepare asks once more and gets the same answer – the guard on equality ends the cycle.
     * Answers after `finish()` are dropped.
     */
    class Listing(
        private val readField: (onField: (Field?) -> Unit) -> Unit,
        private val invalidate: () -> Unit
    ) {
        /** The field as last answered: the omnibox's, or null (another field, or not yet answered). */
        var field: Field? = null
            private set

        /** Asks made so far (the tests count the round trips). */
        var asks: Int = 0
            private set

        private var asking = false
        private var again = false
        private var finished = false

        /** A prepare of a menu with Paste in it: ask, or after the ask in flight. */
        fun onPrepare() {
            if (finished) return
            if (asking) {
                again = true
                return
            }
            asking = true
            again = false
            asks++
            readField { answer ->
                if (finished) return@readField
                settle(answer)
            }
        }

        /** The mode is gone: whatever comes back now is for no one. */
        fun finish() {
            finished = true
        }

        private fun settle(fresh: Field?) {
            asking = false
            if (fresh != field) {
                field = fresh
                invalidate()
            } else if (again) {
                onPrepare()
            }
        }
    }
}
