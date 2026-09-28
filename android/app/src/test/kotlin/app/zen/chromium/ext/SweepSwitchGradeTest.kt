package app.zen.chromium.ext

import app.zen.chromium.ext.SweepSwitchGrade.How
import org.junit.Assert.assertEquals
import org.junit.Test

class SweepSwitchGradeTest {
    private val longPress = "the first tap landed as a long-press (text selected in the document); the selection cleared and the control tapped again"

    private fun word(
        pass: Boolean,
        popupRendered: Boolean = true,
        controlFound: Boolean = true,
        how: How = How.TAP,
        tapRecord: String? = null,
        found: String = "{\"pass\":$pass,\"style\":$pass}",
        popupText: String = "Enable Copy Paste For All Websites"
    ) = SweepSwitchGrade.word("E.C.P", "#enable-checkbox", pass, popupRendered, controlFound, how, tapRecord, controlWaitS = 12, settleS = 102, found = found, popupText = popupText)

    @Test
    fun `a plain tap that restyled the fixture - P, tapped`() {
        val w = word(pass = true)
        assertEquals("P", w.verdict)
        assertEquals("E.C.P: the popup's switch (tapped) restyled the fixture: {\"pass\":true,\"style\":true}", w.note)
    }

    @Test
    fun `a tap read as a long-press first and repeated carries the record in the parenthesis`() {
        assertEquals("tapped; $longPress", SweepSwitchGrade.pressed(How.TAP, longPress))
        val w = word(pass = true, tapRecord = longPress)
        assertEquals("P", w.verdict)
        assertEquals("E.C.P: the popup's switch (tapped; $longPress) restyled the fixture: {\"pass\":true,\"style\":true}", w.note)
        assertEquals("tapped", SweepSwitchGrade.pressed(How.TAP, ""))
    }

    @Test
    fun `the script click after a finger the control did not take is named`() {
        val w = word(pass = true, how = How.SCRIPT)
        assertEquals("P", w.verdict)
        assertEquals("E.C.P: the popup's switch (clicked by script) restyled the fixture: {\"pass\":true,\"style\":true}", w.note)
    }

    @Test
    fun `no popup and no control are F with their own words`() {
        val noPopup = word(pass = false, popupRendered = false, controlFound = false, how = How.NONE)
        assertEquals("F", noPopup.verdict)
        assertEquals("E.C.P: popup did not render in the core check", noPopup.note)
        val noControl = word(pass = false, controlFound = false, how = How.NONE)
        assertEquals("F", noControl.verdict)
        assertEquals("E.C.P: no `#enable-checkbox` control in the popup within 12 s (\"Enable Copy Paste For All Websites\")", noControl.note)
    }

    @Test
    fun `a control tapped with no effect is F within the settle`() {
        val w = word(pass = false)
        assertEquals("F", w.verdict)
        assertEquals("E.C.P: the switch was tapped and the fixture shows no effect within 102 s: {\"pass\":false,\"style\":false}", w.note)
        val retried = word(pass = false, how = How.SCRIPT, tapRecord = longPress)
        assertEquals("E.C.P: the switch was clicked by script and the fixture shows no effect within 102 s: {\"pass\":false,\"style\":false}", retried.note)
    }

    @Test
    fun `a control found but never pressed does not claim a tap`() {
        val w = word(pass = false, how = How.NONE, tapRecord = "the browser was off screen")
        assertEquals("F", w.verdict)
        assertEquals("E.C.P: the switch was found and not pressed (the browser was off screen); the fixture shows no effect: {\"pass\":false,\"style\":false}", w.note)
        assertEquals("E.C.P: the switch was found and not pressed (no finger went down); the fixture shows no effect: {\"pass\":false,\"style\":false}", word(pass = false, how = How.NONE).note)
    }
}
