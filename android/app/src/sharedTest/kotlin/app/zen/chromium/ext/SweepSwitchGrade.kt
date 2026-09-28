package app.zen.chromium.ext

/**
 * The word of a popup-switch row's core grade (the compat sweep's `popupSwitch`: OpenDyslexic,
 * Dark Theme, Helperbird, Enable right click, High Contrast, Enable Copy Paste; compat round 23).
 * Pure: the driver hands over what it saw – the popup rendered or not, the control found or
 * not, how the control was pressed and what the WebView-dispatched tap left behind – and this
 * decides the verdict and words it.
 *
 * The press is named in the grade's parenthesis so a lane's reading can be told apart from the
 * runtime's: a plain finger is "tapped"; a finger whose first landing the WebView read as a
 * long-press under a frame stall (round 23's BEFORE on WebView 156: Enable Copy Paste's checkbox
 * never toggled – the popup's `storage.set` missing from the bridge where WebView 113 has it –
 * with Choreographer skipping 46-84 frames across the tap's second) carries the tap's record,
 * "tapped; the first tap landed as a long-press (…) … and the control tapped again"; the script
 * click after a finger the control did not take is "clicked by script"; a control found but
 * never pressed (no screen point for it, or the browser off screen) is named as not pressed, so
 * the `F` does not claim a tap that never went down.
 */
object SweepSwitchGrade {
    /** What pressed the control. */
    enum class How { NONE, TAP, SCRIPT }

    /** The verdict and its note. */
    data class Word(val verdict: String, val note: String)

    /** The press for the grade's parenthesis. */
    fun pressed(how: How, tapRecord: String?): String = when (how) {
        How.TAP -> if (tapRecord.isNullOrEmpty()) "tapped" else "tapped; $tapRecord"
        How.SCRIPT -> "clicked by script"
        How.NONE -> "not pressed"
    }

    /**
     * @param pass the fixture's `expr` read `pass` true
     * @param popupRendered the popup came up for the core check
     * @param controlFound `switch` had a centre in the popup within `controlWaitS`
     * @param how what pressed the control last (the script click follows a finger the control did not take)
     * @param tapRecord what the WebView-dispatched tap left (null for a plain tap)
     * @param found the fixture's last `expr` reading, as text
     * @param popupText the popup's text, for a control never found
     */
    fun word(
        label: String,
        switch: String,
        pass: Boolean,
        popupRendered: Boolean,
        controlFound: Boolean,
        how: How,
        tapRecord: String?,
        controlWaitS: Long,
        settleS: Long,
        found: String,
        popupText: String
    ): Word {
        val press = pressed(how, tapRecord)
        return when {
            pass -> Word("P", "$label: the popup's switch ($press) restyled the fixture: ${found.take(220)}")
            !popupRendered -> Word("F", "$label: popup did not render in the core check")
            !controlFound -> Word("F", "$label: no `$switch` control in the popup within $controlWaitS s (\"${popupText.take(100)}\")")
            how == How.NONE -> Word("F", "$label: the switch was found and not pressed (${tapRecord ?: "no finger went down"}); the fixture shows no effect: ${found.take(200)}")
            else -> Word("F", "$label: the switch was $press and the fixture shows no effect within $settleS s: ${found.take(200)}")
        }
    }
}
