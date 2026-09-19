package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * The tab cards' pictures on disk: one JPEG per tab under `cacheDir/zen-thumbs/<tabId>.jpg`, the
 * page scaled to a card's width, so a restored tab shows its last look before its page has
 * painted (BH-33) and a card never has to wait for a capture of a page that is not on screen.
 *
 * Who takes the pictures is [TabWebView.captureThumbnail] and the cover capture
 * ([TabWebView.snapshot]) it derives from; this is the file layer and the arithmetic, kept free
 * of the view so it runs under plain JUnit. Writes go to a temp file renamed over the target, as
 * [Storage] does its documents, and every write, drop and sweep runs on the one [disk] thread in
 * the order it was asked, so a drop the chrome sends on a navigation lands after the save of the
 * page before it, never under it. The chrome reads a picture when it shows the card
 * (`thumbnail.load`, with the tab's URL), never through the boot payload – an image is not a
 * boot document – and says which are to go: a tab's on its navigation or when it is gone for
 * good (`thumbnail.drop`), everyone's but the session's once at boot (`thumbnail.sweep`).
 *
 * Each file carries the document it is a picture of ([stamp]: a digest of the URL in a JPEG
 * comment segment), and a read answers nothing when the tab's URL is not that document's
 * (BH-14 across a kill: a picture written a moment before the page left it is never shown as
 * the new page's). The disk is bounded by the session – one file per tab, the boot sweep keeps
 * the session's tabs only and at most [MAX_FILES] of them, newest first – and the cache dir is
 * Android's to clear under pressure; a picture that is gone is taken again.
 *
 * Nothing decoded is held here: the chrome keeps the pictures it shows, within its own budget.
 */
class Thumbnails(private val dir: File) {
    /** How wide a card is, in device pixels, as the chrome last said (`thumbnail.configure`); 0 before it has. */
    @Volatile
    var width: Int = 0

    /**
     * The card pictures' own thread: their scaling and encoding and every file write, drop and
     * sweep, in order. Never the cover's `zen-encode` thread – a sheet's cover is what the chrome
     * waits for before it hides the page, and a card's work is never in front of it – and a step
     * below normal priority (ART's background nice value), so under CPU pressure the cover's
     * encode and the main thread go first.
     */
    val disk: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-thumbs").apply { priority = Thread.NORM_PRIORITY - 1 } }

    /** When each tab's picture was last taken (uptime millis); main thread, see [fresh]. */
    private val takenAt = HashMap<String, Long>()

    /**
     * Whether the tab's last picture still stands at `now` ([FRESH_MS]): the cover a sheet just
     * took, the copy a hide a frame ago made – no second copy of the window is taken for it.
     */
    fun fresh(tabId: String, now: Long): Boolean = isFresh(takenAt[tabId] ?: 0L, now)

    /** A picture of the tab was taken at `now`. */
    fun taken(tabId: String, now: Long) {
        takenAt[tabId] = now
    }

    /**
     * The tab's picture no longer stands for its page: its document changed (a commit, in place
     * or not – the chrome drops the picture on the URL change, and the next hide is to take a
     * new one, however fresh the last), or the picture never made it. The next hide takes one.
     */
    fun stale(tabId: String) {
        takenAt.remove(tabId)
    }

    /** The picture of a tab, or null when there is none. */
    fun load(tabId: String): ByteArray? {
        val file = fileFor(tabId) ?: return null
        return runCatching { if (file.isFile) file.readBytes() else null }.getOrNull()
    }

    /**
     * Replace the picture of a tab whole, stamped with `document`, the URL of the page it shows;
     * true when the bytes are on disk under its name.
     */
    fun save(tabId: String, jpeg: ByteArray, document: String): Boolean {
        val target = fileFor(tabId) ?: return false
        return runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${target.name}$TMP_SUFFIX")
            tmp.writeBytes(stamp(jpeg, document))
            if (!tmp.renameTo(target)) {
                target.delete()
                if (!tmp.renameTo(target)) tmp.delete()
            }
            target.isFile
        }.getOrDefault(false)
    }

    /**
     * Forget the picture of a tab; true when nothing is left under its name. With `document`, the
     * URL the tab left, the picture of that page alone: one stamped with another (the next page's,
     * saved before the chrome's word arrived – the drop is the later on this thread) stays, and
     * the answer is false. One without a stamp goes: it is of no known page.
     */
    fun drop(tabId: String, document: String? = null): Boolean {
        val file = fileFor(tabId) ?: return false
        return runCatching {
            File(dir, "${file.name}$TMP_SUFFIX").delete()
            when {
                !file.exists() -> true
                document != null && documentOf(file.readBytes()).let { it != null && it != digest(document) } -> false
                else -> file.delete()
            }
        }.getOrDefault(false)
    }

    /**
     * Every picture but those of `keep` goes – the tabs of the restored session, at boot: a tab
     * that is not among them is not coming back under its id. A write that never finished (a
     * temp file) goes too, and of the kept, the oldest beyond `max` ([MAX_FILES]): the disk's
     * bound is the session's size up to that many pictures. Answers how many files went.
     */
    fun sweep(keep: Set<String>, max: Int = MAX_FILES): Int {
        val files = dir.listFiles() ?: return 0
        val names = keep.mapTo(HashSet(), ::fileName)
        var removed = 0
        val kept = ArrayList<File>()
        for (file in files) {
            if (!file.isFile) continue
            if (file.name.endsWith(SUFFIX) && file.name.removeSuffix(SUFFIX) in names) kept += file
            else if (file.delete()) removed++
        }
        if (kept.size > max) {
            kept.sortByDescending { it.lastModified() }
            for (i in max until kept.size) if (kept[i].delete()) removed++
        }
        return removed
    }

    /** The tabs that have a picture. */
    fun ids(): List<String> =
        dir.listFiles { f -> f.isFile && f.name.endsWith(SUFFIX) }?.map { it.name.removeSuffix(SUFFIX) }?.sorted() ?: emptyList()

    /** The file a tab's picture lives in (null for an id that is no file name). */
    fun fileFor(tabId: String): File? {
        val name = fileName(tabId)
        if (name.isEmpty() || name == "." || name == "..") return null
        return File(dir, "$name$SUFFIX")
    }

    /**
     * The picture of a tab as the chrome's `thumbnail.load` answers it, for a tab at `document`:
     * a JPEG data URL with the size of its pixels (read from the header alone), or null – when
     * there is none, or when the one there is shows another document than the tab's (it is of a
     * page the tab has left; the next picture replaces it, or the sweep takes it). Android: the
     * header decode.
     */
    fun loadPicture(tabId: String, document: String): Picture? {
        val bytes = load(tabId) ?: return null
        if (documentOf(bytes) != digest(document)) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            drop(tabId)
            return null
        }
        return Picture(bytes, bounds.outWidth, bounds.outHeight)
    }

    /** An encoded picture and the size of its pixels. */
    class Picture(val jpeg: ByteArray, val width: Int, val height: Int) {
        val dataUrl: String get() = "data:image/jpeg;base64," + java.util.Base64.getEncoder().encodeToString(jpeg)
    }

    companion object {
        const val DIR = "zen-thumbs"
        const val SUFFIX = ".jpg"
        private const val TMP_SUFFIX = ".tmp"
        /** The card pictures' JPEG quality: small files, no visible blocking at a card's size. */
        const val JPEG_QUALITY = 80
        /** Until the chrome has said how wide a card is, captures are scaled to at most this. */
        const val DEFAULT_WIDTH = 480
        /**
         * A picture younger than this stands for the page as it is: the cover a sheet just took,
         * the copy a hide a frame ago made. No second copy of the window is taken for it – the
         * page cannot have changed under a chrome that covers it.
         */
        const val FRESH_MS = 2000L
        /**
         * How many pictures the boot sweep leaves at most (the newest): at 5-15 KB each, a few
         * MB of the cache dir for the largest session anyone keeps.
         */
        const val MAX_FILES = 500

        private val UNSAFE = Regex("[^A-Za-z0-9._-]")

        /** The comment segment a picture's document goes in, ahead of its digest. */
        private const val STAMP_PREFIX = "zen-document:"
        private const val MARKER = 0xFF
        private const val COM = 0xFE
        private const val SOS = 0xDA
        private const val EOI = 0xD9

        fun fileName(tabId: String): String = tabId.replace(UNSAFE, "_")

        /** Whether a picture taken at `capturedAt` still stands at `now` (uptime millis both). */
        fun isFresh(capturedAt: Long, now: Long): Boolean = capturedAt > 0 && now - capturedAt < FRESH_MS

        /** What a picture is stamped with for `document`: the hex SHA-256 of the URL, not the URL. */
        fun digest(document: String): String {
            val bytes = MessageDigest.getInstance("SHA-256").digest(document.toByteArray(Charsets.UTF_8))
            return bytes.joinToString("") { "%02x".format(it) }
        }

        /**
         * `jpeg` with a comment segment naming `document` ([digest]) after its SOI and the APPn
         * segments that lead it (JFIF's APP0 stays first, as JFIF asks) – a segment every decoder
         * passes over. Bytes that are not a JPEG come back as they are, and read as no document.
         */
        fun stamp(jpeg: ByteArray, document: String): ByteArray {
            val at = stampOffset(jpeg) ?: return jpeg
            val payload = (STAMP_PREFIX + digest(document)).toByteArray(Charsets.US_ASCII)
            val length = payload.size + 2
            val segment = ByteArray(2 + length)
            segment[0] = MARKER.toByte()
            segment[1] = COM.toByte()
            segment[2] = (length shr 8).toByte()
            segment[3] = (length and 0xFF).toByte()
            payload.copyInto(segment, 4)
            return jpeg.copyOfRange(0, at) + segment + jpeg.copyOfRange(at, jpeg.size)
        }

        /** The digest a picture was stamped with ([stamp]), or null for one without. */
        fun documentOf(jpeg: ByteArray): String? {
            if (!startsWithSoi(jpeg)) return null
            var at = 2
            while (at + 4 <= jpeg.size && jpeg[at].toInt() and 0xFF == MARKER) {
                val marker = jpeg[at + 1].toInt() and 0xFF
                if (marker == MARKER) {
                    at++
                    continue
                }
                if (marker == SOS || marker == EOI || marker in 0xD0..0xD7 || marker == 0x01) return null
                val length = segmentLength(jpeg, at) ?: return null
                if (marker == COM) {
                    val text = String(jpeg, at + 4, length - 2, Charsets.US_ASCII)
                    if (text.startsWith(STAMP_PREFIX)) return text.substring(STAMP_PREFIX.length)
                }
                at += 2 + length
            }
            return null
        }

        private fun startsWithSoi(jpeg: ByteArray): Boolean =
            jpeg.size >= 4 && jpeg[0].toInt() and 0xFF == MARKER && jpeg[1].toInt() and 0xFF == 0xD8

        /** The length field of the segment whose marker is at `at`, when the segment is whole. */
        private fun segmentLength(jpeg: ByteArray, at: Int): Int? {
            val length = ((jpeg[at + 2].toInt() and 0xFF) shl 8) or (jpeg[at + 3].toInt() and 0xFF)
            return if (length >= 2 && at + 2 + length <= jpeg.size) length else null
        }

        /** Where the stamp goes: after SOI and the run of APPn segments that follows it. */
        private fun stampOffset(jpeg: ByteArray): Int? {
            if (!startsWithSoi(jpeg)) return null
            var at = 2
            while (at + 4 <= jpeg.size && jpeg[at].toInt() and 0xFF == MARKER && jpeg[at + 1].toInt() and 0xFF in 0xE0..0xEF) {
                val length = segmentLength(jpeg, at) ?: break
                at += 2 + length
            }
            return at
        }

        /**
         * The width a capture `sourceWidth` px wide is scaled to for a card `cardWidth` px wide (0:
         * not configured): the card's width, never more than the source has – a picture is not
         * made up.
         */
        fun targetWidth(sourceWidth: Int, cardWidth: Int): Int =
            minOf(sourceWidth, if (cardWidth > 0) cardWidth else DEFAULT_WIDTH).coerceAtLeast(1)

        /** The size of a `sourceWidth` x `sourceHeight` capture scaled to `targetWidth`, its aspect kept. */
        fun sizeFor(sourceWidth: Int, sourceHeight: Int, targetWidth: Int): Pair<Int, Int> {
            if (sourceWidth <= 0 || sourceHeight <= 0) return 1 to 1
            val w = targetWidth.coerceIn(1, sourceWidth)
            val h = (sourceHeight.toDouble() * w / sourceWidth).roundToInt().coerceAtLeast(1)
            return w to h
        }

        /**
         * A card picture from a copy of the page: scaled to `cardWidth` (see [targetWidth]) and
         * encoded. The bitmap is read, never recycled – the cover and the history preview share
         * it. Null when it cannot be encoded. Android; runs on the encoder thread.
         */
        fun encode(bitmap: Bitmap, cardWidth: Int): Picture? {
            val (w, h) = sizeFor(bitmap.width, bitmap.height, targetWidth(bitmap.width, cardWidth))
            val scaled = runCatching { if (w == bitmap.width && h == bitmap.height) bitmap else Bitmap.createScaledBitmap(bitmap, w, h, true) }
                .getOrNull() ?: return null
            val out = ByteArrayOutputStream()
            val ok = runCatching { scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out) }.getOrDefault(false)
            if (scaled !== bitmap) scaled.recycle()
            return if (ok) Picture(out.toByteArray(), w, h) else null
        }
    }
}

/**
 * One copy of the window per page at a time: the cover a sheet asks for ([TabWebView.snapshot]),
 * the card picture a hide takes ([TabWebView.captureThumbnail]) and the history preview a
 * navigation remembers all read the window through PixelCopy, and two of them in the same frame
 * would copy the same pixels twice. A request finding a copy in flight with at least the pixels
 * it needs joins it and gets its bitmap – the card picture is scaled down from the cover's copy –
 * and only a request that needs more than any copy in flight starts one of its own. Pure Kotlin
 * for the JUnit test; the view owns the bitmaps.
 */
class CaptureShare<B : Any> {
    /** A copy in flight; whoever started it hands its result to [complete]. */
    class Ticket internal constructor(val scale: Float)

    /** The copies in flight, oldest first, with everyone waiting on each. */
    private val flights = LinkedHashMap<Ticket, ArrayList<(B?) -> Unit>>()

    /** Copies in flight. */
    val inFlight: Int get() = flights.size

    /**
     * Hear the result of a copy at least `scale` big. Answers the ticket of the copy to start when
     * none in flight will do – the caller copies the window and calls [complete] with it – or null
     * when one in flight was joined.
     */
    fun request(scale: Float, callback: (B?) -> Unit): Ticket? {
        for ((ticket, waiters) in flights) {
            if (ticket.scale >= scale - EPSILON) {
                waiters.add(callback)
                return null
            }
        }
        val ticket = Ticket(scale)
        flights[ticket] = arrayListOf(callback)
        return ticket
    }

    /** The copy of `ticket` ended with `result` (null: it failed); everyone who joined it hears so. */
    fun complete(ticket: Ticket, result: B?) {
        val waiters = flights.remove(ticket) ?: return
        for (waiter in waiters) waiter(result)
    }

    private companion object {
        const val EPSILON = 1e-3f
    }
}
