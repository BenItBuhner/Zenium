package app.zen.chromium

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle

/**
 * Secrets on the clipboard. A copied password or card number is marked sensitive, so the
 * clipboard preview (Android 13's "copied" chip, a keyboard's clipboard history) hides the value,
 * and when the core's timer fires it is taken off the clipboard again – unless the user has
 * copied something else meanwhile, which is theirs to keep.
 */
object SecretClipboard {
    fun write(context: Context, text: String, sensitive: Boolean) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(LABEL, text)
        if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        manager.setPrimaryClip(clip)
    }

    /** Empty the clipboard if it still holds `expected`; answers whether it did. */
    fun clear(context: Context, expected: String): Boolean {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        // Reading is refused to a backgrounded app (Android 10+): then nothing is known, nothing cleared.
        val current = runCatching {
            manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
        }.getOrNull()
        if (!holdsSecret(current, expected)) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            manager.clearPrimaryClip()
        } else {
            manager.setPrimaryClip(ClipData.newPlainText(LABEL, ""))
        }
        return true
    }

    /**
     * Whether the clipboard's text is still the secret the core copied. Pure, for the unit tests:
     * an empty or unreadable clipboard, or one the user has since filled with something else, is
     * left alone.
     */
    fun holdsSecret(current: String?, expected: String): Boolean =
        !current.isNullOrEmpty() && expected.isNotEmpty() && current == expected

    private const val LABEL = "Zenium"
}
