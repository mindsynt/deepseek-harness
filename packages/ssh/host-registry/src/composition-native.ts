/**
 * Native SSH remote-host composition: mount the SSH-native execution providers
 * into one host's isolated realm without a remote helper daemon.
 *
 * @module @deepseek-ai/dsh-ssh-host-registry/composition-native
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SftpFileSystem } from '@deepseek-ai/dsh-fs-sftp'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SshExecSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh-exec'
import { SshNativeConnection, type SshNativeConfig } from '@deepseek-ai/dsh-ssh-native'
import type { RemoteHostId } from './types.ts'

/** Resolved connection coordinates of one native-SSH host. */
export interface NativeRemoteHostSpec {
  readonly id: RemoteHostId
  /** Caller-facing label; no defaulting. */
  readonly label: string
  readonly host: string
  readonly port?: number
  readonly user: string
  readonly privateKey?: string
  readonly password?: string
  readonly identityFile?: string
  readonly knownHostsFile?: string
}

/** The execution services a native-SSH host realm provides. */
export interface NativeRemoteHostWorld {
  /** The native SSH connection. */
  readonly sshNative: SshNativeConnection
  /** The filesystem provider mounted in the realm. */
  readonly fs: FileSystem
  /** The subprocess runtime mounted in the realm. */
  readonly subprocess: SubprocessRuntime
}

/**
 * Mount the three native SSH execution providers in one host realm and resolve them from it.
 * @param realm - the isolated context of exactly one host.
 * @param spec - resolved connection coordinates of that host.
 * @returns the execution services the realm provides.
 */
export async function nativeSshComposition(realm: Context, spec: NativeRemoteHostSpec): Promise<NativeRemoteHostWorld> {
  await realm.plugin(SshNativeConnection, nativeConnectionConfig(spec))
  await realm.plugin(SftpFileSystem)
  await realm.plugin(SshExecSubprocessRuntime)
  return resolveNativeWorld(realm)
}

/**
 * Build the native SSH connection config from a host spec.
 * @param spec - resolved connection coordinates of one host.
 * @returns the native SSH connection config for that host.
 */
export function nativeConnectionConfig(spec: NativeRemoteHostSpec): SshNativeConfig {
  return {
    host: spec.host,
    ...(spec.port !== undefined ? { port: spec.port } : {}),
    username: spec.user,
    ...(spec.privateKey !== undefined ? { privateKey: spec.privateKey } : {}),
    ...(spec.password !== undefined ? { password: spec.password } : {}),
    ...(spec.identityFile !== undefined ? { identityFile: spec.identityFile } : {}),
    ...(spec.knownHostsFile !== undefined ? { knownHostsFile: spec.knownHostsFile } : {}),
  }
}

/**
 * Resolve the three execution services from one native host realm.
 * @param realm - an isolated context whose providers have finished mounting.
 * @returns the execution services the realm provides.
 * @throws when the composition left any execution service unavailable in the realm.
 */
export function resolveNativeWorld(realm: Context): NativeRemoteHostWorld {
  const sshNative = realm.get('sshNative')
  const fs = realm.get('fs')
  const subprocess = realm.get('subprocess')
  if (sshNative === undefined || fs === undefined || subprocess === undefined) {
    throw new Error('native remote host realm did not provide sshNative, fs, and subprocess')
  }
  return { sshNative, fs, subprocess }
}
