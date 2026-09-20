package app.zen.chromium

import java.io.ByteArrayOutputStream

/**
 * A small PDF written by hand for the viewer demo, so the document is exactly known: A4 pages
 * of Helvetica text (one of the standard fourteen fonts, so pdf.js draws it from the bundled
 * `standard_fonts`), a title in the Info dictionary, an outline with one entry per page and a
 * link on the first page back to the page that offered the file. `pages` are (heading, lines);
 * the words in them are what the demo's find looks for.
 */
object DemoPdf {
    private const val WIDTH = 595
    private const val HEIGHT = 842

    fun build(title: String, pages: List<Pair<String, List<String>>>, linkUrl: String): ByteArray {
        require(pages.isNotEmpty())
        val objects = ArrayList<String>()
        fun add(body: String): Int {
            objects += body
            return objects.size
        }
        // Object numbers are assigned up front so pages, outlines and the catalog can refer to
        // each other: 1 catalog, 2 pages tree, 3 outlines root, 4 bold font, 5 regular font,
        // 6 info, then per page: page, contents, outline item (and the link on the first page).
        val catalog = 1
        val pagesTree = 2
        val outlines = 3
        val bold = 4
        val regular = 5
        val info = 6
        val perPage = 3
        val firstPageObject = 7
        val link = firstPageObject + pages.size * perPage
        fun pageObject(i: Int) = firstPageObject + i * perPage
        fun contentsObject(i: Int) = pageObject(i) + 1
        fun outlineObject(i: Int) = pageObject(i) + 2

        add("<< /Type /Catalog /Pages $pagesTree 0 R /Outlines $outlines 0 R /PageMode /UseOutlines >>")
        add("<< /Type /Pages /Kids [ ${pages.indices.joinToString(" ") { "${pageObject(it)} 0 R" }} ] /Count ${pages.size} >>")
        add("<< /Type /Outlines /First ${outlineObject(0)} 0 R /Last ${outlineObject(pages.lastIndex)} 0 R /Count ${pages.size} >>")
        add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
        add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        add("<< /Title (${escape(title)}) /Author (Zenium) /Producer (DemoPdf) >>")
        for ((i, page) in pages.withIndex()) {
            val (heading, lines) = page
            val annots = if (i == 0) " /Annots [ $link 0 R ]" else ""
            add(
                "<< /Type /Page /Parent $pagesTree 0 R /MediaBox [0 0 $WIDTH $HEIGHT] /Contents ${contentsObject(i)} 0 R" +
                    " /Resources << /Font << /F1 $bold 0 R /F2 $regular 0 R >> >>$annots >>"
            )
            val content = StringBuilder()
            content.append("BT /F1 28 Tf 64 ${HEIGHT - 96} Td (${escape(heading)}) Tj ET\n")
            content.append("BT /F2 15 Tf 18 TL 64 ${HEIGHT - 150} Td\n")
            for (line in lines) content.append("(${escape(line)}) Tj T*\n")
            content.append("ET\n")
            content.append("BT /F2 11 Tf 64 48 Td (Page ${i + 1} of ${pages.size}) Tj ET\n")
            if (i == 0) content.append("BT /F2 15 Tf 64 ${HEIGHT - 700} Td (Back to the tide tables page) Tj ET\n")
            val bytes = content.toString().toByteArray(Charsets.ISO_8859_1)
            add("<< /Length ${bytes.size} >>\nstream\n${content}endstream")
            val prev = if (i > 0) " /Prev ${outlineObject(i - 1)} 0 R" else ""
            val next = if (i < pages.lastIndex) " /Next ${outlineObject(i + 1)} 0 R" else ""
            add("<< /Title (${escape(heading)}) /Parent $outlines 0 R$prev$next /Dest [ ${pageObject(i)} 0 R /XYZ 0 $HEIGHT 0 ] >>")
        }
        // The link's rectangle sits under the "Back to the tide tables page" line of the first page.
        add(
            "<< /Type /Annot /Subtype /Link /Rect [ 60 ${HEIGHT - 706} 320 ${HEIGHT - 682} ] /Border [ 0 0 0 ]" +
                " /A << /S /URI /URI (${escape(linkUrl)}) >> >>"
        )
        check(objects.size == link)

        val out = ByteArrayOutputStream()
        fun write(text: String) = out.write(text.toByteArray(Charsets.ISO_8859_1))
        write("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n")
        val offsets = IntArray(objects.size + 1)
        for ((index, body) in objects.withIndex()) {
            offsets[index + 1] = out.size()
            write("${index + 1} 0 obj\n$body\nendobj\n")
        }
        val xref = out.size()
        write("xref\n0 ${objects.size + 1}\n")
        write("0000000000 65535 f \n")
        for (i in 1..objects.size) write("%010d 00000 n \n".format(offsets[i]))
        write("trailer\n<< /Size ${objects.size + 1} /Root $catalog 0 R /Info $info 0 R >>\nstartxref\n$xref\n%%EOF\n")
        return out.toByteArray()
    }

    /** Text in a PDF string literal: the delimiters and the backslash escaped. */
    private fun escape(text: String): String =
        text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
}
