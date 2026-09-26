package app.zen.chromium.ext

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `getFontList`'s reader on the phone (compat round 20): the font configuration's named families
 * and the family names in the font files' `name` tables, over synthetic bytes.
 */
class FontFilesTest {
    // --- builders: a `name` table, an sfnt around it, a `ttcf` collection of sfnts ---------------

    private class Name(val platform: Int, val encoding: Int, val language: Int, val nameId: Int, val text: String)

    private fun ByteArrayOutputStream.u16(v: Int) { write(v ushr 8 and 0xff); write(v and 0xff) }
    private fun ByteArrayOutputStream.u32(v: Long) { u16((v ushr 16).toInt() and 0xffff); u16(v.toInt() and 0xffff) }
    private fun ByteArrayOutputStream.tag(t: String) { write(t.toByteArray(Charsets.ISO_8859_1)) }

    private fun nameTable(names: List<Name>): ByteArray {
        val strings = ByteArrayOutputStream()
        val records = ByteArrayOutputStream()
        for (name in names) {
            val bytes = if (name.platform == 1) name.text.toByteArray(Charsets.ISO_8859_1) else name.text.toByteArray(Charsets.UTF_16BE)
            records.u16(name.platform); records.u16(name.encoding); records.u16(name.language); records.u16(name.nameId)
            records.u16(bytes.size); records.u16(strings.size())
            strings.write(bytes)
        }
        val out = ByteArrayOutputStream()
        out.u16(0); out.u16(names.size); out.u16(6 + names.size * 12)
        out.write(records.toByteArray()); out.write(strings.toByteArray())
        return out.toByteArray()
    }

    /** One font: the offset table, a `head` record ahead of the `name` one, the tables' bytes; the record offsets absolute from `base`. */
    private fun sfnt(name: ByteArray, version: String = "\u0000\u0001\u0000\u0000", base: Long = 0): ByteArray {
        val out = ByteArrayOutputStream()
        out.tag(version); out.u16(2); out.u16(0); out.u16(0); out.u16(0)
        val head = ByteArray(54)
        val headAt = base + 12 + 2 * 16
        val nameAt = headAt + head.size
        out.tag("head"); out.u32(0); out.u32(headAt); out.u32(head.size.toLong())
        out.tag("name"); out.u32(0); out.u32(nameAt); out.u32(name.size.toLong())
        out.write(head); out.write(name)
        return out.toByteArray()
    }

    private fun ttcf(names: List<ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        out.tag("ttcf"); out.u32(0x00010000); out.u32(names.size.toLong())
        var at = 12L + names.size * 4
        val fonts = names.map { name -> sfnt(name, base = at).also { at += it.size } }
        var offset = 12L + names.size * 4
        for (font in fonts) { out.u32(offset); offset += font.size }
        for (font in fonts) out.write(font)
        return out.toByteArray()
    }

    private fun windows(nameId: Int, text: String, language: Int = 0x0409) = Name(3, 1, language, nameId, text)
    private fun mac(nameId: Int, text: String) = Name(1, 0, 0, nameId, text)
    private fun unicode(nameId: Int, text: String) = Name(0, 3, 0, nameId, text)

    // --- the `name` table ------------------------------------------------------------------------

    @Test
    fun `the typographic family wins over the family, Windows English over the other platforms`() {
        assertEquals("Noto Serif", FontFiles.familyNameOf(nameTable(listOf(mac(1, "Noto Serif Display"), windows(1, "Noto Serif Display"), windows(16, "Noto Serif")))))
        assertEquals("Roboto", FontFiles.familyNameOf(nameTable(listOf(mac(1, "Roboto Mac"), windows(1, "Roboto")))))
        assertEquals("Roboto Mac", FontFiles.familyNameOf(nameTable(listOf(mac(1, "Roboto Mac")))))
        assertEquals("Roboto", FontFiles.familyNameOf(nameTable(listOf(windows(1, "Roboto DE", 0x0407), unicode(1, "Roboto")))))
        // Other name ids, an empty name and a record past the table are passed over.
        assertEquals("Coming Soon", FontFiles.familyNameOf(nameTable(listOf(windows(4, "Coming Soon Regular"), windows(1, "   "), windows(1, "Coming Soon")))))
        assertNull(FontFiles.familyNameOf(nameTable(listOf(windows(4, "Full name only")))))
        assertNull(FontFiles.familyNameOf(ByteArray(3)))
        val cut = nameTable(listOf(windows(1, "Cut")))
        assertNull(FontFiles.familyNameOf(cut.copyOf(cut.size - 2)))
    }

    @Test
    fun `a single font, an OpenType CFF font, a collection's faces by index – anything else is nameless`() {
        val single = sfnt(nameTable(listOf(windows(1, "Droid Sans Mono"))))
        assertEquals("Droid Sans Mono", FontFiles.familyName(FontFiles.BytesSource(single)))
        assertNull(FontFiles.familyName(FontFiles.BytesSource(single), 1))

        val cff = sfnt(nameTable(listOf(windows(16, "Source Serif"))), version = "OTTO")
        assertEquals("Source Serif", FontFiles.familyName(FontFiles.BytesSource(cff)))
        val mac = sfnt(nameTable(listOf(mac(1, "Apple Mac"))), version = "true")
        assertEquals("Apple Mac", FontFiles.familyName(FontFiles.BytesSource(mac)))

        val collection = ttcf(listOf(nameTable(listOf(windows(1, "Noto Sans CJK JP"))), nameTable(listOf(windows(1, "Noto Sans CJK KR")))))
        assertEquals("Noto Sans CJK JP", FontFiles.familyName(FontFiles.BytesSource(collection), 0))
        assertEquals("Noto Sans CJK KR", FontFiles.familyName(FontFiles.BytesSource(collection), 1))
        assertNull(FontFiles.familyName(FontFiles.BytesSource(collection), 2))

        assertNull(FontFiles.familyName(FontFiles.BytesSource("not a font at all".toByteArray())))
        assertNull(FontFiles.familyName(FontFiles.BytesSource(ByteArray(5))))
        assertNull(FontFiles.familyName(FontFiles.BytesSource(single.copyOf(20))))
    }

    // --- the configuration -----------------------------------------------------------------------

    private val fontsXml = """<?xml version="1.0" encoding="utf-8"?>
        <familyset version="23">
            <family name="sans-serif">
                <font weight="100" style="normal">Roboto-Regular.ttf</font>
                <font weight="700" style="normal">Roboto-Bold.ttf</font>
            </family>
            <alias name="arial" to="sans-serif" />
            <family name=" casual ">
                <font weight="400" style="normal">ComingSoon.ttf</font>
            </family>
            <family name="serif-cjk" lang="ja">
                <font weight="400" style="normal" index="2">NotoSerifCJK-Regular.ttc</font>
            </family>
            <family lang="und-Arab" variant="elegant">
                <font weight="400" style="normal">NotoNaskhArabic-Regular.ttf</font>
            </family>
            <family name="nofile"></family>
        </familyset>
    """.trimIndent()

    @Test
    fun `the named families come in document order with their first file, aliases and fallbacks left out`() {
        val families = FontFiles.namedFamilies(fontsXml.byteInputStream())
        assertEquals(
            listOf(
                FontFiles.NamedFamily("sans-serif", "Roboto-Regular.ttf"),
                FontFiles.NamedFamily("casual", "ComingSoon.ttf"),
                FontFiles.NamedFamily("serif-cjk", "NotoSerifCJK-Regular.ttc#2"),
                FontFiles.NamedFamily("nofile", null)
            ),
            families
        )
        assertEquals(2, FontFiles.collectionIndex("NotoSerifCJK-Regular.ttc#2"))
        assertEquals(0, FontFiles.collectionIndex("Roboto-Regular.ttf"))
        assertEquals(0, FontFiles.collectionIndex(null))
        assertEquals(0, FontFiles.collectionIndex("Odd.ttc#x"))
    }

    @Test
    fun `the list shows each named family by its file's own name, the configuration's after it when they differ`() {
        val dir = Files.createTempDirectory("zen-fonts").toFile()
        try {
            File(dir, "Roboto-Regular.ttf").writeBytes(sfnt(nameTable(listOf(windows(1, "Roboto")))))
            File(dir, "ComingSoon.ttf").writeBytes(sfnt(nameTable(listOf(windows(1, "Coming Soon")))))
            File(dir, "NotoSerifCJK-Regular.ttc").writeBytes(
                ttcf(listOf(nameTable(listOf(windows(1, "Noto Serif CJK SC"))), nameTable(listOf(windows(1, "Noto Serif CJK TC"))), nameTable(listOf(windows(1, "Noto Serif CJK JP")))))
            )
            File(dir, "Casual.ttf").writeBytes(sfnt(nameTable(listOf(windows(1, "casual")))))
            val config = File(dir, "fonts.xml").apply { writeText(fontsXml) }
            // A second configuration naming a family again (another case) adds nothing; its own family is added.
            val product = File(dir, "fonts_customization.xml").apply {
                writeText(
                    """<familyset><family name="Sans-Serif"><font>Casual.ttf</font></family>
                       <family name="oem"><font>Casual.ttf</font></family></familyset>"""
                )
            }
            val entries = FontFiles.list(listOf(config, File(dir, "absent.xml"), product), listOf(File(dir, "nowhere"), dir))
            assertEquals(
                listOf(
                    FontFiles.Entry("sans-serif", "Roboto (sans-serif)"),
                    FontFiles.Entry("casual", "Coming Soon (casual)"),
                    FontFiles.Entry("serif-cjk", "Noto Serif CJK JP (serif-cjk)"),
                    FontFiles.Entry("nofile", "nofile"),
                    FontFiles.Entry("oem", "casual (oem)")
                ),
                entries
            )
            // A file whose own name is the configuration's shows once.
            assertEquals("casual", FontFiles.displayName(FontFiles.NamedFamily("casual", "Casual.ttf"), listOf(dir)))
            // A file the directories do not have: the configuration's name alone.
            assertEquals("missing", FontFiles.displayName(FontFiles.NamedFamily("missing", "Missing.ttf"), listOf(dir)))
            val json = entries.first().toJson()
            assertEquals("sans-serif", json.getString("id"))
            assertEquals("Roboto (sans-serif)", json.getString("name"))
        } finally {
            dir.deleteRecursively()
        }
    }
}
