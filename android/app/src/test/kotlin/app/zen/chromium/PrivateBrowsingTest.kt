package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The host's side of private browsing beyond the profile: the window's screenshot guard goes up
 * exactly while the chrome says the surface is private (a recording is let in only when asked,
 * which [PrivateBrowsing.guard] allows in debug builds alone), and the launcher's static shortcut
 * reaches `MainActivity` with the action the activity turns into a private tab. The resource
 * wiring is checked from the files: a shortcut whose meta-data, id, action or target drifted
 * would install and never open anything.
 */
class PrivateBrowsingTest {
    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    @Test
    fun theGuardGoesUpOnThePrivateSurfaceAloneAndARecordingTakesItDown() {
        assertTrue(PrivateBrowsing.guardWanted(privateSurface = true, recording = false))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = false, recording = false))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = true, recording = true))
        assertFalse(PrivateBrowsing.guardWanted(privateSurface = false, recording = true))
        // The override is off until a recording driver turns it on.
        assertFalse(PrivateBrowsing.captureForRecording)
    }

    private fun shortcuts() = read(SHORTCUTS_TEMPLATE, "app/$SHORTCUTS_TEMPLATE")

    @Test
    fun theShortcutOpensAPrivateTabInTheBrowserActivity() {
        val shortcuts = shortcuts()
        val shortcut = shortcuts.substringAfter("<shortcut").substringBefore("</shortcut>")
        assertTrue("""android:shortcutId="${PrivateBrowsing.SHORTCUT_ID}"""" in shortcut)
        assertTrue("""android:enabled="true"""" in shortcut)
        assertTrue("""android:action="${PrivateBrowsing.ACTION_NEW_TAB}"""" in shortcut)
        assertTrue("""android:targetClass="app.zen.chromium.MainActivity"""" in shortcut)
        // One shortcut: the launcher shows the app's own before any pinned web app.
        assertEquals(1, Regex("<shortcut\\s").findAll(shortcuts).count())
    }

    /**
     * The system server reads the intent's targetPackage as a plain string with its own resources:
     * an @string reference of the app's installs a shortcut to "@<id>/MainActivity" that nothing
     * can start. So the file is a template the build writes per variant with the applicationId
     * spelt out (debug carries a suffix), and no copy of it sits in res/ to shadow the written one.
     */
    @Test
    fun theShortcutTargetsTheVariantsApplicationIdSpeltOut() {
        val shortcut = shortcuts().substringAfter("<shortcut").substringBefore("</shortcut>")
        assertTrue("""android:targetPackage="${'$'}{applicationId}"""" in shortcut)
        assertFalse("@string" in shortcut.substringAfter("<intent"))
        val build = read("build.gradle.kts", "app/build.gradle.kts")
        assertTrue("class WriteShortcuts" in build)
        assertTrue("""file("$SHORTCUTS_TEMPLATE")""" in build)
        assertTrue("""replace("\${'$'}{applicationId}", applicationId.get())""" in build)
        assertTrue("addGeneratedSourceDirectory(write, WriteShortcuts::outputDirectory)" in build)
        assertTrue("""resolve("xml/shortcuts.xml")""" in build)
        assertFalse(File("src/main/res/xml/shortcuts.xml").exists() || File("app/src/main/res/xml/shortcuts.xml").exists())
    }

    @Test
    fun theShortcutsLabelsAndIconExist() {
        val shortcuts = shortcuts()
        val strings = read("src/main/res/values/strings.xml", "app/src/main/res/values/strings.xml")
        for (name in listOf("shortcut_private_short", "shortcut_private_long")) {
            assertTrue("$name unused", """@string/$name"""" in shortcuts)
            assertTrue("$name undefined", """<string name="$name">""" in strings)
        }
        assertTrue("""<string name="shortcut_private_short">New private tab</string>""" in strings)
        assertTrue("""android:icon="@drawable/ic_shortcut_private"""" in shortcuts)
        val icon = read(
            "src/main/res/drawable/ic_shortcut_private.xml",
            "app/src/main/res/drawable/ic_shortcut_private.xml"
        )
        assertTrue("<adaptive-icon" in icon)
        assertTrue("@drawable/ic_shortcut_private_foreground" in icon)
        assertTrue("@color/shortcut_private_background" in icon)
    }

    @Test
    fun everyLauncherAliasDeclaresTheShortcuts() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val meta = """<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />"""
        val aliases = manifest.split("<activity-alias").drop(1)
        assertEquals(LauncherIconVariants.ALIASES.size, aliases.size)
        for (alias in aliases) {
            val body = alias.substringBefore("</activity-alias>")
            assertTrue("an alias without the shortcuts: ${body.lines().first()}", meta in body)
            assertTrue("android.intent.category.LAUNCHER" in body)
        }
        // The browser activity itself holds no launcher entry, so the meta-data would be dead there.
        val activity = manifest.substringAfter("android:name=\".MainActivity\"").substringBefore("</activity>")
        assertFalse("android.app.shortcuts" in activity)
    }

    private companion object {
        const val SHORTCUTS_TEMPLATE = "src/main/shortcuts/shortcuts.xml"
    }
}
