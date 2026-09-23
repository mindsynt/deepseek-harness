/**
 * Scripted execution world for host-addressed branch cases: a filesystem whose
 * answers come from a path map and whose chosen operations refuse, so a case can
 * drive a remote host's world — including its faults — without a connection, a
 * registry, or a second machine.
 */

import { posix } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

/** Operation one script can make refuse. */
export type ScriptedOperation = 'resolve' | 'stat' | 'readText'

/** File contents, directories, special entries, and refused operations of one scripted world. */
export interface WorldScript {
  /** File path → UTF-8 contents. */
  readonly files?: Readonly<Record<string, string>>
  /** Directory paths, beyond those implied by {@link files}. */
  readonly directories?: readonly string[]
  /** Paths that exist as neither a file nor a directory. */
  readonly special?: readonly string[]
  /** Operations that refuse when their predicate accepts the addressed path. */
  readonly faults?: Readonly<Partial<Record<ScriptedOperation, (path: string) => boolean>>>
}

/**
 * Build one remote execution world over a POSIX path map.
 * @param script - contents and refused operations this world answers with.
 * @returns a filesystem exposing the path operations the branch reader uses.
 */
export function scriptedWorld(script: WorldScript): FileSystem {
  const files = script.files ?? {}
  const directories = new Set(script.directories ?? [])
  const special = new Set(script.special ?? [])
  const filesUnder = (key: string): boolean => Object.keys(files).some(path => path.startsWith(`${key}/`))
  const refuse = (operation: ScriptedOperation, key: string): never => {
    throw new Error(`${operation} refused for "${key}"`)
  }
  return {
    resolve: async (path: string, opts?: { cwd?: string }) => {
      const key = posix.resolve(opts?.cwd ?? '/', path)
      if (script.faults?.resolve?.(key) === true) refuse('resolve', key)
      return { targetKey: key, displayPath: key }
    },
    stat: async (target: FsTarget) => {
      const key = String(target.targetKey)
      if (script.faults?.stat?.(key) === true) refuse('stat', key)
      if (special.has(key)) return { version: 'v1', type: 'other' }
      const content = files[key]
      if (content !== undefined) return { version: 'v1', type: 'file', size: content.length }
      if (directories.has(key) || filesUnder(key)) return { version: 'v1', type: 'directory' }
      return undefined
    },
    readText: async (target: FsTarget) => {
      const key = String(target.targetKey)
      if (script.faults?.readText?.(key) === true) refuse('readText', key)
      const content = files[key]
      if (content === undefined) throw new Error(`no file at "${key}"`)
      return content
    },
    processPath: (target: FsTarget) => String(target.targetKey),
  } as unknown as FileSystem
}
