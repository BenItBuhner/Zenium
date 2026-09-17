/** The Windows build number in an `os.release()` string such as `10.0.22631`; null elsewhere. */
export function windowsBuild(release: string): number | null {
  const m = /^10\.0\.(\d+)/.exec(release)
  return m ? Number(m[1]) : null
}

/** Mica exists from Windows 11 (build 22000); older builds silently get an opaque window. */
export function supportsWindowMaterial(platform: string, release: string): boolean {
  if (platform !== 'win32') return false
  const build = windowsBuild(release)
  return build !== null && build >= 22000
}
