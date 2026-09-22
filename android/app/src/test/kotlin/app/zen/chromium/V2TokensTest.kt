package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.roundToInt

/**
 * The page-unresponsive prompt is the one chrome surface the app draws natively (v2 §9.23), and
 * its inks must be the chrome's own: every value read from the token block of the theme in
 * force and pinned by a test against the CSS, never retyped. [V2Tokens] is generated from
 * `main.css`; this test parses the same stylesheet again, on the JVM and with a parser of its
 * own, and fails when the table and the CSS disagree on any ink – so a change to a token in the
 * chrome's stylesheet fails the Android build until the table is regenerated, and the sheet the
 * user sees can never drift from the sheet the chrome draws.
 */
class V2TokensTest {
    private val css: String by lazy {
        val candidates = listOf(
            "../../src/renderer/src/assets/main.css",
            "../src/renderer/src/assets/main.css",
            "src/renderer/src/assets/main.css"
        )
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("main.css not found from ${File(".").absolutePath}", file != null)
        file!!.readText().replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
    }

    /** The declarations of the first `selector { … }` whose body declares `marker`. */
    private fun block(selector: String, marker: String): Map<String, String> {
        val pattern = Regex("(?m)^" + Regex.escape(selector) + " \\{([\\s\\S]*?)^\\}")
        val body = pattern.findAll(css).map { it.groupValues[1] }.firstOrNull { it.contains(marker) }
        assertTrue("no $selector block declaring $marker in main.css", body != null)
        return Regex("(?m)^\\s*(--[\\w-]+):\\s*([^;]+);").findAll(body!!)
            .associate { it.groupValues[1] to it.groupValues[2].trim() }
    }

    /** A CSS colour – `#rrggbb`, `rgb(r g b)`, `rgb(r g b / a)` – as ARGB. */
    private fun argb(value: String): Int {
        Regex("^#([0-9a-fA-F]{6})$").find(value)?.let { return (0xFF shl 24) or it.groupValues[1].toInt(16) }
        val m = Regex("^rgb\\((\\d+) (\\d+) (\\d+)(?: / ([\\d.]+))?\\)$").find(value)
            ?: error("not a colour the table can carry: $value")
        val (r, g, b) = m.groupValues.subList(1, 4).map { it.toInt() }
        val a = m.groupValues[4].ifEmpty { "1" }.toFloat()
        return ((a * 255).roundToInt() shl 24) or (r shl 16) or (g shl 8) or b
    }

    private fun check(dark: Boolean, table: V2Tokens.Theme) {
        val selector = if (dark) ":root[data-theme='dark']" else ":root"
        val v2 = block(selector, "--v2-page:")
        val v1 = block(selector, "--zen-danger:")
        fun ink(name: String): Int = argb(v2[name] ?: error("$selector declares no $name"))
        val scrimAlpha = (v2["--zen-scrim-alpha"] ?: error("$selector declares no --zen-scrim-alpha")).toFloat()
        assertEquals("$selector --v2-panel", ink("--v2-panel"), table.panel)
        assertEquals("$selector --v2-border", ink("--v2-border"), table.border)
        assertEquals("$selector --v2-text", ink("--v2-text"), table.text)
        assertEquals("$selector --v2-text-deemphasized", ink("--v2-text-deemphasized"), table.textDeemphasized)
        assertEquals("$selector --v2-fill", ink("--v2-fill"), table.fill)
        assertEquals("$selector --v2-fill-hover", ink("--v2-fill-hover"), table.fillHover)
        assertEquals("$selector --zen-scrim-alpha", scrimAlpha, table.scrimAlpha, 0.0001f)
        assertEquals("$selector --v2-scrim", "rgb(0 0 0 / var(--zen-scrim-alpha))", v2["--v2-scrim"])
        assertEquals("$selector --v2-scrim as ARGB", argb("rgb(0 0 0 / $scrimAlpha)"), table.scrim)
        assertEquals("$selector --zen-danger (--v2-danger's alias)", argb(v1["--zen-danger"] ?: error("no --zen-danger")), table.danger)
    }

    @Test
    fun `the light table is the light token block`() = check(dark = false, V2Tokens.light)

    @Test
    fun `the dark table is the dark token block`() = check(dark = true, V2Tokens.dark)

    @Test
    fun `--v2-danger aliases the chrome's --zen-danger, which the table reads`() {
        assertEquals("var(--zen-danger)", block(":root", "--v2-page:")["--v2-danger"])
    }

    @Test
    fun `the grabber's alpha is the chassis's zen-sheet-handle`() {
        val m = Regex("\\.zen-sheet-handle \\{[^}]*background: rgb\\(var\\(--v2-text-rgb\\) / ([\\d.]+)\\);").find(css)
        assertTrue("no .zen-sheet-handle background on the text ink in main.css", m != null)
        assertEquals(m!!.groupValues[1].toFloat(), V2Tokens.HANDLE_ALPHA, 0.0001f)
    }

    @Test
    fun `of() picks the theme in force`() {
        assertEquals(V2Tokens.light, V2Tokens.of(dark = false))
        assertEquals(V2Tokens.dark, V2Tokens.of(dark = true))
    }
}
