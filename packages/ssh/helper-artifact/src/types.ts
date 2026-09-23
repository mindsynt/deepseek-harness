/**
 * Types produced and consumed by the SSH helper artifact builder.
 *
 * @module @deepseek-ai/dsh-helper-artifact
 */

/** Where one collected closure lives and which archive path is its entry. */
export interface HelperClosure {
  /** Staging directory holding the `node_modules` tree. */
  readonly directory: string
  /** Entry path inside the archive, relative to the archive root (for example `node_modules/@deepseek-ai/dsh-ssh/lib/helper.js`). */
  readonly entry: string
  /** Number of copied files. */
  readonly files: number
}

/** One uploadable helper artifact. */
export interface HelperArtifact {
  /** gzip-compressed tar whose root holds the entry at `entry`. */
  readonly archive: Uint8Array
  /** Entry path used as the remote helper path. */
  readonly entry: string
  /** Lowercase SHA-256 of the entry file's bytes. */
  readonly digest: string
}
