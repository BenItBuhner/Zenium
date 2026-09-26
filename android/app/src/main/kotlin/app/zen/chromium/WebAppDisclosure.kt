package app.zen.chromium

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * PWA-13, the "Running in Zenium" disclosure: an installed app's own window ([WebAppActivity])
 * says whose it is on the app's first launch – Chrome's "Running in Chrome" for a web app that
 * opens in its own window without the browser's chrome – on the §9.33 toast card drawn natively
 * ([NativeToastCard]) in the first-time hint's plain form: no action, the 2.8 s clock, a swipe
 * sends it off early. It is seen once the card has LEFT – the clock's end or the swipe – not
 * when it shows, so a launch killed under the card says it once more (the lead read on #561);
 * from then on never again for that install.
 *
 * The memory is the app's own record on disk, `files/zen/webapps/<shortcutId>.json`
 * ([WebAppStore]): one key, [KEY], the time the card left. No file type of its own. The install
 * writes the record without the key ([WebAppStore.save]), so an app pinned again is a new install
 * and discloses again, as Chrome's `WebappRegistry` re-arms its disclosure at install; a record the
 * install never wrote (an old shortcut carrying the record in its intent alone) is written whole
 * at the mark, with the key. The rule is pure ([shown], [marked]) so it has a JVM test; [due] is
 * the one read, [markSeen] the one write – whole or not at all – both off the main thread.
 */
object WebAppDisclosure {
    const val TAG = "ZenWebApp"
    /** The record's key: epoch ms of the moment the card left, the first launch seen through. */
    const val KEY = "disclosedAt"
    /** The clock: §9.33's 2.8 s, the first-time hint's – `TOAST_SHOW_MS`, the shared card's own. */
    const val SHOW_MS = ToastCardSpec.SHOW_MS

    /** Whether the record on disk (null: none yet) says the disclosure has been seen. */
    fun shown(record: JSONObject?): Boolean = record != null && record.optLong(KEY, 0L) > 0L

    /** The record with the mark, its own fields kept – the install's ([WebAppRecord.toJson]) when none is on disk. */
    fun marked(record: JSONObject?, fallback: WebAppRecord, at: Long): JSONObject = (record ?: fallback.toJson()).put(KEY, at)

    /** The sentence, with the product's name from the build's resources. */
    fun text(context: Context): String = context.getString(R.string.webapp_disclosure, context.getString(R.string.app_name))

    /**
     * Whether the disclosure is due this launch: no mark in the app's record on disk. A read
     * alone – nothing is written until the card has left ([markSeen]) – so a launch that dies
     * under the card finds it due again. A record that cannot be read counts as none. Any thread
     * but the main one.
     */
    fun dueFor(context: Context, record: WebAppRecord): Boolean = due(WebAppStore.recordFile(context, record.shortcutId))

    fun due(file: File): Boolean = !shown(read(file))

    /**
     * The card has left (the clock's end or the swipe): the mark written with [now], the record
     * whole from [record] when none is on disk. Idempotent – a mark already there is kept, its
     * time with it – and whole or not at all ([WebAppStore.replace]: a temp beside the record,
     * renamed over it), so a death mid-write leaves the record as it was, never torn. Any thread
     * but the main one. True when this call wrote the mark; a mark that cannot be written leaves
     * the disclosure due again next time (it errs towards telling).
     */
    fun markSeenFor(context: Context, record: WebAppRecord, now: Long): Boolean =
        markSeen(WebAppStore.recordFile(context, record.shortcutId), record, now)

    fun markSeen(file: File, record: WebAppRecord, now: Long): Boolean {
        val json = read(file)
        if (shown(json)) return false
        return runCatching { WebAppStore.replace(file, marked(json, record, now).toString()) }.isSuccess
    }

    private fun read(file: File): JSONObject? = runCatching { JSONObject(file.readText()) }.getOrNull()
}
