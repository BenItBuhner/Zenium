package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.roundToInt

/**
 * The tab cards' pictures on disk: one JPEG per tab under `cacheDir/zen-thumbs/<tabId>.jpg`, the
 * page scaled to a card's width, so a restored tab shows its last look before its page has
 * painted (BH-33) and a card never has to wait for a capture of a page that is not on screen.
 *
 * Who takes the pictures is [TabWebView.captureThumbnail] and the cover capture
 * ([TabWebView.snapshot]) it derives from; this is the file layer and the arithmetic, kept free
 * of the view so it runs under plain JUnit. Writes go to a temp file renamed over the target, as
 * [Storage] does its documents. The chrome reads a picture when it shows the card
 * (`thumbnail.load`), never through the boot payload – an image is not a boot document – and
 * says which are to go: a tab's on its navigation or when it is gone for good
 * (`thumbnail.drop`), everyone's but the session's once at boot (`thumbnail.sweep`).
 *
 * Nothing decoded is held here: the chrome keeps the pictures it shows, within its own budget.
 */
class Thumbnails(private val dir: File) {
    /** How wide a card is, in device pixels, as the chrome last said (`thumbnail.configure`); 0 before it has. */
    @Volatile
    var width: Int = 0

    /** The picture of a tab, or null when there is none. */
    fun load(tabId: String): ByteArray? {
        val file = fileFor(tabId) ?: return null
        return runCatching { if (file.isFile) file.readBytes() else null }.getOrNull()
    }

    /** Replace the picture of a tab whole; true when the bytes are on disk under its name. */
    fun save(tabId: String, jpeg: ByteArray): Boolean {
        val target = fileFor(tabId) ?: return false
        return runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${target.name}$TMP_SUFFIX")
            tmp.writeBytes(jpeg)
            if (!tmp.renameTo(target)) {
                target.delete()
                if (!tmp.renameTo(target)) tmp.delete()
            }
            target.isFile
        }.getOrDefault(false)
    }

    /** Forget the picture of a tab; true when nothing is left under its name. */
    fun drop(tabId: String): Boolean {
        val file = fileFor(tabId) ?: return false
        return runCatching {
            File(dir, "${file.name}$TMP_SUFFIX").delete()
            !file.exists() || file.delete()
        }.getOrDefault(false)
    }

    /**
     * Every picture but those of `keep` goes – the tabs of the restored session, at boot: a tab
     * that is not among them is not coming back under its id. A write that never finished (a
     * temp file) goes too. Answers how many files went.
     */
    fun sweep(keep: Set<String>): Int {
        val files = dir.listFiles() ?: return 0
        val names = keep.mapTo(HashSet(), ::fileName)
        var removed = 0
        for (file in files) {
            if (!file.isFile) continue
            val kept = file.name.endsWith(SUFFIX) && file.name.removeSuffix(SUFFIX) in names
            if (!kept && file.delete()) removed++
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
     * The picture of a tab as the chrome's `thumbnail.load` answers it: a JPEG data URL with the
     * size of its pixels (read from the header alone), or null. Android: the header decode.
     */
    fun loadPicture(tabId: String): Picture? {
        val bytes = load(tabId) ?: return null
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

        private val UNSAFE = Regex("[^A-Za-z0-9._-]")

        fun fileName(tabId: String): String = tabId.replace(UNSAFE, "_")

        /** Whether a picture taken at `capturedAt` still stands at `now` (uptime millis both). */
        fun isFresh(capturedAt: Long, now: Long): Boolean = capturedAt > 0 && now - capturedAt < FRESH_MS

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
