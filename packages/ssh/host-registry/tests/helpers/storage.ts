/**
 * Real storage composition for the registry tests: the storage hub, the domain
 * facility, and the storage-domain suite's shared in-memory KV backend. Tests
 * mount it before the registry so the registry's declared `storageDomain`
 * injection is satisfied and its record domain opens from validated state.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import {
  MemoryMediaPool,
  MemoryStorageBackend,
} from '../../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** The storage composition one test mounts and inspects. */
export interface StorageHarness {
  /** Shared medium pool; pass it to a later harness to simulate a restart. */
  readonly pool: MemoryMediaPool
  /** The mounted domain facility `ctx.storageDomain` names. */
  readonly facility: DomainFacility
}

/**
 * Mount the real storage stack on one context and provide `storageDomain`.
 * @param ctx - the context receiving the hub, backend and domain facility.
 * @param pool - medium shared with a later harness; a fresh pool when omitted.
 * @returns the pool and facility the test inspects.
 */
export async function mountStorage(ctx: Context, pool: MemoryMediaPool = new MemoryMediaPool()): Promise<StorageHarness> {
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return { pool, facility }
}
