/**
 * The remote-host domain declaration: the durable record schema and the
 * `defineDomain` spec the registry opens. The zod schema validates the shipped
 * format at the durability boundary, so a record the registry never wrote —
 * or one an older deployment wrote differently — fails the open instead of
 * reaching consumers.
 * @module @deepseek-ai/dsh-ssh-host-registry/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RemoteHostId } from './types.ts'

/**
 * One persisted remote host. The login material never appears here — it stays
 * in the credentials store — so a medium copy of this record leaks no secret.
 */
export interface RemoteHostRecord {
  /** Registry identity. */
  readonly id: string
  /** Caller-facing label. */
  readonly label: string
  /** SSH host name or address. */
  readonly host: string
  /** TCP port. */
  readonly port: number
  /** Login user. */
  readonly user: string
}

/** Schema validating every stored host record at the durable boundary. */
export const remoteHostRecord: z.ZodType<RemoteHostRecord> = z.object({
  id: z.string(),
  label: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  user: z.string(),
})

/**
 * The remote-host domain spec: one `hosts` table keyed by {@link RemoteHostId}.
 * The registry opens it through `ctx.storageDomain`; the spec object is the
 * single source of the domain's identity, version, and record schema.
 */
export const remoteHostDomainSpec = defineDomain({
  name: 'ssh_hosts',
  version: 2,
  tables: { hosts: domainTable<RemoteHostId, RemoteHostRecord>(remoteHostRecord) },
})
