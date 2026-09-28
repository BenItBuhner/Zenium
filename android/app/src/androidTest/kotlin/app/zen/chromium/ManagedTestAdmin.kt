package app.zen.chromium

import android.app.admin.DeviceAdminReceiver

/**
 * The instrumentation APK's device admin, for the managed-configuration driver ([ManagedDemo])
 * alone: the shell makes the test package the device owner (`dpm set-device-owner`), and as the
 * owner the driver hands Zenium an app-restrictions bundle through
 * `DevicePolicyManager.setApplicationRestrictions` – the path an EMM's device policy controller
 * takes on a managed device, so the app reads the bundle the way it would in the field, through
 * `RestrictionsManager`, and nothing in the app knows this class: a test-only seam on the
 * device's side, never an override in the app. Declared in the test manifest under
 * BIND_DEVICE_ADMIN with an empty policy list (res/xml/device_admin.xml); the driver clears the
 * bundle and gives the ownership back when it is done.
 */
class ManagedTestAdmin : DeviceAdminReceiver()
