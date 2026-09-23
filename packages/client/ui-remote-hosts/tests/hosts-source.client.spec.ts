/**
 * Remote host list service: the followed baseline and increments, the
 * generation lifecycle, every projected field, and the settled operation
 * outcomes the section renders.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  RemoteHostAddRequest, RemoteHostView, RemoteHostsFollowFrame,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  HostsStream, HostsStreamItem, HostsStreamOptions, RemoteHostsFace,
} from '../src/client/hosts-source.ts'
import { RemoteHostsSource } from '../src/client/hosts-source.ts'

/** One controllable generation: frames arrive only when the test pushes them. */
class ScriptedStream<Item> implements AsyncIterable<Item> {
  private readonly pending: Item[] = []
  private wake: (() => void) | undefined
  private finished = false
  private thrown: unknown
  private hasThrown = false
  readonly dispose = vi.fn((): Promise<void> => {
    this.finished = true
    this.wake?.()
    return Promise.resolve()
  })

  push(item: Item): void {
    this.pending.push(item)
    this.wake?.()
  }

  end(): void {
    this.finished = true
    this.wake?.()
  }

  fail(error: unknown): void {
    this.thrown = error
    this.hasThrown = true
    this.finished = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Item> {
    while (true) {
      const next = this.pending.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.hasThrown) throw this.thrown
      if (this.finished) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

/** The requested host one add call carries. */
const REQUEST: RemoteHostAddRequest = {
  id: 'alpha',
  label: 'Alpha',
  root: '/srv/dsh',
  workspace: '/srv/work',
  manifest: '/tmp/helper.json',
  login: { host: 'alpha.example', port: 22, user: 'deploy', privateKey: 'key material' },
}

/**
 * One host as the Remote reports it.
 * @param id - registry identity.
 * @param overrides - fields this case changes.
 * @returns the wire view.
 */
function view(
  id: string,
  overrides: Partial<{ label: string; host: string; workspace: string; open: boolean }> = {},
): RemoteHostView {
  return {
    record: {
      id,
      label: overrides.label ?? id,
      host: overrides.host ?? `${id}.example`,
      root: '/srv/dsh',
      workspace: overrides.workspace ?? '/srv/work',
      manifest: '/tmp/helper.json',
      helperHash: 'a'.repeat(64),
    },
    open: overrides.open ?? false,
  }
}

/** A complete opening frame. */
function baseline(items: readonly RemoteHostView[]): RemoteHostsFollowFrame {
  return { type: 'baseline', value: { items } }
}

/**
 * Build the Remote face and the generations this suite drives.
 * @returns the face plus every observable the suite asserts on.
 */
function bench() {
  const generations: ScriptedStream<RemoteHostsFollowFrame>[] = []
  const accepted: RemoteHostsFollowFrame[] = []
  const add = vi.fn()
  const remove = vi.fn()
  const testConnection = vi.fn()
  const list = vi.fn()
  const face: RemoteHostsFace = {
    hosts: {
      add,
      delete: remove,
      testConnection,
      list,
      follow: () => {
        const generation = new ScriptedStream<RemoteHostsFollowFrame>()
        generations.push(generation)
        return generation
      },
    },
    // Mimics the Gateway supervisor: one physical generation opens on demand,
    // delivers frames marked accepted, and turns a normal end into the
    // domain-classified error the source's pump reports.
    $stream: <Item>(options: HostsStreamOptions<Item>): HostsStream<Item> => {
      const generation = options.open(new AbortController().signal) as unknown as ScriptedStream<Item>
      let acceptedGeneration = false
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<HostsStreamItem<Item>> {
          for await (const value of generation) {
            yield {
              value,
              accept: () => {
                acceptedGeneration = true
                accepted.push(value as unknown as RemoteHostsFollowFrame)
              },
            }
          }
          throw options.ended(acceptedGeneration)
        },
        dispose: () => generation.dispose(),
      }
    },
  }
  return { face, generations, accepted, add, remove, testConnection, list }
}

/**
 * Wait until one list condition holds.
 * @param condition - the assertion that must pass.
 */
async function ready(condition: () => void): Promise<void> {
  await vi.waitFor(condition)
}

describe('RemoteHostsSource', () => {
  it('projects a baseline, in-place upserts, appended upserts, and removals', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    expect(b.generations).toHaveLength(1)

    const opening = baseline([view('alpha'), view('bravo', { open: true })])
    b.generations[0]!.push(opening)
    await ready(() => { expect(source.store.getSnapshot().rows).toHaveLength(2) })
    expect(source.store.getSnapshot()).toMatchObject({
      ready: true,
      rows: [
        { id: 'alpha', label: 'alpha', host: 'alpha.example', workspace: '/srv/work', open: false },
        { id: 'bravo', label: 'bravo', host: 'bravo.example', workspace: '/srv/work', open: true },
      ],
    })
    // Only the opening baseline resets the supervisor's backoff.
    expect(b.accepted).toEqual([opening])

    // An upsert of a known id replaces that row in place.
    b.generations[0]!.push({ type: 'upsert', host: view('alpha', { label: 'Renamed', open: true }) })
    await ready(() => { expect(source.store.getSnapshot().rows[0]?.label).toBe('Renamed') })
    expect(source.store.getSnapshot().rows[0]?.open).toBe(true)

    // An upsert of an unknown id joins the list at its id position: after every
    // smaller id, or before the first larger one.
    b.generations[0]!.push({ type: 'upsert', host: view('charlie') })
    await ready(() => { expect(source.store.getSnapshot().rows).toHaveLength(3) })
    b.generations[0]!.push({ type: 'upsert', host: view('aardvark') })
    await ready(() => { expect(source.store.getSnapshot().rows).toHaveLength(4) })
    expect(source.store.getSnapshot().rows.map(row => row.id))
      .toEqual(['aardvark', 'alpha', 'bravo', 'charlie'])

    b.generations[0]!.push({ type: 'remove', hostId: 'bravo' })
    await ready(() => { expect(source.store.getSnapshot().rows).toHaveLength(3) })
    expect(source.store.getSnapshot().rows.map(row => row.id)).toEqual(['aardvark', 'alpha', 'charlie'])

    source.dispose()
    expect(b.generations[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('drops a frame delivered after its generation was replaced', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    b.generations[0]!.push(baseline([]))
    await ready(() => { expect(source.store.getSnapshot().ready).toBe(true) })

    // One synchronous block: the frame is queued, then the generation it
    // belongs to is dropped before the pump resumes.
    b.generations[0]!.push(baseline([view('alpha')]))
    source.dispose()

    await Promise.resolve()
    await Promise.resolve()
    expect(source.store.getSnapshot().rows).toEqual([])
  })

  it('reports the Host-closed generation it classified as a failure', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)

    b.generations[0]!.end()
    await ready(() => { expect(source.store.getSnapshot().failure).toBe('remote host list ended') })
    // The last list stays visible; only the stream state is reported.
    expect(source.store.getSnapshot().rows).toEqual([])
    source.dispose()
  })

  it('re-samples every world state through the list verb', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    b.generations[0]!.push(baseline([view('alpha', { open: true })]))
    await ready(() => { expect(source.store.getSnapshot().rows).toHaveLength(1) })

    // The followed stream announced the world as open; the sample reports the
    // world this process no longer holds.
    b.list.mockResolvedValueOnce({
      ok: true,
      value: { items: [view('alpha'), view('bravo', { open: true })] },
    })
    await source.sampleWorlds()
    expect(source.store.getSnapshot()).toMatchObject({
      ready: true,
      rows: [
        { id: 'alpha', open: false },
        { id: 'bravo', open: true },
      ],
    })
    source.dispose()
  })

  it('keeps the published list when the sample is refused', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    b.generations[0]!.push(baseline([view('alpha', { open: true })]))
    await ready(() => { expect(source.store.getSnapshot().rows).toHaveLength(1) })

    // A carrier failure is the connection state's own fact; the last list and
    // its stream diagnostic stay as the stream published them.
    b.list.mockRejectedValueOnce(new Error('connection lost'))
    await source.sampleWorlds()
    expect(source.store.getSnapshot()).toMatchObject({
      ready: true,
      rows: [{ id: 'alpha', open: true }],
    })
    source.dispose()
  })

  it('reports a carrier failure and a non-error failure as data', async () => {
    const failing = bench()
    const source = new RemoteHostsSource(failing.face)
    failing.generations[0]!.fail(new Error('socket closed'))
    await ready(() => { expect(source.store.getSnapshot().failure).toBe('socket closed') })
    source.dispose()

    const thrown = bench()
    const other = new RemoteHostsSource(thrown.face)
    thrown.generations[0]!.fail('offline')
    await ready(() => { expect(other.store.getSnapshot().failure).toBe('offline') })
    other.dispose()
  })

  it('ignores a generation failure that arrived after the generation was dropped', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    b.generations[0]!.fail(new Error('late'))
    source.dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(source.store.getSnapshot().failure).toBeUndefined()
  })

  it('refuses a frame outside the generated union', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    b.generations[0]!.push({ type: 'bogus' } as unknown as RemoteHostsFollowFrame)
    await ready(() => {
      expect(source.store.getSnapshot().failure).toContain('unexpected remote host frame')
    })
    source.dispose()
  })

  it('reopens the follow generation on refresh', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    b.generations[0]!.push(baseline([view('alpha')]))
    await ready(() => { expect(source.store.getSnapshot().rows).toHaveLength(1) })

    source.refresh()
    await ready(() => { expect(b.generations).toHaveLength(2) })
    expect(b.generations[0]!.dispose).toHaveBeenCalledTimes(1)

    // The replacement's baseline clears the previous list and any failure.
    b.generations[1]!.push(baseline([view('bravo')]))
    await ready(() => { expect(source.store.getSnapshot().rows.map(row => row.id)).toEqual(['bravo']) })
    source.dispose()
    expect(b.generations[1]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('ignores a refresh after dispose', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)
    source.dispose()

    source.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.generations).toHaveLength(1)
    expect(b.generations[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('settles add, remove, and connection checks as outcomes', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)

    b.add.mockResolvedValueOnce({ ok: true, value: { host: { record: view('alpha').record, open: true } } })
    await expect(source.addHost(REQUEST)).resolves.toEqual({ ok: true })
    b.add.mockResolvedValueOnce({ ok: false, error: { code: 'hosts/already-exists', message: 'already registered' } })
    await expect(source.addHost(REQUEST)).resolves.toEqual({ ok: false, message: 'already registered' })

    b.remove.mockResolvedValueOnce({ ok: true, value: { removed: true } })
    await expect(source.removeHost('alpha')).resolves.toEqual({ ok: true })
    b.remove.mockResolvedValueOnce({ ok: false, error: { code: 'hosts/unknown-host', message: 'unknown host' } })
    await expect(source.removeHost('alpha')).resolves.toEqual({ ok: false, message: 'unknown host' })

    b.testConnection.mockResolvedValueOnce({
      ok: true,
      value: { host: 'alpha.example', port: 22, hostKeys: ['alpha.example ssh-ed25519 AAAA'] },
    })
    await expect(source.testConnection('alpha')).resolves.toEqual({
      ok: true,
      host: 'alpha.example',
      port: 22,
      hostKeys: ['alpha.example ssh-ed25519 AAAA'],
    })
    b.testConnection.mockResolvedValueOnce({
      ok: false,
      error: { code: 'hosts/no-login-identity', message: 'no stored login' },
    })
    await expect(source.testConnection('alpha')).resolves.toEqual({ ok: false, message: 'no stored login' })

    source.dispose()
  })

  it('reports a rejected call as an outcome instead of a rejection', async () => {
    const b = bench()
    const source = new RemoteHostsSource(b.face)

    b.testConnection.mockRejectedValueOnce(new Error('connection lost'))
    await expect(source.testConnection('alpha')).resolves.toEqual({ ok: false, message: 'connection lost' })
    b.remove.mockRejectedValueOnce('connection lost')
    await expect(source.removeHost('alpha')).resolves.toEqual({ ok: false, message: 'connection lost' })

    source.dispose()
  })
})
