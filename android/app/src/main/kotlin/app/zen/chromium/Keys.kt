package app.zen.chromium

import android.view.KeyCharacterMap
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject

/**
 * Physical keyboard support (DeX, tablets with keyboards). The core owns the shortcut table and
 * mirrors every binding here so page WebViews can decide synchronously whether a key press belongs
 * to the browser (consumed) or to the page.
 */
class Keys {
    private data class Binding(
        val ctrl: Boolean,
        val alt: Boolean,
        val shift: Boolean,
        val meta: Boolean,
        val key: String
    )

    private var bindings: List<Binding> = emptyList()

    fun setShortcuts(list: JSONArray) {
        val next = ArrayList<Binding>(list.length())
        for (i in 0 until list.length()) {
            val b = list.optJSONObject(i) ?: continue
            next.add(
                Binding(
                    b.bool("ctrl"), b.bool("alt"), b.bool("shift"), b.bool("meta"),
                    normalise(b.str("key"))
                )
            )
        }
        bindings = next
    }

    /** The DOM `KeyboardEvent.key` for an Android key event, normalised like the core does. */
    fun domKey(event: KeyEvent): String? {
        SPECIAL[event.keyCode]?.let { return it }
        // Letters compare case-insensitively (the core lowercases single characters); other
        // printable keys use the shifted character, so Shift+8 is "*" like in a browser.
        val letter = event.getUnicodeChar(0)
        if (letter in 'a'.code..'z'.code || letter in 'A'.code..'Z'.code) {
            return letter.toChar().lowercaseChar().toString()
        }
        val shifted = event.getUnicodeChar(event.metaState and KeyEvent.META_SHIFT_MASK)
        if (shifted > 0 && (shifted and KeyCharacterMap.COMBINING_ACCENT) == 0) {
            val ch = shifted and KeyCharacterMap.COMBINING_ACCENT_MASK
            if (ch >= 0x20) return ch.toChar().toString()
        }
        return null
    }

    /** True when the key press matches one of the synced shortcuts. */
    fun matches(event: KeyEvent): Boolean {
        val key = domKey(event) ?: return false
        val pressed = Binding(
            ctrl = event.isCtrlPressed,
            alt = event.isAltPressed,
            shift = event.isShiftPressed,
            meta = event.isMetaPressed,
            key = key
        )
        return bindings.any { it == pressed }
    }

    /** Serialise for `__zenHost.onKey`. */
    fun toInput(event: KeyEvent): JSONObject? {
        val key = domKey(event) ?: return null
        return json(
            "type" to "keyDown",
            "key" to key,
            "control" to event.isCtrlPressed,
            "alt" to event.isAltPressed,
            "shift" to event.isShiftPressed,
            "meta" to event.isMetaPressed,
            "isAutoRepeat" to (event.repeatCount > 0)
        )
    }

    private fun normalise(key: String): String = if (key.length == 1) key.lowercase() else key

    companion object {
        private val SPECIAL = mapOf(
            KeyEvent.KEYCODE_ESCAPE to "Escape",
            KeyEvent.KEYCODE_TAB to "Tab",
            KeyEvent.KEYCODE_ENTER to "Enter",
            KeyEvent.KEYCODE_NUMPAD_ENTER to "Enter",
            KeyEvent.KEYCODE_DEL to "Backspace",
            KeyEvent.KEYCODE_FORWARD_DEL to "Delete",
            KeyEvent.KEYCODE_SPACE to " ",
            KeyEvent.KEYCODE_DPAD_LEFT to "ArrowLeft",
            KeyEvent.KEYCODE_DPAD_RIGHT to "ArrowRight",
            KeyEvent.KEYCODE_DPAD_UP to "ArrowUp",
            KeyEvent.KEYCODE_DPAD_DOWN to "ArrowDown",
            KeyEvent.KEYCODE_PAGE_UP to "PageUp",
            KeyEvent.KEYCODE_PAGE_DOWN to "PageDown",
            KeyEvent.KEYCODE_MOVE_HOME to "Home",
            KeyEvent.KEYCODE_MOVE_END to "End",
            KeyEvent.KEYCODE_INSERT to "Insert",
            KeyEvent.KEYCODE_F1 to "F1", KeyEvent.KEYCODE_F2 to "F2", KeyEvent.KEYCODE_F3 to "F3",
            KeyEvent.KEYCODE_F4 to "F4", KeyEvent.KEYCODE_F5 to "F5", KeyEvent.KEYCODE_F6 to "F6",
            KeyEvent.KEYCODE_F7 to "F7", KeyEvent.KEYCODE_F8 to "F8", KeyEvent.KEYCODE_F9 to "F9",
            KeyEvent.KEYCODE_F10 to "F10", KeyEvent.KEYCODE_F11 to "F11", KeyEvent.KEYCODE_F12 to "F12"
        )
    }
}
