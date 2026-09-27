package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The game widget's face pin (WID-04 / ERR-03): the resource files as the build reads them, held
 * to gate #607 (f) – one cell, fixed; the picker's words; the picture (the mark rolling on a ground
 * line: the ring and its dot in the brand indigo, the ground in the ink) on the quick actions
 * widget's colour roles (WID-02: the card its surface, the press its button), the hairline the
 * pre-31 card's alone, the system's widget radius on Android 12+; the layout's root the launcher
 * clips; the manifest's receiver.
 */
class GameWidgetFaceTest {
    private val root = repoRoot()
    private val res = File(root, "android/app/src/main/res")

    @Test
    fun theInfoIsOneCellFixedWithThePickersWordsAndPreviews() {
        val info = read("xml/appwidget_game.xml")
        for (attribute in listOf(
            """android:initialLayout="@layout/widget_game"""",
            """android:minWidth="@dimen/widget_game_size"""",
            """android:minHeight="@dimen/widget_game_size"""",
            """android:resizeMode="none"""",
            """android:targetCellWidth="1"""",
            """android:targetCellHeight="1"""",
            """android:previewImage="@drawable/widget_game_preview"""",
            """android:previewLayout="@layout/widget_game_preview"""",
            """android:description="@string/widget_game_description"""",
            """android:widgetCategory="home_screen"""",
            """android:updatePeriodMillis="0""""
        )) assertTrue("appwidget_game.xml carries $attribute", info.contains(attribute))
        // Fixed at one cell: no resize floor or ceiling of its own.
        for (absent in listOf("minResizeWidth", "minResizeHeight", "maxResizeWidth", "maxResizeHeight")) {
            assertFalse("no $absent", info.contains("android:$absent"))
        }
        // The platform's one-cell minimum (70 dp a cell less 30).
        assertEquals("40dp", dimens("values/dimens.xml")["widget_game_size"])
    }

    @Test
    fun thePickersWordsAreTheGatesAndTheFaceSaysWhatATapDoes() {
        val strings = strings("values/strings.xml")
        assertEquals("Zenium Roll", strings["widget_game_label"])
        assertEquals("Play Roll, Zenium\\'s offline game", strings["widget_game_description"])
        assertEquals("Play Roll", strings["widget_game_face"])
    }

    @Test
    fun theLayoutIsOneCardTheLauncherClipsWithTheGlyphAtItsCentre() {
        val layout = read("layout/widget_game.xml")
        assertTrue("the root is @android:id/background", layout.contains("""android:id="@android:id/background""""))
        assertTrue("the root clips to its outline", layout.contains("""android:clipToOutline="true""""))
        assertTrue("the root wears the card", layout.contains("""android:background="@drawable/widget_game_card""""))
        assertTrue("the face is the one clickable part", layout.contains("""android:id="@+id/widget_game_face""""))
        assertTrue("the face carries its name", layout.contains("""android:contentDescription="@string/widget_game_face""""))
        assertTrue("the face presses in the button role", layout.contains("""android:background="@drawable/widget_game_button""""))
        assertTrue("the glyph is drawn at its own size, centred", layout.contains("""android:scaleType="center"""") && layout.contains("""android:src="@drawable/ic_widget_roll""""))
        assertEquals(1, Regex("""android:id="@\+id/""").findAll(layout).count())
        // The preview layout is the face at 64 dp under the picker's hairline.
        val preview = read("layout/widget_game_preview.xml")
        assertTrue(preview.contains("""<include layout="@layout/widget_game" />"""))
        assertTrue(preview.contains("""android:foreground="@drawable/widget_game_preview_frame""""))
        assertEquals("64dp", dimens("values/dimens.xml")["widget_game_preview"])
    }

    @Test
    fun theGlyphIsTheMarkRollingOnAGroundLineInTheGatesColours() {
        val glyph = read("drawable/ic_widget_roll.xml")
        val strokes = Regex("""android:strokeColor="([^"]+)"""").findAll(glyph).map { it.groupValues[1] }.toList()
        val fills = Regex("""android:fillColor="([^"]+)"""").findAll(glyph).map { it.groupValues[1] }.toList()
        // The ground line in the ink, the ring in the indigo, the dot filled in the indigo; nothing else coloured.
        assertEquals(listOf("@color/widget_search_ink", "@color/widget_search_mark"), strokes)
        assertEquals(listOf("#00000000", "#00000000", "@color/widget_search_mark"), fills)
        assertTrue("the ground is a line", glyph.contains("""android:pathData="M3,18.5 H21""""))
        // The ring rests on the line: its outer edge (centre 10.125 + radius 6.5 + half the stroke) is the line's top (18.5 less half its stroke).
        val ring = Regex("""M12,([0-9.]+) a6\.5,6\.5""").find(glyph) ?: error("no ring")
        val top = ring.groupValues[1].toDouble()
        val centre = top + 6.5
        assertEquals(18.5 - 1.75 / 2, centre + 6.5 + 2.0 / 2, 1e-6)
        // A 32 dp box (values/dimens.xml), the picture at 24 units.
        assertTrue(glyph.contains("""android:width="@dimen/widget_game_glyph""""))
        assertEquals("32dp", dimens("values/dimens.xml")["widget_game_glyph"])
        assertTrue(glyph.contains("""android:viewportWidth="24""""))
        // The pre-31 picker's vector repeats the picture whole.
        val preview = read("drawable/widget_game_preview.xml")
        for (path in listOf("M3,18.5 H21", "M12,3.625 a6.5,6.5 0 1,0 0.01,0 Z", "M14.49,6.04 a2,2 0 1,0 0.01,0 Z")) {
            assertTrue("the preview draws $path", preview.contains("""android:pathData="$path""""))
        }
        assertTrue(preview.contains("""android:fillColor="@color/widget_quick_actions_surface""""))
    }

    @Test
    fun theCardIsTheQuickActionsSurfaceHairlinedBelowAndroid12Alone() {
        val below = read("drawable/widget_game_card.xml")
        assertTrue(below.contains("""<solid android:color="@color/widget_quick_actions_surface" />"""))
        assertTrue(below.contains("""android:color="@color/widget_quick_actions_hairline""""))
        assertTrue(below.contains("""<corners android:radius="@dimen/widget_game_radius" />"""))
        val dynamic = read("drawable-v31/widget_game_card.xml")
        assertTrue(dynamic.contains("""<solid android:color="@color/widget_quick_actions_surface" />"""))
        assertFalse("no hairline on the dynamic face", dynamic.contains("<stroke"))
        assertTrue(dynamic.contains("""<corners android:radius="@dimen/widget_game_radius" />"""))
        // The press: a ripple in the button role, masked at the card's radius, no fill of its own.
        val button = read("drawable/widget_game_button.xml")
        assertTrue(button.contains("""android:color="@color/widget_quick_actions_button""""))
        assertTrue(button.contains("""<item android:id="@android:id/mask">"""))
        assertTrue(button.contains("""<corners android:radius="@dimen/widget_game_radius" />"""))
        assertEquals(1, Regex("<item\\b").findAll(button).count())
        // The radius: the extra-small card's 16 dp, the system's widget radius from Android 12.
        assertEquals("16dp", dimens("values/dimens.xml")["widget_game_radius"])
        assertEquals("@android:dimen/system_app_widget_background_radius", dimens("values-v31/dimens.xml")["widget_game_radius"])
        // The picker's frame is the hairline at that radius.
        val frame = read("drawable/widget_game_preview_frame.xml")
        assertTrue(frame.contains("""android:color="@color/widget_quick_actions_hairline""""))
        assertTrue(frame.contains("""<corners android:radius="@dimen/widget_game_radius" />"""))
    }

    @Test
    fun theManifestDeclaresTheReceiverForTheSystemsUpdateAlone() {
        val manifest = File(root, "android/app/src/main/AndroidManifest.xml").readText()
        val receiver = Regex("""<receiver\s+android:name="\.GameWidgetProvider"[\s\S]*?</receiver>""").find(manifest)?.value
            ?: error("no GameWidgetProvider receiver")
        assertTrue(receiver.contains("""android:exported="true""""))
        assertTrue(receiver.contains("""android:label="@string/widget_game_label""""))
        assertTrue(receiver.contains("""<action android:name="android.appwidget.action.APPWIDGET_UPDATE" />"""))
        assertTrue(receiver.contains("""android:resource="@xml/appwidget_game""""))
        assertEquals(1, Regex("<action\\b").findAll(receiver).count())
    }

    private fun read(path: String): String = File(res, path).readText()

    /** `name → value` for every `<dimen>` in a values file. */
    private fun dimens(path: String): Map<String, String> =
        Regex("""<dimen name="([a-z0-9_]+)">([^<]+)</dimen>""").findAll(read(path)).associate { it.groupValues[1] to it.groupValues[2] }

    /** `name → value` for every `<string>` in a values file. */
    private fun strings(path: String): Map<String, String> =
        Regex("""<string name="([a-z0-9_]+)">([^<]+)</string>""").findAll(read(path)).associate { it.groupValues[1] to it.groupValues[2] }

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
