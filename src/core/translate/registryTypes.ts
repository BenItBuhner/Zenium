/** One file of a model as stored in the packed registry snapshot (short keys keep the module small). */
export interface PackedFile {
  /** `model`, `lex`, `vocab`, `srcvocab`, `trgvocab` or `qualityModel`. */
  t: string
  /** Size in bytes. */
  s: number
  /** Hex SHA-256 of the file. */
  h: string
  /** CDN location relative to `REGISTRY_LOCATION_PREFIX`. */
  l: string
}

export interface PackedModel {
  /** Source language (BCP-47 primary tag, e.g. `es`, `zh-Hans`). */
  f: string
  /** Target language. */
  o: string
  /** Model version as published (e.g. `1.0`, `2.1`). */
  v: string
  x: PackedFile[]
}
