package app.zen.chromium

/**
 * How a start of the capture service came out ([CaptureService], NOT-13): in the foreground as
 * the kinds asked, in the foreground as fewer, or not at all.
 */
enum class ForegroundStart {
    /** In the foreground as the camera / microphone kinds asked: the capture carries on behind other apps. */
    TYPED,
    /**
     * In the foreground, but not as asked: as the kinds of the ask the app holds the runtime
     * permission for, when Android 14 refused one it does not (a camera + microphone request
     * answered with the microphone alone), or – the service standing already – as the kinds it
     * stood as. The card is the service's still; the kind refused is at the system's mercy behind
     * other apps.
     */
    NARROWED,
    /**
     * No start took (Android 14 refuses a camera or microphone service from an app in the
     * background): the service stops, and the caller posts the card as a plain notification.
     */
    STOPPED;

    /** Whether the service holds the card. */
    val holds: Boolean get() = this != STOPPED
}

/** The capture service's start, pure, so its three ends have a table ([CaptureForegroundTest]). */
object CaptureForeground {
    /** Where the ladder ended: the outcome, and the kinds the service holds (0 for none). */
    data class End(val outcome: ForegroundStart, val type: Int)

    /**
     * Try the start as asked (`type`: the `ServiceInfo.FOREGROUND_SERVICE_TYPE_*` bits, 0 for no
     * kind below Android 11), then, refused, as the kinds of `type` the app holds the runtime
     * permission for (`held`) when those are fewer and not none; [ForegroundStart.STOPPED] when
     * neither took. `start(kind)` is the `startForeground` call, answering whether it took; no
     * kind is tried twice.
     */
    fun enter(type: Int, held: Int, start: (Int) -> Boolean): End {
        if (start(type)) return End(ForegroundStart.TYPED, type)
        val narrowed = type and held
        if (narrowed != 0 && narrowed != type && start(narrowed)) return End(ForegroundStart.NARROWED, narrowed)
        return End(ForegroundStart.STOPPED, 0)
    }
}
