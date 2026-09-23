/**
 * The default remote-host composition: mount the four SSH execution providers
 * into one host's isolated realm and resolve them back from it. The reduction
 * from a spec to an SSH connection config and the resolution of a finished
 * realm are pure functions kept here so both can be exercised directly.
 * @module @deepseek-ai/dsh-ssh-host-registry/composition
 */

import type { Context } from '@deepseek-ai/cordis'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SshConnection, type Config as SshConfig } from '@deepseek-ai/dsh-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import type { RemoteHostSpec, RemoteHostWorld } from './types.ts'

/**
 * Mount the four SSH execution providers in one host realm and resolve them from it.
 * @param realm - the isolated context of exactly one host.
 * @param spec - resolved connection and helper coordinates of that host.
 * @returns the execution services the realm provides.
 */
export async function sshComposition(realm: Context, spec: RemoteHostSpec): Promise<RemoteHostWorld> {
  await realm.plugin(SshConnection, connectionConfig(spec))
  await realm.plugin(SshFileSystem)
  await realm.plugin(SshSubprocessRuntime)
  await realm.plugin(SshSandboxProvider)
  return resolveWorld(realm)
}

/**
 * Build the connection config from a host spec, omitting coordinates the caller left unset.
 * @param spec - resolved connection and helper coordinates of one host.
 * @returns the SSH connection config for that host.
 */
export function connectionConfig(spec: RemoteHostSpec): SshConfig {
  return {
    host: spec.host,
    node: spec.node,
    helper: spec.helper,
    helperHash: spec.helperHash,
    workspace: spec.workspace,
    ...(spec.sshConfigFile === undefined ? {} : { sshConfigFile: spec.sshConfigFile }),
    ...(spec.bootstrapPath === undefined ? {} : { bootstrapPath: spec.bootstrapPath }),
    ...(spec.bootstrapHash === undefined ? {} : { bootstrapHash: spec.bootstrapHash }),
    ...(spec.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: spec.requestTimeoutMs }),
    ...(spec.maxFrameBytes === undefined ? {} : { maxFrameBytes: spec.maxFrameBytes }),
    ...(spec.maxPending === undefined ? {} : { maxPending: spec.maxPending }),
    ...(spec.leaseMs === undefined ? {} : { leaseMs: spec.leaseMs }),
  }
}

/**
 * Resolve the four execution services from one host realm.
 * @param realm - an isolated context whose providers have finished mounting.
 * @returns the execution services the realm provides.
 * @throws when the composition left any execution service unavailable in the realm.
 */
export function resolveWorld(realm: Context): RemoteHostWorld {
  const ssh = realm.get('ssh')
  const fs = realm.get('fs')
  const subprocess = realm.get('subprocess')
  const sandbox = realm.get('sandbox')
  if (ssh === undefined || fs === undefined || subprocess === undefined || sandbox === undefined) {
    throw new Error('remote host realm did not provide ssh, fs, subprocess and sandbox')
  }
  return { ssh, fs, subprocess, sandbox }
}
