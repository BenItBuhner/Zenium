package app.zen.chromium;

import android.app.admin.DeviceAdminReceiver;

/**
 * The instrumentation APK's device admin, for the managed-configuration driver (ManagedDemo)
 * alone: the shell makes the test package the device owner ({@code dpm set-device-owner}), and as
 * the owner the package hands Zenium an app-restrictions bundle through
 * {@code DevicePolicyManager.setApplicationRestrictions} – the path an EMM's device policy
 * controller takes on a managed device, so the app reads the bundle the way it would in the
 * field, through {@code RestrictionsManager}, and nothing in the app knows this class: a test-only
 * seam on the device's side, never an override in the app. The calls that must come from the
 * owner's own uid are {@link ManagedSeedReceiver}'s; this class is the admin the system binds,
 * with no policies of its own (res/xml/device_admin.xml). It runs in the test package's own
 * process, not Zenium's, so it is plain Java on framework classes only, as
 * {@link CustomTabCallerActivity} is.
 */
public class ManagedTestAdmin extends DeviceAdminReceiver {
}
