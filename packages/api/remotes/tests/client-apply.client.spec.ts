/**
 * Client assembly apply over the real Gateway Client: the `hosts` Remote
 * namespace this assembly selects is mounted on a mocked Connection, every
 * generated method is callable there, `follow` opens as a stream, and a
 * contribution the Gateway refuses unwinds the namespaces mounted before it.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply as applyGateway, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import hostsRemote from '@deepseek-ai/dsh-hosts-controller/remote'
import type { RemoteHostsFollowFrame } from '@deepseek-ai/dsh-hosts-controller/types'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.ts'

/** The five endpoints the generated `hosts` contribution carries. */
const HOSTS_METHODS = ['add', 'delete', 'follow', 'list', 'testConnection'] as const

/** One complete host-list generation opening frame. */
const BASELINE: RemoteHostsFollowFrame = { type: 'baseline', value: { items: [] } }

/**
 * Boot a Client root whose `remote` service is the real Gateway Client over a
 * mocked Connection.
 * @param mock - Remote mock answering every Gateway call.
 * @returns the booted root.
 */
async function bench(mock: RemoteMock): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', {
    rpc: mock.rpc,
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  } as unknown as ConnectionHandle)
  await ctx.plugin({ inject: [...gatewayInject], apply: applyGateway })
  return ctx
}

/**
 * Read the mounted `hosts` namespace service.
 * @param ctx - booted Client root.
 * @returns the namespace service, as the Gateway installs it.
 * @throws {Error} when the assembly did not mount it.
 */
function hostsOf(ctx: Context): Record<string, unknown> {
  const hosts = ctx.get('remote.hosts') as unknown as Record<string, unknown> | undefined
  if (hosts === undefined) throw new Error('fixture: the hosts Remote namespace is not mounted')
  return hosts
}

describe('API Remotes Client apply', () => {
  it('mounts ctx.remote.hosts with the five generated methods and opens follow', async () => {
    const mock = RemoteMock.create()
    mock.remote.hosts.list.mockResolvedValue(ok({ items: [] }))
    mock.stream('hosts/follow', (_args, stream) => {
      stream.push(BASELINE)
      stream.end()
    })
    const ctx = await bench(mock)
    // The namespace exists only once this assembly mounts its contribution.
    expect(ctx.get('remote.hosts')).toBeUndefined()

    const dispose = await apply(ctx)
    const hosts = hostsOf(ctx)
    expect(hostsRemote.descriptors.map(descriptor => descriptor.method).sort())
      .toEqual([...HOSTS_METHODS].sort())
    for (const method of HOSTS_METHODS) expect(hosts[method]).toBeTypeOf('function')

    await expect(ctx.remote.hosts.list()).resolves.toEqual(ok({ items: [] }))
    const frames: RemoteHostsFollowFrame[] = []
    for await (const frame of ctx.remote.hosts.follow()) frames.push(frame)
    expect(frames).toEqual([BASELINE])
    expect(mock.log.calls('hosts/list')).toHaveLength(1)
    expect(mock.log.streams('hosts/follow')).toHaveLength(1)

    await dispose()
    expect(ctx.get('remote.hosts')).toBeUndefined()
  })

  it('unwinds every namespace mounted before a contribution the Gateway refuses', async () => {
    const ctx = await bench(RemoteMock.create())
    // A second mount of the same methods is the Gateway's refusal.
    await ctx.remote.$mount(hostsRemote)

    await expect(apply(ctx)).rejects.toThrow('already mounted')

    // The pre-existing namespace survives; the ones this apply mounted do not.
    expect(ctx.get('remote.hosts')).toBeDefined()
    expect(ctx.remote.agentPresets).toBeUndefined()
    expect(ctx.remote.officeToPdf).toBeUndefined()
  })
})
