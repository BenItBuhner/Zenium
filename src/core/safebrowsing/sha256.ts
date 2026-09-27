/**
 * The Safe Browsing tables' digest: the shared synchronous SHA-256 (`shared/sha256.ts`), which
 * the frame-owner protocol of the phone's image search shares with this seat. Re-exported here
 * so the tables' callers keep their import.
 */
export { sha256, toHex } from '../../shared/sha256'
