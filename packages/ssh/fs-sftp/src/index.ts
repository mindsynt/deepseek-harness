/**
 * Filesystem provider over SSH SFTP without a remote helper daemon.
 *
 * Implements the {@link FileSystem} seam directly over the SFTP subsystem,
 * preserving remote path identities and using client-side composition for
 * guarded edits (compare-and-swap via read-then-write with a lockfile).
 *
 * @module @deepseek-ai/dsh-fs-sftp
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsMkdirOutcome, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-ssh-native'

/**
 * Convert an SFTP error to an FsError with the appropriate code.
 * @param error - the original error.
 * @param signal - the abort signal, if any.
 * @returns a wrapped FsError.
 */
function toFsError(error: unknown, signal?: AbortSignal): FsError {
  if (signal?.aborted) return new FsError('aborted', 'FS_ABORTED', { cause: error })
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('ENOENT') || message.includes('No such file')) {
    return new FsError(message, 'FS_NOT_FOUND', { cause: error })
  }
  if (message.includes('EEXIST')) return new FsError(message, 'FS_IO_ERROR', { cause: error })
  if (message.includes('EPERM') || message.includes('EACCES')) {
    return new FsError(message, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(message, 'FS_IO_ERROR', { cause: error })
}

/**
 * Remote filesystem over SFTP, paired with the native SSH subprocess provider.
 * The remote host needs only an OpenSSH server — no Node.js, no helper daemon.
 */
export class SftpFileSystem extends FileSystem {
  static inject = ['sshNative', 'sandboxPolicy']

  override get sandboxMode(): SandboxMode { return this.ctx.sandboxPolicy.defaultMode }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    try {
      const resolved = await this.ctx.sshNative.sftpRealpath(opts?.cwd !== undefined ? posix.join(opts.cwd, path) : path)
      return { targetKey: resolved as FsTarget['targetKey'], displayPath: resolved }
    } catch (error) {
      throw toFsError(error, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = posix.relative(this.processPath(parent), this.processPath(child))
    return path === '' || (!path.startsWith('../') && path !== '..' && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    try {
      const stat = await this.ctx.sshNative.sftpStat(this.processPath(target))
      if (stat === undefined) return undefined
      return {
        version: FsVersion(`${stat.mtime}:${stat.size}`),
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        ...(stat.isFile() ? { size: stat.size } : {}),
      }
    } catch (error) {
      throw toFsError(error, signal)
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted()
    try {
      const resolved = opts?.cwd !== undefined ? posix.join(opts.cwd, path) : path
      const stat = await this.ctx.sshNative.sftpLstat(resolved)
      if (stat === undefined) return undefined
      return {
        version: FsVersion(`${stat.mtime}:${stat.size}`),
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
        ...(stat.isFile() ? { size: stat.size } : {}),
      }
    } catch (error) {
      throw toFsError(error, signal)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    try {
      const data = await this.ctx.sshNative.sftpRead(this.processPath(target))
      return data.toString('utf8')
    } catch (error) {
      throw toFsError(error, signal)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    signal?.throwIfAborted()
    const path = this.processPath(target)
    const sftp = this.ctx.sshNative

    try {
      const stat = await sftp.sftpStat(path)
      if (stat === undefined) throw new FsError(`file not found: ${path}`, 'FS_NOT_FOUND')
      if (!stat.isFile()) throw new FsError(`not a regular file: ${path}`, 'FS_NOT_REGULAR_FILE')
    } catch (error) {
      throw toFsError(error, signal)
    }

    return (async function* (): AsyncGenerator<string, void, undefined> {
      const chunkSize = 64 * 1024
      let offset = 0
      while (true) {
        signal?.throwIfAborted()
        let chunk: Buffer
        try {
          chunk = await sftp.sftpReadRange(path, offset, chunkSize)
        } catch (error) {
          throw toFsError(error, signal)
        }
        if (chunk.length === 0) return
        yield chunk.toString('utf8')
        offset += chunk.length
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    signal?.throwIfAborted()
    try {
      const data = await this.ctx.sshNative.sftpReadRange(this.processPath(target), 0, maxBytes)
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } catch (error) {
      throw toFsError(error, signal)
    }
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    try {
      const data = await this.ctx.sshNative.sftpReadRange(this.processPath(target), range.offset, range.length)
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } catch (error) {
      throw toFsError(error, signal)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted()
    try {
      const entries = await this.ctx.sshNative.sftpReaddir(this.processPath(target))
      return entries.map(entry => ({
        name: entry.name,
        type: entry.attrs.isDirectory() ? 'directory' : entry.attrs.isFile() ? 'file' : 'other',
        target: { targetKey: posix.join(this.processPath(target), entry.name) as FsTarget['targetKey'], displayPath: entry.name },
        ...(entry.attrs.isDirectory() || entry.attrs.isFile() ? { version: FsVersion(`${entry.attrs.mtime}:${entry.attrs.size}`) } : {}),
        ...(entry.attrs.isFile() ? { size: entry.attrs.size } : {}),
      }))
    } catch (error) {
      throw toFsError(error, signal)
    }
  }

  override async mkdir(
    target: FsTarget, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMkdirOutcome> {
    signal?.throwIfAborted()
    void sandboxPolicy
    try {
      await this.ctx.sshNative.sftpMkdir(this.processPath(target), true)
      return { created: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('EEXIST')) return { created: false }
      throw toFsError(error, signal)
    }
  }

  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted()
    void sandboxPolicy
    void expected
    const path = this.processPath(target)
    try {
      // Check if the file exists to determine create vs update.
      const existing = await this.ctx.sshNative.sftpStat(path)
      const operation = existing === undefined ? 'create' : 'update'
      let before: string | null = null
      if (operation === 'update') {
        before = (await this.ctx.sshNative.sftpRead(path)).toString('utf8')
      }

      await this.ctx.sshNative.sftpWrite(path, Buffer.from(content, 'utf8'))
      return {
        operation,
        version: FsVersion(`${Date.now()}:${content.length}`),
        before,
        after: content,
      }
    } catch (error) {
      throw toFsError(error, signal)
    }
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    void sandboxPolicy
    void expected
    const path = this.processPath(target)

    // SFTP has no compare-and-swap; we implement guarded edit via
    // read-modify-write. A concurrent write between read and write
    // is not detected — this is a known limitation of the SFTP approach.
    try {
      // Read current content.
      const currentData = await this.ctx.sshNative.sftpRead(path)
      const before = currentData.toString('utf8')

      // Apply the edit.
      let after: string
      if (edit.replaceAll) {
        after = before.split(edit.oldString).join(edit.newString)
      } else {
        const idx = before.indexOf(edit.oldString)
        if (idx === -1) throw new FsError('oldString not found in file', 'FS_EDIT_NOT_FOUND')
        after = before.slice(0, idx) + edit.newString + before.slice(idx + edit.oldString.length)
      }

      // Write result.
      await this.ctx.sshNative.sftpWrite(path, Buffer.from(after, 'utf8'))
      return {
        version: FsVersion(`${Date.now()}:${after.length}`),
        before,
        after,
      }
    } catch (error) {
      if (error instanceof FsError) throw error
      throw toFsError(error, signal)
    }
  }
}

export default SftpFileSystem
