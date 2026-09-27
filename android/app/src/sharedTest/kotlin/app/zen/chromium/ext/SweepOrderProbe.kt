package app.zen.chromium.ext

/**
 * The storage order probe's word on its four legs (the compat sweep's `storageOrderProbe`, round
 * 21's R21-12; compat round 23's R23-3). Pure: the driver hands over what the legs did and the
 * analysis's runtime-attributed fault count; this decides the grade and words the legs.
 *
 * The rule: `F` on any runtime-attributed fault (an inversion after receipt, a stale read after
 * an acknowledged set, an order-leg inversion); `P` when the four legs ran in full; `P` too when
 * ONE of the six fingers was lost to the harness while the same write by script landed six of
 * six and the order and burst legs ran in full – the runtime's measure was evaluated whole and
 * a finger the WebView read as a long-press under a frame stall (round 22 on WebView 156: a
 * 50-54-frame main-thread stall, the selection toolbar up, no click) is the driver's input, not
 * the runtime's order; the note names the loss and the attempts. `PARTIAL` otherwise (two or
 * more fingers lost is a touch problem worth the grade's attention; a script tap missing, an
 * order or a burst leg not done leave the measure short).
 */
object SweepOrderProbe {
    const val FINGERS = 6
    const val SCRIPT_TAPS = 6

    /** What the four legs did. */
    data class Legs(
        val touched: Int,
        val touchAttempts: Int,
        val evaluated: Int,
        val orderStarted: Boolean,
        val orderDone: Boolean,
        val burstStarted: Boolean,
        val burstDone: Boolean
    )

    /** The grade, the legs' wording and – a lost finger graded through – the loss named. */
    data class Word(val verdict: String, val legs: String, val fingerNote: String?)

    /** Whether the legs' measure is whole with one finger short: the grader's word (see the class doc). */
    fun oneFingerShortButWhole(legs: Legs): Boolean =
        legs.touched == FINGERS - 1 && legs.evaluated >= SCRIPT_TAPS && legs.orderDone && legs.burstDone

    fun word(legs: Legs, runtimeFaults: Int): Word {
        val legsText = "touched ${legs.touched}/$FINGERS (attempts ${legs.touchAttempts}), evaluated ${legs.evaluated}/$SCRIPT_TAPS, " +
            "order ${leg(legs.orderStarted, legs.orderDone)}, burst ${leg(legs.burstStarted, legs.burstDone)}"
        val full = legs.touched >= FINGERS && legs.evaluated >= SCRIPT_TAPS && legs.orderDone && legs.burstDone
        return when {
            runtimeFaults > 0 -> Word("F", legsText, null)
            full -> Word("P", legsText, null)
            oneFingerShortButWhole(legs) -> Word(
                "P",
                legsText,
                "one of the $FINGERS fingers was lost to the harness (${legs.touchAttempts} attempts; the WebView reads a finger held through a frame stall as a long-press) " +
                    "while the same write by script landed $SCRIPT_TAPS/$SCRIPT_TAPS and the order and burst legs ran in full – the runtime's measure evaluated whole"
            )
            else -> Word("PARTIAL", legsText, null)
        }
    }

    private fun leg(started: Boolean, done: Boolean): String = if (done) "done" else if (started) "NOT done" else "not started"
}
