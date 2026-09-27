/**
 * The Shape Detection API withdrawn from an extension page's realm on the phone.
 *
 * Android WebView binds the API's detectors in the HOST app's process through the Google Play
 * services client its provider carries: `InterfaceRegistrar.bindBarcodeDetectionProvider`,
 * `bindTextDetection` and the face provider's `createFaceDetection` each ask
 * `ChromiumPlayServicesAvailability.isGooglePlayServicesAvailable(applicationContext)` before the
 * bind, and that check reads the APP's manifest for `com.google.android.gms.version` – which
 * Zenium, with no Play services dependency, does not carry. On compat round 22's snapshot WebView
 * (the 156 lane, the AOSP image) the check threw `GooglePlayServicesMissingManifestValueException`
 * on `Chrome_InProcGpuThread`, uncaught into JNI, and the app process was killed under QR Code
 * Reader's popup at `BarcodeDetector.getSupportedFormats()`; the Google WebView 113 ran the same
 * row. A page asks `'BarcodeDetector' in window` before it uses the API (the spec's and MDN's own
 * pattern; nimiq's qr-scanner runs its jsQR worker when the class is absent and constructs the
 * detector when it is there), so an extension page without the three constructors takes the path
 * it takes in every browser without Shape Detection – Firefox, Safari – where a page with them
 * dies with the app here.
 *
 * Withdrawn from every extension page but the emulated worker's: the worker page's realm shape is
 * the worker's own (a worker script constructing a detector stays a residual, named in the sweep's
 * report). A tab's web page reaching the same bind is the platform's, not this script's.
 */
export const SHAPE_DETECTION_INTERFACES = [
  'BarcodeDetector',
  'FaceDetector',
  'TextDetector'
] as const

/**
 * The API's interface objects taken off `realm`; the names of those that went, in the order
 * tried (the realm's own set – a WebView without the API contributes none). An interface object
 * is a configurable, writable data property of the global (WebIDL's interface objects), so
 * `delete` takes it off; one a realm refuses to part with stays and is not listed.
 */
export function withdrawShapeDetection(realm: object): string[] {
  const withdrawn: string[] = []
  const properties = realm as Record<string, unknown>
  for (const name of SHAPE_DETECTION_INTERFACES) {
    if (!(name in properties)) continue
    try {
      delete properties[name]
    } catch {
      // A non-configurable property throws in strict code: the interface stands, unlisted.
    }
    if (!(name in properties)) withdrawn.push(name)
  }
  return withdrawn
}
