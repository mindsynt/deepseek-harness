// @vitest-environment jsdom
/**
 * The optional ui-remote-hosts seam. ui-workspace browses and creates on the
 * Harness host while `ctx.remoteHostSelection` is absent, follows a provider
 * that registers after apply, and falls back to the Harness host when that
 * provider unregisters. The last case drives the assembled renderer, where a
 * required injection would have kept this plugin's fiber PENDING.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SlotTestRuntime, TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { RemoteHostSelectionState } from '@deepseek-ai/dsh-client-ui-remote-hosts/client'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)

const listing: DirectoryListing = {
  path: '/home/u',
  home: '/home/u',
  crumbs: [{ name: '/', path: '/', hidden: false }],
  entries: [{ name: 'project', path: '/home/u/project', hidden: false }],
  truncated: false,
}

type HoleName = 'sidebar.workspaces' | 'conversation.hero.workspace'

/** Declare the two holes ui-workspace registers into with one root registration. */
function declare(slots: SlotRegistry, ...names: HoleName[]): void {
  slots.register(
    { name: 'root', children: Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }])) } as never,
    () => null,
  )
}

/** Root Context with every service ui-workspace requires except `remoteHostSelection`. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const create = vi.fn(async (input: { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: input.path,
    title: 'new',
    sessionIds: [],
    createdAt: '0',
    updatedAt: '0',
  }))
  const list = vi.fn(async () => ({ ok: true as const, value: listing }))
  const directoryPicker = {
    pick: vi.fn(async () => ({ ok: true as const, value: null })),
    list,
    createDirectory: vi.fn(async () => ({ ok: true as const, value: '/home/u/new' })),
  }
  new TestRemote(ctx, { directoryPicker })
  const subscribe = () => () => {}
  ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
  ctx.provide('workspaces', {
    list: {
      getSnapshot: () => ({
        items: [], branches: {}, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      }),
      subscribe,
    },
    create,
    refreshBranches: vi.fn(async () => undefined),
    rename: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    insertBefore: vi.fn(async () => undefined),
    archiveSession: vi.fn(async () => undefined),
  } as never)
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({
        ids: [], byId: {}, current: undefined, phase: 'ready',
        subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
      }),
      subscribe,
    },
    create: vi.fn(async () => 'created' as never),
    retain: vi.fn(() => ({ sessionId: 'session', release: vi.fn() })),
    using: vi.fn(async () => ({ ok: true })),
    search: vi.fn(async () => ({ ok: true as const, value: { items: [], hasMore: false } })),
    searchResultLimit: 20,
    binding: vi.fn(),
    subagentAddress: vi.fn(() => undefined),
    refreshSubagents: vi.fn(() => Promise.resolve()),
    fork: vi.fn(async () => 'forked' as never),
  } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, create, list }
}

/** The injected faces the two registrations publish, read the way the renderer does. */
function faces(slots: SlotRegistry) {
  return {
    browser: (slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)(),
    picker: (slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)(),
  }
}

describe('ui-workspace without a remote host selection provider', () => {
  it('applies, registers both surfaces, and browses and creates on the Harness host', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    // No provider is registered for `remoteHostSelection`; a required
    // injection would keep this fiber PENDING forever.
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.workspaces')[0]!.component).toBe(WorkspaceBrowser)
    expect(b.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)

    const { browser, picker } = faces(b.slots)
    // The absent service reads as "no remote host selected".
    expect(browser.hooks.selectedHost.getSnapshot()).toEqual({})
    expect(picker.hooks.selectedHost.getSnapshot()).toEqual({})

    await expect(b.ctx.uiWorkspace.listDirectory('/home/u')).resolves.toEqual(listing)
    expect(b.list).toHaveBeenLastCalledWith('/home/u', undefined, undefined)
    await browser.createWorkspace({ path: '/home/u/project' })
    expect(b.create).toHaveBeenLastCalledWith({ path: '/home/u/project' })
    await picker.createWorkspace({ path: '/home/u/other' })
    expect(b.create).toHaveBeenLastCalledWith({ path: '/home/u/other' })
  })

  it('follows a provider registering after apply and falls back when it unregisters', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { browser, picker } = faces(b.slots)

    // Same service name and face ui-remote-hosts provides, registered later.
    const selection = createSnapshotStore<RemoteHostSelectionState>({})
    const provider = b.ctx.plugin((inner: Context) => {
      inner.provide('remoteHostSelection', { source: selection })
    })
    await provider.await()
    selection.set({ hostId: 'alpha', hostLabel: 'Alpha' })
    await Promise.resolve()

    // Both read sites and the labels the surfaces render follow the arrival.
    expect(browser.hooks.selectedHost.getSnapshot()).toEqual({ hostId: 'alpha', hostLabel: 'Alpha' })
    await b.ctx.uiWorkspace.listDirectory()
    expect(b.list).toHaveBeenLastCalledWith(undefined, 'alpha', undefined)
    await picker.createWorkspace({ path: '/srv/work' })
    expect(b.create).toHaveBeenLastCalledWith({ path: '/srv/work', hostId: 'alpha' })

    // An unrelated service registration neither rebinds nor notifies.
    const notified = vi.fn()
    const unsubscribe = browser.hooks.selectedHost.subscribe(notified)
    b.ctx.provide('unrelatedProbe', {})
    expect(notified).not.toHaveBeenCalled()

    // Unregistration (HMR, overlay change) returns the Harness host.
    await provider.dispose()
    expect(browser.hooks.selectedHost.getSnapshot()).toEqual({})
    await expect(b.ctx.uiWorkspace.listDirectory('/srv')).resolves.toEqual(listing)
    expect(b.list).toHaveBeenLastCalledWith('/srv', undefined, undefined)
    await browser.createWorkspace({ path: '/srv/local' })
    expect(b.create).toHaveBeenLastCalledWith({ path: '/srv/local' })
    unsubscribe()
    await b.ctx.fiber.dispose()
  })
})

/** Test-owned sidebar shell role: declares and renders the browsing region. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

describe('ui-workspace projection without the host selection provider', () => {
  it('mounts and renders the browsing region on the assembled renderer', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.ctx.provide('layout', { selectPanel: vi.fn() })
    runtime.releaseWorkspaceSource()
    runtime.remote.provideNamespaces({ directoryPicker: {} })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'w1' as WorkspaceId, title: 'Project', path: '/home/u/project',
        sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never
    })
    await runtime.root.declare(
      { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
      SidebarFrame as never,
    )
    // `mount` refuses a plugin whose declared injections are unsatisfied.
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    expect(await view.findByText('Project')).toBeTruthy()
    expect(view.getAllByRole('treeitem')).toHaveLength(1)
    await runtime.dispose()
  })
})
