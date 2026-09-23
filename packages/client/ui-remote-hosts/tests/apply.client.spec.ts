// @vitest-environment jsdom
/**
 * Remote hosts plugin registration: the section entry and its locale-following
 * label, the injected operation face, late declaration recovery, and disposal.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RemoteHostAddRequest, RemoteHostRecordView, RemoteHostsFollowFrame,
} from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import { RemoteHostsSection } from '../src/client/RemoteHostsSection.tsx'
import type { RemoteHostsSectionInjected } from '../src/client/RemoteHostsSection.tsx'
import type {
  HostsStream, HostsStreamItem, RemoteHostsNamespace,
} from '../src/client/hosts-source.ts'
import { apply as hostApply } from '../src/index.ts'

afterEach(cleanup)

/** The host record every fixture answer projects. */
const RECORD: RemoteHostRecordView = {
  id: 'alpha',
  label: 'Alpha',
  host: 'alpha.example',
  root: '/srv/dsh',
  workspace: '/srv/work',
  manifest: '/tmp/helper.json',
  helperHash: 'a'.repeat(64),
}

/** The entered host one add call carries. */
const REQUEST: RemoteHostAddRequest = {
  id: 'alpha',
  label: 'Alpha',
  root: '/srv/dsh',
  workspace: '/srv/work',
  manifest: '/tmp/helper.json',
  login: { host: 'alpha.example', port: 22, user: 'deploy' },
}

/** One generation that ends without frames, as a Host with no records serves it. */
async function* emptyGeneration(): AsyncGenerator<RemoteHostsFollowFrame> {}

/**
 * Boot a client root whose Remote services this plugin needs, with a stream
 * supervisor that opens and closes an empty generation.
 * @returns the booted root, its slot registry, and its locale runtime.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const hosts: RemoteHostsNamespace = {
    add: async () => ({ ok: true, value: { host: { record: RECORD, open: true } } }),
    delete: async () => ({ ok: true, value: { removed: true } }),
    testConnection: async () => ({ ok: true, value: { host: 'alpha.example', port: 22, hostKeys: [] } }),
    list: async () => ({ ok: true, value: { items: [{ record: RECORD, open: false }] } }),
    follow: () => emptyGeneration(),
  }
  ctx.provide('remote.hosts', hosts)
  const stream = <Item>(): HostsStream<Item> => ({
    async *[Symbol.asyncIterator](): AsyncIterator<HostsStreamItem<Item>> {},
    dispose: async () => {},
  })
  ctx.provide('remote', { hosts, $stream: stream })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/**
 * Register the root declaration that authorizes the `settings.section` child.
 * @param slots - the slot registry.
 * @returns the disposer of that declaration.
 */
function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-remote-hosts browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the section reads', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.hosts'])
  })

  it('registers the section after a late declaration and follows the locale', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(RemoteHostsSection)
    expect(entry.options).toMatchObject({ id: 'remote-hosts', order: 22 })
    expect(entry.locale).toBe('settings.remoteHosts')
    expect(resolveSlotLabel(entry.options.label)).toBe('Remote hosts')

    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('远程主机')

    // A declarer reload withdraws and re-adds the contribution.
    stop()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    const redeclare = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })

    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    redeclare()
    await b.ctx.fiber.dispose()
  })

  it('exposes the followed list, the host operations, and the selection through its inject face', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section')[0]!
    const injected = (entry.inject as unknown as () => RemoteHostsSectionInjected)()
    expect(injected.hooks.list.getSnapshot()).toEqual({ rows: [], ready: false })
    // The selection starts on the Harness host and is published through the
    // very source ui-workspace binds, so one write reaches every reader.
    expect(injected.hooks.selectedHost.getSnapshot()).toEqual({})
    const notified = vi.fn()
    injected.hooks.selectedHost.subscribe(notified)
    injected.selectHost({ hostId: 'alpha', hostLabel: 'Alpha' })
    expect(notified).toHaveBeenCalled()
    expect(injected.hooks.selectedHost.getSnapshot()).toEqual({ hostId: 'alpha', hostLabel: 'Alpha' })
    expect(b.ctx.remoteHostSelection.source.getSnapshot()).toEqual({ hostId: 'alpha', hostLabel: 'Alpha' })

    injected.refresh()
    // The section re-samples the live world state through the same service.
    injected.sampleWorlds()
    await vi.waitFor(() => {
      expect(injected.hooks.list.getSnapshot().rows).toEqual([
        { id: 'alpha', label: 'Alpha', host: 'alpha.example', workspace: '/srv/work', open: false },
      ])
    })
    await expect(injected.addHost(REQUEST)).resolves.toEqual({ ok: true })
    await expect(injected.removeHost('alpha')).resolves.toEqual({ ok: true })
    await expect(injected.testConnection('alpha')).resolves.toEqual({
      ok: true,
      host: 'alpha.example',
      port: 22,
      hostKeys: [],
    })

    await b.ctx.fiber.dispose()
    // The service leaves with its plugin: no workspace claims a host nobody owns.
    expect(b.ctx.get('remoteHostSelection')).toBeUndefined()
  })
})
