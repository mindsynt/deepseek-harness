/**
 * Config-driven host declaration: validates the plugin `Config` and refuses
 * every declared host. The native SSH composition installs no helper artifact,
 * so a configured entry cannot be opened; hosts are registered with their login
 * material through the hosts controller and restored from it at startup.
 * @module @deepseek-ai/dsh-ssh-host-registry/config
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SshHostCredentials } from '@deepseek-ai/dsh-host-credentials'
import type { NativeRemoteHostSpec } from './composition-native.ts'
import type { Config } from './index.ts'
import type { RemoteHostId, RemoteHostRegistry } from './types.ts'

/** One refused config declaration: the identity a refusal message names. */
export interface DeclaredRemoteHost {
  /** Registry identity, branded for {@link RemoteHostRegistry.provision}. */
  readonly id: RemoteHostId
  /** Caller-facing label; `label` when configured, else the id. */
  readonly label: string
}

/**
 * Validate the plugin config and refuse every configured host.
 *
 * The native SSH composition mounts a host's realm straight from stored login
 * material, so a `config.hosts` entry has no helper artifact to install and
 * nothing to open. Refusing at load rather than validating its helper fields
 * first keeps the error the same no matter which of those fields the entry
 * carries.
 * @param config - the plugin config.
 * @returns the empty list, when no host is configured.
 * @throws when a host entry is present, or when an entry's id is malformed.
 */
export function declaredHosts(config: Config): readonly DeclaredRemoteHost[] {
  const entries = config.hosts ?? []
  return entries.map((entry, index) => {
    const at = `hosts[${index}]`
    const id = token(entry.id, `${at}.id`)
    throw new Error(
      `${at}.id '${id}' cannot be opened from config: the native SSH composition installs no helper artifact, so config.hosts has nothing to provision. Register the host with its login material through the hosts controller instead; stored logins are restored at startup`,
    )
  })
}

/**
 * Refused in the native SSH composition: there is no artifact to read, because
 * no helper is installed.
 * @param _host - the declaration that named a manifest.
 * @returns never resolves; the promise rejects.
 * @throws always, naming the unsupported path.
 * @deprecated Helper-based provisioning is no longer supported.
 */
export async function readHelperArtifact(_host: DeclaredRemoteHost): Promise<never> {
  throw new Error('helper-based provisioning is no longer supported: the native SSH composition installs no helper artifact')
}

/**
 * Restore every persisted host, in id order.
 *
 * Each record needs its stored login material: the registry never kept the
 * login, so a record without it cannot be reopened and fails activation with
 * the id and the action that resolves it.
 * @param registry - the mounted registry each host is restored through.
 * @param credentials - the login store the records' material is read from.
 * @returns a promise settling once every persisted host is open.
 * @throws when a record has no stored login material, or when restoring it
 * fails; the message names the host id.
 */
export async function restorePersistedHosts(
  registry: RemoteHostRegistry,
  credentials: SshHostCredentials,
): Promise<void> {
  for (const record of registry.records()) {
    const id = brandString<RemoteHostId>(record.id)
    // The registry persisted no login material, so a record without stored
    // material is unrecoverable: name the id and both ways out.
    const login = await credentials.load(record.id)
    if (login === undefined) {
      throw new Error(
        `remote host '${record.id}' has a persisted record but no stored login material; store login material or remove the record`,
      )
    }
    try {
      const spec: NativeRemoteHostSpec = {
        id,
        label: record.label,
        host: record.host,
        port: record.port,
        user: record.user,
        ...(login.privateKey !== undefined ? { privateKey: login.privateKey } : {}),
      }
      await registry.open(spec)
    } catch (error) {
      throw new Error(`remote host '${record.id}' could not be restored: ${reason(error)}`, { cause: error })
    }
  }
}

/**
 * Require a non-empty registry token that names no path.
 * @param value - the configured value.
 * @param field - the field path named in the error.
 * @returns the value unchanged.
 * @throws when the value is empty or carries a path separator.
 */
function token(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty token, got ${JSON.stringify(value)}`)
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`${field} '${value}' must not contain a path separator`)
  }
  return value
}

/**
 * Describe a caught value for an error message.
 * @param error - the caught value.
 * @returns the error message, or the string form of a non-error.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
