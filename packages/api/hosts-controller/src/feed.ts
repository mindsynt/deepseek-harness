/**
 * Reconnect-safe host-list baseline and increment producer: the durable host
 * records are read from the registry, and every durable write the storage
 * domain commits is projected into one ordered increment.
 * @module @deepseek-ai/dsh-hosts-controller/feed
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import { remoteHostDomainSpec, remoteHostRecord } from '@deepseek-ai/dsh-ssh-host-registry'
import type { RemoteHostId, RemoteHostRecord } from '@deepseek-ai/dsh-ssh-host-registry'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {
  RemoteHostRecordView,
  RemoteHostsBaseline,
  RemoteHostsFollowFrame,
  RemoteHostsFollowIncrement,
  RemoteHostView,
} from './types.ts'

/**
 * The one table the remote-host domain declares. A change for any other domain
 * or table is not a host record.
 */
const HOSTS_TABLE = 'hosts'

/**
 * Project one durable record onto its wire view.
 * @param record - authoritative registry record.
 * @returns the record's fields, detached from the stored value.
 */
export function remoteHostRecordView(record: RemoteHostRecord): RemoteHostRecordView {
  return {
    id: record.id,
    label: record.label,
    host: record.host,
    root: record.root,
    workspace: record.workspace,
    manifest: record.manifest,
    helperHash: record.helperHash,
  }
}

/**
 * Project one durable record together with its live execution-world state.
 * @param ctx - Host context carrying the remote-host registry.
 * @param record - authoritative registry record.
 * @returns the host row a browser list renders.
 */
export function remoteHostView(ctx: Context, record: RemoteHostRecord): RemoteHostView {
  return {
    record: remoteHostRecordView(record),
    open: ctx.remoteHosts.get(brandString<RemoteHostId>(record.id)) !== undefined,
  }
}

/**
 * Read the complete current host list synchronously.
 * @param ctx - Host context carrying the remote-host registry.
 * @returns every persisted record in id order, each with its open state.
 */
export function remoteHostsBaseline(ctx: Context): RemoteHostsBaseline {
  return { items: ctx.remoteHosts.records().map(record => remoteHostView(ctx, record)) }
}

/**
 * Project one durable domain change into a host increment.
 *
 * The committed record value is the authoritative result of the write, so an
 * upsert never depends on a second read racing the medium; the open flag still
 * comes from the live registry.
 * @param ctx - Host context carrying the remote-host registry.
 * @param change - one committed domain change.
 * @returns the increment for a host record, or `undefined` for any other change.
 */
export function remoteHostIncrement(ctx: Context, change: DomainChanged): RemoteHostsFollowIncrement | undefined {
  if (change.domain !== remoteHostDomainSpec.name || change.table !== HOSTS_TABLE) return undefined
  if (change.operation === 'deleted') return { type: 'remove', hostId: change.key }
  return { type: 'upsert', host: remoteHostView(ctx, remoteHostRecord.parse(change.value)) }
}

/**
 * Stream one generation: the complete baseline first, then ordered increments
 * until `signal` aborts. The recording listener is installed before the
 * baseline is read, so no committed change between the two is lost; a
 * reconnecting consumer starts another generation with a replacement baseline.
 * @param ctx - Host context carrying the remote-host registry.
 * @param signal - generation cancellation; the caller aborts it to end the stream.
 * @returns the baseline followed by ordered increments.
 */
export async function* followRemoteHosts(
  ctx: Context,
  signal: AbortSignal,
): AsyncIterable<RemoteHostsFollowFrame> {
  signal.throwIfAborted()
  const frames: RemoteHostsFollowIncrement[] = []
  let wake: (() => void) | undefined
  const stop = ctx.on('domain/changed', (change) => {
    const increment = remoteHostIncrement(ctx, change)
    if (increment === undefined) return
    frames.push(increment)
    wake?.()
  })
  try {
    yield { type: 'baseline', value: remoteHostsBaseline(ctx) }
    while (!signal.aborted) {
      const frame = frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          signal.removeEventListener('abort', finish)
          wake = undefined
          resolve()
        }
        wake = finish
        signal.addEventListener('abort', finish, { once: true })
      })
    }
  } finally {
    stop()
  }
}
