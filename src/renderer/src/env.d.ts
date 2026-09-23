/// <reference types="vite/client" />

/** The build-time licences list (`scripts/licences.ts`), the Licences page's lazy import. */
declare module 'virtual:zenium-licences' {
  const entries: readonly import('@shared/licences').LicenceEntry[]
  export default entries
}
