package app.zen.chromium

import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Settings

/**
 * Where a Settings row or a link's menu item sends the user out of Zenium: the system's screens
 * for this app and the device's dialer, messaging, contacts and mail apps. Each destination is a
 * [Plan] first – the action, the data and the extras, decided here where the JVM tests read
 * them – and an [Intent] only as it starts ([Plan.toIntent]). A list is a fallback chain: the
 * first screen the device has takes the user (`Host.startFirst`).
 */
object SystemIntents {
    data class Plan(
        val action: String,
        val data: String? = null,
        val type: String? = null,
        val extras: Map<String, String> = emptyMap()
    ) {
        fun toIntent(): Intent {
            val intent = Intent(action)
            if (data != null && type != null) intent.setDataAndType(Uri.parse(data), type)
            else if (data != null) intent.data = Uri.parse(data)
            else if (type != null) intent.type = type
            for ((key, value) in extras) intent.putExtra(key, value)
            return intent
        }
    }

    /**
     * Zenium's notification settings (SET-26): Android 8's per-app screen, where each channel –
     * downloads, sites, updates, the private-tabs card – is turned on or off; the app's details
     * page beneath it on a device without the screen.
     */
    fun notificationSettings(packageName: String): List<Plan> = listOf(
        Plan(Settings.ACTION_APP_NOTIFICATION_SETTINGS, extras = mapOf(Settings.EXTRA_APP_PACKAGE to packageName)),
        Plan(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, data = "package:$packageName")
    )

    /**
     * Call (PUI-22): the dialer with the number filled in, not yet ringing (`ACTION_DIAL` needs no
     * permission and leaves the call to a tap in the dialer, as Chrome's item does).
     */
    fun call(telUrl: String): Plan? = phoneNumber(telUrl)?.let { Plan(Intent.ACTION_DIAL, data = "tel:$it") }

    /** Send message (PUI-22): a new text to the number in the messaging app. */
    fun message(telUrl: String): Plan? = phoneNumber(telUrl)?.let { Plan(Intent.ACTION_SENDTO, data = "smsto:$it") }

    /** Add to contacts (PUI-22): the contacts app's new-contact form, the number filled in. */
    fun addContact(telUrl: String): Plan? = phoneNumber(telUrl)?.let {
        Plan(
            ContactsContract.Intents.Insert.ACTION,
            type = ContactsContract.Contacts.CONTENT_TYPE,
            extras = mapOf(ContactsContract.Intents.Insert.PHONE to it)
        )
    }

    /**
     * Send email (PUI-22): a new mail to the address; the `mailto:` URL travels whole, so a subject,
     * a body or a cc in its query reach the mail app.
     */
    fun email(mailtoUrl: String): Plan? =
        if (schemeOf(mailtoUrl) == "mailto" && mailtoUrl.length > "mailto:".length) Plan(Intent.ACTION_SENDTO, data = mailtoUrl)
        else null

    /**
     * The number in a `tel:` URL as the dialer takes it: percent-escapes undone, whitespace gone,
     * the RFC 3966 parameters after the first `;` (`;ext=`, `;phone-context=`) dropped, the visual
     * separators (`-`, `.`, `(`, `)`) kept for the dialer to read. Null when nothing is left.
     */
    fun phoneNumber(telUrl: String): String? {
        if (schemeOf(telUrl) != "tel") return null
        val raw = telUrl.substring("tel:".length).substringBefore(';')
        val number = percentDecode(raw).filterNot { it.isWhitespace() }
        return number.takeIf { it.any { c -> c.isDigit() } }
    }

    private fun schemeOf(url: String): String? {
        val colon = url.indexOf(':')
        if (colon <= 0) return null
        return url.substring(0, colon).lowercase()
    }

    /** `%2B` → `+`; a `+` stays a `+` (this is not a form encoding); a broken escape stays as typed. */
    private fun percentDecode(text: String): String {
        if (!text.contains('%')) return text
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '%' && i + 2 < text.length) {
                val hex = text.substring(i + 1, i + 3)
                val value = hex.toIntOrNull(16)
                if (value != null) {
                    bytes.write(value)
                    i += 3
                    continue
                }
            }
            bytes.write(c.toString().toByteArray(Charsets.UTF_8))
            i += 1
        }
        return bytes.toString(Charsets.UTF_8.name())
    }
}
