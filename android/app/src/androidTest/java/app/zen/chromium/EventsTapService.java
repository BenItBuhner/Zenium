package app.zen.chromium;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;

/**
 * The accessibility service the harness keeps enabled for a run, so a current WebView sends its
 * accessibility events at all. It listens for every event type ({@code res/xml/events_tap_service.xml}:
 * {@code typeAllMask}, generic feedback, no flags, no capabilities) and does nothing with them.
 *
 * <p>Chromium's WebView from 124 on (the API 35 image's own build, and the 145 the recipe installs
 * over the API 33 image's 109, whose gate sat behind the {@code OnDemandAccessibilityEvents} flag,
 * off) dispatches an accessibility event only when its type is among those some ENABLED
 * accessibility service asked for: the union of {@code eventTypes} over
 * {@code AccessibilityManager.getEnabledAccessibilityServiceList} ({@code AccessibilityState
 * .relevantEventTypesForCurrentServices}, applied in {@code AccessibilityEventDispatcher
 * .enqueueEvent}). UiAutomation is not in that list, so with no service enabled the mask is empty:
 * the chrome answers every node request the driver makes and never announces a change. The
 * framework's node cache in UiAutomation is invalidated by events alone, and its explicit
 * {@code clearCache()} exists only from API 34 – on API 33 a driver read the tree as it was, the
 * menu's rows at their peek positions after the sheet was pulled up.
 *
 * <p>With this service enabled the mask covers every type, Chromium dispatches as it did before
 * 124 (the framework forwards each event to UiAutomation as well), takes its complete tree mode
 * (a service asking for the whole mask counts as a complex one) and drops its no-service
 * auto-disable timer. The app sees no touch exploration and no screen reader: the service asks
 * for neither. It lives in the instrumentation APK and runs in that package's own process, as the
 * demo fixtures do; the harness ({@code DemoHarness.holdEventsOpen}) enables it through the shell
 * setting before the app launches and puts the setting back after the recording.
 */
public final class EventsTapService extends AccessibilityService {
    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing to do: being enabled is the whole job.
    }

    @Override
    public void onInterrupt() {
    }
}
