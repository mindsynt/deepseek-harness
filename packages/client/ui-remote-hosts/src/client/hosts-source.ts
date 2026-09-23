/**
 * Remote-host list service for the settings section.
 *
 * It follows the Host's `hosts/follow` stream through the Gateway's
 * reconnecting stream supervisor, projects every baseline and increment into
 * one observable snapshot, and runs the add, remove, and connection-check
 * calls the section offers. The gateway owns physical retry timing: a carrier
 * loss reopens the generation inside the supervisor, so this service only
 * classifies a generation the Host closed itself.
 *
 * @module @deepseek-ai/dsh-client-ui-remote-hosts/hosts-source
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  RemoteHostAddRequest, RemoteHostAddValue, RemoteHostRemoveRequest, RemoteHostRemoveValue,
  RemoteHostTestRequest, RemoteHostTestValue, RemoteHostView, RemoteHostsFollowFrame,
  RemoteHostsListValue, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'

/** One item of a supervised stream; `accept` marks its generation as delivering. */
export interface HostsStreamItem<Item> {
  /** The decoded frame. */
  readonly value: Item
  /** Reset the supervisor's reconnect backoff for this generation. */
  accept(): void
}

/** A reconnecting single-consumer stream the Gateway Remote supervises. */
export interface HostsStream<Item> extends AsyncIterable<HostsStreamItem<Item>> {
  /**
   * Stop the stream for good.
   * @returns once the active generation and the consumer iterator are closed.
   */
  dispose(): Promise<void>
}

/** What one supervised stream generation needs from its owner. */
export interface HostsStreamOptions<Item> {
  /** Diagnostic owner name. */
  readonly name: string
  /** Open one physical generation; `signal` aborts it. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** The error a generation's normal end amounts to. */
  readonly ended: (accepted: boolean) => Error
}

/** The `hosts` Remote namespace methods this section calls, as the generated Remote declares them. */
export interface RemoteHostsNamespace {
  /** Store entered login material, install the helper, and open the host. */
  add(request: RemoteHostAddRequest): Promise<RemoteResult<RemoteHostAddValue>>
  /** Remove one host's world, record, and stored login material. */
  delete(request: RemoteHostRemoveRequest): Promise<RemoteResult<RemoteHostRemoveValue>>
  /** Check that one host's stored login still reaches its endpoint. */
  testConnection(request: RemoteHostTestRequest): Promise<RemoteResult<RemoteHostTestValue>>
  /** Read the current host list with each host's live execution-world state. */
  list(): Promise<RemoteResult<RemoteHostsListValue>>
  /** Stream one host-list baseline followed by ordered increments. */
  follow(signal?: AbortSignal): AsyncIterable<RemoteHostsFollowFrame>
}

/** The Client Remote slice this service drives. */
export interface RemoteHostsFace {
  /** The generated `hosts` namespace. */
  readonly hosts: RemoteHostsNamespace
  /**
   * Create one reconnecting stream.
   * @param options - domain-owned opener and generation-end classification.
   * @returns the supervised stream, unstarted until iterated.
   */
  $stream<Item>(options: HostsStreamOptions<Item>): HostsStream<Item>
}

/** One registered host as the section renders it. */
export interface RemoteHostRow {
  /** Registry identity. */
  id: string
  /** Caller-facing label. */
  label: string
  /** OpenSSH alias the stored login addresses. */
  host: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Whether this process currently holds an open execution world for that host. */
  open: boolean
}

/** List state the section observes. */
export interface RemoteHostsListState {
  /** Every registered host in id order. */
  rows: RemoteHostRow[]
  /** Whether a baseline has arrived for the current generation. */
  ready: boolean
  /** Diagnostic from the generation the Host closed, or from a refused stream. */
  failure?: string
}

/** What one add or remove answered. */
export type RemoteHostActionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/** What one connection check answered. */
export type RemoteHostTestOutcome =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly hostKeys: readonly string[] }
  | { readonly ok: false; readonly message: string }

/** One settled Remote call, with a refusal reported as data instead of a rejection. */
type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * Follow the host list, re-sample it on demand, and run the section's host
 * operations.
 *
 * Carrier failures inside a generation are the supervisor's to retry; every
 * Remote call is settled here, so the section never handles a rejection.
 */
export class RemoteHostsSource {
  /** Framework-observed host list the section renders. */
  readonly store: SnapshotStore<RemoteHostsListState> = createSnapshotStore<RemoteHostsListState>({
    rows: [],
    ready: false,
  })
  private stream: HostsStream<RemoteHostsFollowFrame> | undefined
  private generation = 0
  private closed = false

  /** @param face - the `hosts` namespace and stream supervisor this section drives. */
  constructor(private readonly face: RemoteHostsFace) {
    this.attach()
  }

  /** Re-read the host list by reopening the follow generation. */
  refresh(): void {
    void this.reopen()
  }

  /**
   * Re-read every host's live execution-world state and publish the fresh rows.
   *
   * The followed stream announces durable record writes only, so a world that
   * stopped after its last baseline is not pushed to this list; the section
   * samples the existing `list` verb when it opens instead of rendering a
   * stale world state. A refused sample leaves the published list and its
   * stream diagnostic untouched: the carrier failure it reports is the
   * connection state's own fact, and the follow generation still owns
   * re-reading the list.
   */
  async sampleWorlds(): Promise<void> {
    const settled = await this.settled(() => this.face.hosts.list())
    if (!settled.ok) return
    this.store.set({ rows: settled.value.items.map(toRow), ready: true })
  }

  /**
   * Add one host and open its execution world.
   * @param request - identity, remote paths, artifact manifest, and entered login.
   * @returns success, or the Host's refusal diagnostic.
   */
  async addHost(request: RemoteHostAddRequest): Promise<RemoteHostActionOutcome> {
    const settled = await this.settled(() => this.face.hosts.add(request))
    return settled.ok ? { ok: true } : settled
  }

  /**
   * Remove one host's world, record, and stored login material.
   * @param id - registry identity of the host to remove.
   * @returns success, or the Host's refusal diagnostic.
   */
  async removeHost(id: string): Promise<RemoteHostActionOutcome> {
    const settled = await this.settled(() => this.face.hosts.delete({ id }))
    return settled.ok ? { ok: true } : settled
  }

  /**
   * Check that one host's stored login still reaches its endpoint.
   * @param id - registry identity of the host to check.
   * @returns the checked endpoint and its recorded host keys, or the refusal diagnostic.
   */
  async testConnection(id: string): Promise<RemoteHostTestOutcome> {
    const settled = await this.settled(() => this.face.hosts.testConnection({ id }))
    return settled.ok
      ? { ok: true, host: settled.value.host, port: settled.value.port, hostKeys: settled.value.hostKeys }
      : settled
  }

  /** Stop following and ignore every pending frame and generation. */
  dispose(): void {
    this.closed = true
    this.generation++
    void this.stream?.dispose()
    this.stream = undefined
  }

  /** Settle one Remote call, reporting a refusal or a carrier failure as data. */
  private async settled<T>(call: () => Promise<RemoteResult<T>>): Promise<Settled<T>> {
    try {
      const response = await call()
      return response.ok ? { ok: true, value: response.value } : { ok: false, message: response.error.message }
    } catch (error) {
      return { ok: false, message: reasonOf(error) }
    }
  }

  /** Open one supervised generation of the host-list stream. */
  private attach(): void {
    const generation = ++this.generation
    const stream = this.face.$stream<RemoteHostsFollowFrame>({
      name: 'remote host list',
      open: signal => this.face.hosts.follow(signal),
      // A generation the Host closes cleanly is gone, not interrupted: carrier
      // losses reconnect inside the supervisor, so this end is terminal.
      ended: () => new Error('remote host list ended'),
    })
    this.stream = stream
    void this.pump(stream, generation)
  }

  /** Replace the current generation with a fresh baseline. */
  private async reopen(): Promise<void> {
    const previous = this.stream
    this.generation++
    this.stream = undefined
    await previous?.dispose()
    if (!this.closed) this.attach()
  }

  /** Project every frame of one generation until it ends or is replaced. */
  private async pump(stream: HostsStream<RemoteHostsFollowFrame>, generation: number): Promise<void> {
    try {
      for await (const item of stream) {
        if (generation !== this.generation) return
        this.project(item.value)
        if (item.value.type === 'baseline') item.accept()
      }
    } catch (error) {
      if (generation === this.generation) {
        this.store.set({ ...this.store.getSnapshot(), failure: reasonOf(error) })
      }
    }
  }

  /** Fold one wire frame into the published list. */
  private project(frame: RemoteHostsFollowFrame): void {
    const current = this.store.getSnapshot()
    switch (frame.type) {
      case 'baseline':
        this.store.set({ rows: frame.value.items.map(toRow), ready: true })
        return
      case 'upsert': {
        const row = toRow(frame.host)
        const known = current.rows.findIndex(existing => existing.id === row.id)
        const rows = known === -1
          ? insertById(current.rows, row)
          : current.rows.map((existing, position) => position === known ? row : existing)
        this.store.set({ ...current, rows })
        return
      }
      case 'remove':
        this.store.set({
          ...current,
          rows: current.rows.filter(existing => existing.id !== frame.hostId),
        })
        return
      default:
        assertNever(frame)
    }
  }
}

/**
 * Project one wire view into the fields the section renders.
 * @param view - one host as the Remote reported it.
 * @returns the row identity, endpoint alias, workspace, and world state.
 */
function toRow(view: RemoteHostView): RemoteHostRow {
  return {
    id: view.record.id,
    label: view.record.label,
    host: view.record.host,
    workspace: view.record.workspace,
    open: view.open,
  }
}

/**
 * Place one new host at its id position.
 *
 * The Host's baseline is already id-ordered, so an increment only has to find
 * the first row after it.
 * @param rows - the current id-ordered rows.
 * @param row - the row the increment adds.
 * @returns the rows with the new host inserted.
 */
function insertById(rows: readonly RemoteHostRow[], row: RemoteHostRow): RemoteHostRow[] {
  const after = rows.findIndex(existing => existing.id > row.id)
  if (after === -1) return [...rows, row]
  return [...rows.slice(0, after), row, ...rows.slice(after)]
}

/**
 * Describe a caught value for a diagnostic.
 * @param error - the caught value.
 * @returns the error message, or the string form of a non-error.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Refuse a frame outside the generated union.
 * @param frame - the frame no branch accepted.
 * @throws {Error} always; the wire carries a frame this build does not know.
 */
function assertNever(frame: never): never {
  throw new Error(`unexpected remote host frame: ${JSON.stringify(frame)}`)
}
