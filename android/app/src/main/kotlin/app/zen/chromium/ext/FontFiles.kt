package app.zen.chromium.ext

import android.util.Log
import app.zen.chromium.json
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.charset.Charset
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * The font families a page can name on this device, for `chrome.fontSettings.getFontList`
 * (`ext.fonts.list`): what `WebSettings.setStandardFontFamily` and a page's `font-family` resolve.
 *
 * On Android, Blink asks Skia's `SkFontMgr_Android` for a family by name, and its name map is built
 * from the system font configuration's `<family name="…">` and `<alias name="…">` entries alone
 * (`fonts.xml`; the fallback families – the CJK, Arabic, Devanagari faces – have no name and render
 * through per-character fallback); `onLegacyMakeTypeface` answers null for any other name, so Blink
 * moves on to the next family. A font file's own name (`Noto Sans CJK JP`, from its `name` table)
 * is therefore not a name the engine takes, and the list is the configuration's named families,
 * each shown by the family name its first file carries in its `name` table (nameID 16, else 1) –
 * `casual` shown as "Coming Soon (casual)", `sans-serif` as "Roboto (sans-serif)". Aliases (`arial`
 * → `sans-serif`, the weight aliases) are the same faces under other names and are left out.
 *
 * The readers are pure over their bytes ([namedFamilies] over the XML text, [familyName] over a
 * font file's bytes through [Source]) so they run under JUnit; [list] reads the device.
 */
object FontFiles {
    private const val TAG = "ZenExt"

    /** The system's font configuration (Android 14 names its families in `fonts.xml`, its fallbacks in `font_fallback.xml`) and the OEM additions. */
    val CONFIGS: List<String> = listOf(
        "/system/etc/fonts.xml",
        "/system/etc/font_fallback.xml",
        "/product/etc/fonts_customization.xml",
        "/system_ext/etc/fonts_customization.xml",
        "/system/etc/fonts_customization.xml"
    )

    /** Where the files the configuration names are looked for (the contract's four). */
    val DIRECTORIES: List<String> = listOf("/system/fonts", "/system/font", "/product/fonts", "/data/fonts")

    /** A named family of the configuration: its name and the first font file it lists (as written, a file name). */
    data class NamedFamily(val name: String, val file: String?)

    /** One entry of the list: `id` is the name the engine resolves, `name` what the picker shows. */
    data class Entry(val id: String, val name: String) {
        fun toJson() = json("id" to id, "name" to name)
    }

    /** Bytes of a font file at an offset: a file, or an array under test. */
    interface Source {
        /** Up to `length` bytes from `offset`; fewer at the end, none past it. */
        fun read(offset: Long, length: Int): ByteArray
    }

    class BytesSource(private val bytes: ByteArray) : Source {
        override fun read(offset: Long, length: Int): ByteArray {
            if (offset < 0 || offset >= bytes.size || length <= 0) return ByteArray(0)
            val end = minOf(bytes.size.toLong(), offset + length).toInt()
            return bytes.copyOfRange(offset.toInt(), end)
        }
    }

    class FileSource(private val file: RandomAccessFile) : Source {
        override fun read(offset: Long, length: Int): ByteArray {
            if (offset < 0 || length <= 0 || offset >= file.length()) return ByteArray(0)
            val size = minOf(length.toLong(), file.length() - offset).toInt()
            val out = ByteArray(size)
            file.seek(offset)
            var got = 0
            while (got < size) {
                val n = file.read(out, got, size - got)
                if (n < 0) break
                got += n
            }
            return if (got == size) out else out.copyOf(got)
        }
    }

    /** The device's list: the named families of every configuration present, in configuration order, each name once. */
    fun list(configs: List<File> = CONFIGS.map(::File), dirs: List<File> = DIRECTORIES.map(::File)): List<Entry> {
        val families = LinkedHashMap<String, NamedFamily>()
        for (config in configs) {
            if (!config.isFile) continue
            val found = runCatching { config.inputStream().use { namedFamilies(it) } }
                .getOrElse { e -> Log.w(TAG, "fonts: ${config.path} unreadable: ${e.message}"); emptyList() }
            for (family in found) families.putIfAbsent(family.name.lowercase(), family)
        }
        return families.values.map { family -> Entry(family.name, displayName(family, dirs)) }
    }

    /** The picker's name for a family: the face's own name from its file, with the configuration's name after it when they differ. */
    fun displayName(family: NamedFamily, dirs: List<File>): String {
        val file = family.file?.let { name -> dirs.map { fileIn(it, name) }.firstOrNull { it.isFile } } ?: return family.name
        val face = runCatching { RandomAccessFile(file, "r").use { familyName(FileSource(it), collectionIndex(family.file)) } }
            .getOrElse { e -> Log.w(TAG, "fonts: ${file.path} unreadable: ${e.message}"); null }
        return when {
            face == null -> family.name
            face.equals(family.name, ignoreCase = true) -> face
            else -> "$face (${family.name})"
        }
    }

    /**
     * `<family name="…">` elements of a font configuration, in document order, each with the first
     * `<font>` file it lists (the configuration writes `<font>File.ttf</font>`, a `index` attribute
     * for a collection's face – kept as `file` for [displayName] to look up). Unnamed families (the
     * fallbacks) and `<alias>` elements are not entries.
     */
    fun namedFamilies(xml: InputStream): List<NamedFamily> {
        val factory = DocumentBuilderFactory.newInstance()
        runCatching { factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
        factory.isNamespaceAware = false
        factory.isValidating = false
        val document = factory.newDocumentBuilder().parse(xml)
        val out = ArrayList<NamedFamily>()
        val families = document.getElementsByTagName("family")
        for (i in 0 until families.length) {
            val family = families.item(i) as? Element ?: continue
            val name = family.getAttribute("name").trim()
            if (name.isEmpty()) continue
            val fonts = family.getElementsByTagName("font")
            var file: String? = null
            for (j in 0 until fonts.length) {
                val font = fonts.item(j) as? Element ?: continue
                val text = font.textContent.trim()
                if (text.isEmpty()) continue
                val index = font.getAttribute("index").trim()
                file = if (index.isEmpty()) text else "$text#$index"
                break
            }
            out.add(NamedFamily(name, file))
        }
        return out
    }

    /** The face index a `<font>` names for a collection (`NotoSerifCJK-Regular.ttc#2`), 0 otherwise. */
    fun collectionIndex(file: String?): Int = file?.substringAfter('#', "")?.toIntOrNull() ?: 0

    /** The file a `<font>` names, under a directory, without a collection index. */
    private fun fileIn(dir: File, name: String): File = File(dir, name.substringBefore('#'))

    // ---------------------------------------------------------------------------------------------
    // The `name` table
    // ---------------------------------------------------------------------------------------------

    /** The largest `name` table read (the system's are a few KB). */
    private const val NAME_TABLE_LIMIT = 1 shl 20

    /**
     * The family name of the face at `index` of a font file (0 for a single font; a `ttcf`
     * collection's face otherwise): the typographic family (nameID 16), else the family (nameID 1),
     * Windows/English first, then the Unicode platform's, any other Windows language, Macintosh
     * Roman. Null for a file that is not an sfnt or has no readable name.
     */
    fun familyName(source: Source, index: Int = 0): String? {
        val header = source.read(0, 12)
        if (header.size < 12) return null
        val tag = tag(header, 0)
        var offset = 0L
        when {
            tag == "ttcf" -> {
                val count = u32(header, 8)
                if (index < 0 || index >= count || count > 1024) return null
                val offsets = source.read(12, (count * 4).toInt())
                if (offsets.size < (index + 1) * 4) return null
                offset = u32(offsets, index * 4)
            }
            tag == "OTTO" || tag == "true" || u32(header, 0) == 0x00010000L -> if (index != 0) return null
            else -> return null
        }
        val directory = source.read(offset, 12)
        if (directory.size < 12) return null
        val tables = u16(directory, 4)
        if (tables == 0 || tables > 512) return null
        val records = source.read(offset + 12, tables * 16)
        for (i in 0 until tables) {
            val at = i * 16
            if (at + 16 > records.size) break
            if (tag(records, at) != "name") continue
            val tableOffset = u32(records, at + 8)
            val length = u32(records, at + 12)
            if (length <= 0 || length > NAME_TABLE_LIMIT) return null
            return familyNameOf(source.read(tableOffset, length.toInt()))
        }
        return null
    }

    /** The family name in a `name` table's bytes (see [familyName]). */
    fun familyNameOf(table: ByteArray): String? {
        if (table.size < 6) return null
        val count = u16(table, 2)
        val strings = u16(table, 4)
        var best: Pair<Int, String>? = null
        for (i in 0 until count) {
            val at = 6 + i * 12
            if (at + 12 > table.size) break
            val platform = u16(table, at)
            val encoding = u16(table, at + 2)
            val language = u16(table, at + 4)
            val nameId = u16(table, at + 6)
            val length = u16(table, at + 8)
            val offset = u16(table, at + 10)
            if (nameId != 16 && nameId != 1) continue
            val start = strings + offset
            if (length == 0 || start + length > table.size) continue
            val text = decode(platform, encoding, table, start, length)?.trim()?.ifEmpty { null } ?: continue
            val rank = (if (nameId == 16) 0 else 10) + when {
                platform == 3 && language == 0x0409 -> 0
                platform == 0 -> 1
                platform == 3 -> 2
                platform == 1 && language == 0 -> 3
                else -> 5
            }
            if (best == null || rank < best.first) best = rank to text
        }
        return best?.second
    }

    private fun decode(platform: Int, encoding: Int, bytes: ByteArray, start: Int, length: Int): String? = when {
        platform == 0 || (platform == 3 && (encoding == 0 || encoding == 1 || encoding == 10)) ->
            String(bytes, start, length, Charsets.UTF_16BE)
        platform == 1 && encoding == 0 -> String(bytes, start, length, MAC_ROMAN)
        else -> null
    }

    /** Mac Roman is Latin-1 over the names the system's fonts carry (ASCII); the JVM has no table of its own for it everywhere. */
    private val MAC_ROMAN: Charset = Charsets.ISO_8859_1

    private fun tag(bytes: ByteArray, at: Int): String = String(bytes, at, 4, Charsets.ISO_8859_1)
    private fun u16(bytes: ByteArray, at: Int): Int = ((bytes[at].toInt() and 0xff) shl 8) or (bytes[at + 1].toInt() and 0xff)
    private fun u32(bytes: ByteArray, at: Int): Long =
        ((bytes[at].toLong() and 0xff) shl 24) or ((bytes[at + 1].toLong() and 0xff) shl 16) or
            ((bytes[at + 2].toLong() and 0xff) shl 8) or (bytes[at + 3].toLong() and 0xff)
}
