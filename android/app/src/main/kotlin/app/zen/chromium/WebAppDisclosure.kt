package app.zen.chromium

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * PWA-13, the "Running in Zenium" disclosure: an installed app's own window ([WebAppActivity])
 * says whose it is on the app's first launch – Chrome's "Running in Chrome" for a web app that
 * opens in its own window without the browser's chrome – on the §9.33 toast card drawn natively
 * ([NativeToastCard]), with the one action OK, and never again for that install.
 *
 * The memory is the app's own record on disk, `files/zen/webapps/<shortcutId>.json`
 * ([WebAppStore]): one key, [KEY], the launch's time. No file type of its own. The install
 * writes the record without the key ([WebAppStore.save]), so an app pinned again is a new install
 * and discloses again, as Chrome's `WebappRegistry` re-arms its disclosure at install; a record the
 * install never wrote (an old shortcut carrying the record in its intent alone) is written whole
 * at the first launch, with the key. The rule is pure ([shown], [marked]) so it has a JVM test;
 * [claim] does the one read and the one write, off the main thread.
 */
object WebAppDisclosure {
    const val TAG = "ZenWebApp"
    /** The record's key: epoch ms of the first launch that showed the card. */
    const val KEY = "disclosedAt"
    /** The clock, as the row briefs it: §9.33's longest, the 8 s an Undo waits (the toast's own action clock is 5 s; the lead read decides). */
    const val SHOW_MS = ToastCardSpec.LONG_SHOW_MS

    /** Whether the record on disk (null: none yet) says the disclosure has been shown. */
    fun shown(record: JSONObject?): Boolean = record != null && record.optLong(KEY, 0L) > 0L

    /** The record with the mark, its own fields kept – the install's ([WebAppRecord.toJson]) when none is on disk. */
    fun marked(record: JSONObject?, fallback: WebAppRecord, at: Long): JSONObject = (record ?: fallback.toJson()).put(KEY, at)

    /** The sentence, with the product's name from the build's resources. */
    fun text(context: Context): String = context.getString(R.string.webapp_disclosure, context.getString(R.string.app_name))

    /**
     * Whether this launch is the app's first (no mark on disk) – and if so the mark is written now,
     * so the next launch is not. Any thread but the main one. A record that cannot be read counts
     * as none; a mark that cannot be written leaves the disclosure due again next time (it errs
     * towards telling).
     */
    fun claimFirstLaunch(context: Context, record: WebAppRecord, now: Long): Boolean =
        claim(WebAppStore.recordFile(context, record.shortcutId), record, now)

    fun claim(file: File, record: WebAppRecord, now: Long): Boolean {
        val json = runCatching { JSONObject(file.readText()) }.getOrNull()
        if (shown(json)) return false
        runCatching {
            file.parentFile?.mkdirs()
            file.writeText(marked(json, record, now).toString())
        }
        return true
    }
}
