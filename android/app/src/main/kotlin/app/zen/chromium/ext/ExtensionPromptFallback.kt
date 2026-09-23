package app.zen.chromium.ext

import android.graphics.BitmapFactory
import android.graphics.drawable.Drawable
import android.util.Base64
import androidx.annotation.DrawableRes
import androidx.core.graphics.drawable.RoundedBitmapDrawableFactory
import app.zen.chromium.Host
import app.zen.chromium.NativePromptSheet
import app.zen.chromium.R
import app.zen.chromium.V2Ink
import org.json.JSONObject

/**
 * The install, update and `permissions.request` prompt when no live window can show the chrome's
 * own sheet (`extensionHost.ts`'s `nativeConfirm` – a package another app handed over before the
 * chrome had booted, a worker's `permissions.request` with no window up): the v2 §9.23
 * composition on the native chassis ([NativePromptSheet]) instead of a Material alert. The
 * TypeScript host composes the words once for both paths (`extensionPromptPlan.ts`, the same
 * copy the renderer's `ExtensionPromptDialog` draws) and hands the plan over as JSON
 * (`extStore.prompt`); this class only turns it into the sheet's content: the extension's icon at
 * the 20 glyph as the requester's identity (#330's §9.23 rule; the puzzle glyph in the
 * deemphasised ink for an extension without one), the title 17/600 with the source or the reason
 * as the description at 69 %, the "It can:" caption over one §9.21 row per permission warning
 * with its kind's glyph (`warningGlyph.ts`'s kinds, one drawable each), and the §9.11 footer of
 * Cancel and the verb – Add extension, Update extension, Allow – as the accent primary, or in the
 * danger ink when the plan marks the verb destructive (§6). The scrim, the system back and the
 * grabber are Cancel; one answer per prompt.
 */
class ExtensionPromptFallback(private val host: Host) {
    /** The plan as the TypeScript host composed it, parsed once; nothing here decides a word. */
    class Plan(
        val title: String,
        val description: String?,
        /** A data URL of the extension's icon, or null for the puzzle glyph. */
        val icon: String?,
        val caption: String?,
        val rows: List<Row>,
        /** The leading peer's label; null when the primary spans the footer alone. */
        val secondary: String?,
        val primary: String,
        /** The primary is a destructive verb: drawn in the danger ink on the plain fill (§6). */
        val destructive: Boolean
    ) {
        class Row(val glyph: String?, val label: String, val deemphasized: Boolean)

        companion object {
            fun parse(json: JSONObject): Plan {
                val rows = json.optJSONArray("rows")
                val primary = json.getJSONObject("primary")
                return Plan(
                    title = json.getString("title"),
                    description = json.optString("description").takeIf { !json.isNull("description") && it.isNotEmpty() },
                    icon = json.optString("icon").takeIf { !json.isNull("icon") && it.isNotEmpty() },
                    caption = json.optString("caption").takeIf { !json.isNull("caption") && it.isNotEmpty() },
                    rows = (0 until (rows?.length() ?: 0)).map { i ->
                        val row = rows!!.getJSONObject(i)
                        Row(
                            glyph = row.optString("glyph").takeIf { !row.isNull("glyph") && it.isNotEmpty() },
                            label = row.getString("label"),
                            deemphasized = row.optBoolean("deemphasized", false)
                        )
                    },
                    secondary = json.optString("secondary").takeIf { !json.isNull("secondary") && it.isNotEmpty() },
                    primary = primary.getString("label"),
                    destructive = primary.optString("tone") == "danger"
                )
            }

            /**
             * The drawable of each warning glyph kind `warningGlyph.ts` names (its `WarningGlyph`
             * union, Lucide names), a static table so the resource shrinker keeps every one; the
             * pin test holds the two lists equal. A kind not here draws no glyph.
             */
            val GLYPHS: Map<String, Int> = mapOf(
                "globe" to R.drawable.ic_warn_globe,
                "history" to R.drawable.ic_warn_history,
                "download" to R.drawable.ic_warn_download,
                "bell" to R.drawable.ic_warn_bell,
                "clipboard" to R.drawable.ic_warn_clipboard,
                "puzzle" to R.drawable.ic_warn_puzzle,
                "hard-drive" to R.drawable.ic_warn_hard_drive,
                "terminal" to R.drawable.ic_warn_terminal,
                "shield" to R.drawable.ic_warn_shield,
                "bookmark" to R.drawable.ic_warn_bookmark,
                "app-window" to R.drawable.ic_warn_app_window,
                "lock" to R.drawable.ic_warn_lock,
                "cookie" to R.drawable.ic_warn_cookie,
                "monitor" to R.drawable.ic_warn_monitor,
                "usb" to R.drawable.ic_warn_usb,
                "bluetooth" to R.drawable.ic_warn_bluetooth,
                "mic" to R.drawable.ic_warn_mic,
                "camera" to R.drawable.ic_warn_camera,
                "map-pin" to R.drawable.ic_warn_map_pin,
                "printer" to R.drawable.ic_warn_printer,
                "keyboard" to R.drawable.ic_warn_keyboard,
                "search" to R.drawable.ic_warn_search,
                "image" to R.drawable.ic_warn_image,
                "network" to R.drawable.ic_warn_network,
                "user" to R.drawable.ic_warn_user,
                "text-cursor-input" to R.drawable.ic_warn_text_cursor_input,
                "eye" to R.drawable.ic_warn_eye,
                "key-round" to R.drawable.ic_warn_key_round
            )

            /** `ExtensionIcon`'s corners: 4 for an icon under 24, 6 from 24 up. */
            fun iconRadiusDp(sizeDp: Int): Int = if (sizeDp >= 24) 6 else 4
        }
    }

    private var sheet: NativePromptSheet? = null

    /** Put the prompt up; `reply` gets true for the verb, false for Cancel, the scrim, the back or the grabber. */
    fun show(args: JSONObject, reply: (Any?) -> Unit) {
        val plan = Plan.parse(args)
        val activity = host.activity
        val ink = V2Ink(activity, host.themeDark)
        val content = NativePromptSheet.Content(
            title = plan.title,
            description = plan.description,
            glyph = icon(plan.icon, ink),
            caption = plan.caption,
            rows = plan.rows.map { row ->
                NativePromptSheet.Row(row.label, row.glyph?.let { Plan.GLYPHS[it] }?.let { warningGlyph(it, ink) }, row.deemphasized)
            },
            secondary = plan.secondary,
            primary = NativePromptSheet.Peer(plan.primary, if (plan.destructive) NativePromptSheet.Tone.DANGER else NativePromptSheet.Tone.ACCENT)
        )
        var answered = false
        val sheet = NativePromptSheet(activity, ink, content) { answer ->
            if (answered) return@NativePromptSheet
            answered = true
            this.sheet = null
            reply(answer.accepted)
        }
        this.sheet = sheet
        sheet.show()
    }

    /** Whether a prompt is up. */
    val showing: Boolean get() = sheet?.showing == true

    /** The extension's icon from its data URL at the glyph's corners; the puzzle glyph in the deemphasised ink without one. */
    private fun icon(dataUrl: String?, ink: V2Ink): Drawable {
        val bitmap = dataUrl?.let { url ->
            val comma = url.indexOf(',')
            if (!url.startsWith("data:") || comma < 0) return@let null
            runCatching {
                val bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }.getOrNull()
        }
        if (bitmap == null) return ink.glyph(R.drawable.ic_warn_puzzle, ink.textDeemphasized)
        val density = host.activity.resources.displayMetrics.density
        return RoundedBitmapDrawableFactory.create(host.activity.resources, bitmap).apply {
            cornerRadius = Plan.iconRadiusDp(app.zen.chromium.PromptSheetSpec.GLYPH_DP) * density
            isFilterBitmap = true
        }
    }

    /** A row's glyph: the kind's drawable in the deemphasised ink (`.zen-v2-row-lead`). */
    private fun warningGlyph(@DrawableRes id: Int, ink: V2Ink): Drawable = ink.glyph(id, ink.textDeemphasized)
}
