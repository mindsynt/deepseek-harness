/**
 * Cordis-free storage mechanics for the local spill backend: private
 * session-scoped directory selection, safe-name derivation, path-traversal
 * protection, and the write handed to the `ctx.fs` seam.
 *
 * The default root is the one host-local decision left here (see
 * {@link privateRoot}); every artifact path is resolved and written through the
 * `FileSystem` backend that owns the execution world, so this backend is not
 * tied to the harness host filesystem.
 *
 * @module @deepseek-ai/dsh-spill-local/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** Prefix shared by default-root creation and startup discovery. */
export const DEFAULT_ROOT_PREFIX = 'dsh-spill-'

/**
 * Test a caught value for a Node system error code.
 *
 * @param error The caught value.
 * @param code The expected system error code.
 * @returns Whether the code matches.
 */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

let defaultRoot: string | undefined

/**
 * Return the lazily-created private per-process spill root.
 *
 * This is the backend's one host-local filesystem decision: the default root is
 * created with `mkdtemp` (0700) under the OS temp directory, and its path is the
 * configured root only when `Config.root` is omitted. The configuration
 * decisions stay in the service.
 *
 * @returns The private root path.
 */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), DEFAULT_ROOT_PREFIX))
  return defaultRoot
}

// Spill keeps its empty-name policy local so storage backends stay decoupled.
/* jscpd:ignore-start */
/**
 * Encode an arbitrary string as one safe path segment, injectively over ALL JS
 * (UTF-16) strings. A session id / suggested name is untrusted input, so this
 * neutralizes `../`, absolute paths, NUL, and separators before any filesystem
 * use. Each code unit is kept literal (`[A-Za-z0-9._-]`, minus `~`) or escaped
 * as `~XXXX`; `~` is itself escaped, so the mapping is reversible and distinct
 * inputs never collide. The whole-segment tokens `.`/`..` are escaped so they
 * can never traverse. An empty string encodes to `~` (never an empty segment).
 *
 * @param raw Untrusted text.
 * @returns One injective filesystem-safe path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
/* jscpd:ignore-end */

/**
 * Derive the stable session-scoped directory under a spill root.
 *
 * @param root The spill root.
 * @param sessionId The owning session id.
 * @returns The stable session-scoped directory.
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/** Inputs needed to save a spill file through a `FileSystem` backend. */
export interface SaveTextOptions {
  /** Spill root: the configured root, or the private default root. */
  root: string
  /** Owning session id. */
  sessionId: string
  /** Caller-suggested filename. */
  suggestedName: string
  /** Full text to persist. */
  content: string
}

/** A written spill file. */
export interface SavedText {
  /** Locator path: the backend's own `FsTarget.displayPath` for the saved file. */
  path: string
  /** UTF-8 content length. */
  bytes: number
}

/**
 * Write text to a fresh file below its session directory through the filesystem
 * seam. The backend's `resolve` owns the path spelling the returned locator
 * exposes, so the locator is meaningful in the backend's execution world rather
 * than assumed to be the harness host path.
 *
 * @param fs The filesystem backend that owns the execution world.
 * @param options The save request.
 * @returns The backend-resolved locator path and the UTF-8 byte length.
 * @throws Whatever the backend raises for an unresolvable path or a failed write.
 */
export async function saveTextFile(fs: FileSystem, options: SaveTextOptions): Promise<SavedText> {
  const path = join(sessionDir(options.root, options.sessionId), `${randomBytes(6).toString('hex')}-${encodeSegment(options.suggestedName)}`)
  const target = await fs.resolve(path)
  // `createIfAbsent` is the seam's exclusive-create guard: an existing entry —
  // including one a planted symlink resolves to — rejects instead of being
  // overwritten.
  await fs.writeText(target, options.content, { kind: 'createIfAbsent' })
  return { path: target.displayPath, bytes: Buffer.byteLength(options.content, 'utf8') }
}
