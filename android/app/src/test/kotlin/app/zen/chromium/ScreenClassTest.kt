package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The window's class on the 600 dp line, each side of it (MED-02's form-factor gate; design
 * language v2 §9.36): a window under 600 dp on its short side is a phone's, whose turn takes a
 * playing video fullscreen, and one of 600 or more is a large screen – the tablet layout's class –
 * where rotate-to-fullscreen never runs. The line is the chrome's (`PHONE_MAX_WIDTH` in
 * `shared/formFactor.ts`, `classifyViewport`'s `side < PHONE_MAX_WIDTH` for a phone), read from
 * the source, so the host and the chrome cannot pick a tablet on two different lines.
 */
class ScreenClassTest {
    @Test
    fun aWindowUnderTheLineIsAPhonesWhoseTurnTakesItsVideoFullscreen() {
        assertFalse(ScreenClass.large(599))
        assertTrue(ScreenClass.rotateToFullscreen(599))
        // A phone's window, and a tablet's narrowed in split screen: a phone's while it stays so.
        assertFalse(ScreenClass.large(360))
        assertTrue(ScreenClass.rotateToFullscreen(360))
    }

    @Test
    fun aWindowOnOrPastTheLineIsALargeScreenWhoseTurnTurnsNothing() {
        assertTrue(ScreenClass.large(600))
        assertFalse(ScreenClass.rotateToFullscreen(600))
        assertTrue(ScreenClass.large(800))
        assertFalse(ScreenClass.rotateToFullscreen(800))
    }

    @Test
    fun theLineIsTheChromesPhoneMaxWidthOnTheSameSide() {
        val formFactor = File(repoRoot(), "src/shared/formFactor.ts").readText()
        val phoneMax = Regex("""export const PHONE_MAX_WIDTH = (\d+)""").find(formFactor)?.groupValues?.get(1)?.toInt()
            ?: error("formFactor.ts declares no PHONE_MAX_WIDTH")
        assertEquals("the host's line is the chrome's", phoneMax, ScreenClass.LARGE_MIN_DP)
        assertEquals("Android's sw600dp", 600, ScreenClass.LARGE_MIN_DP)
        // The chrome's phone is the short side strictly under the line: 600 is a tablet's on both sides.
        assertTrue("classifyViewport picks a phone under the line", formFactor.contains("if (side < PHONE_MAX_WIDTH) return 'phone'"))
    }

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}
