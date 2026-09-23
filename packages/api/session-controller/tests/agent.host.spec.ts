import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SESSION_FORMAT_VERSION, SessionLogOffset, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionSubagentOwnership,
  inspectApiSession,
} from '../src/agent.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import { SessionHostStore } from '../src/session-hosts.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []

/** Session cwd roots created per test, removed after their context settles. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function harness(workspaces: readonly Workspace[] = []): Promise<{ ctx: Context; agents: ApiSessionAgentController }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  installModelSelectionProjection(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  // Real durable storage: the session-host sidecar writes and reads through it.
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-session-host-'))
  tempDirs.push(storageRoot)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('workspaceRegistry', { list: () => workspaces, get: () => undefined } as never)
  return { ctx, agents: new ApiSessionAgentController(ctx, new SessionHostStore(ctx)) }
}

function header(id: string, cwd: string | null = '/workspace'): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    ...(cwd === null ? {} : { cwd }),
  }
}

function providePersistence(ctx: Context, persistence: Record<string, unknown>): () => void {
  return ctx.provide('sessionPersistence', testSessionPersistence(ctx, persistence) as never)
}

function agent(ctx: Context, meta: SessionHeader): Agent {
  const session = ctx.sessions.create(meta.id, { meta })
  return { id: meta.id, session, status: 'idle', ctx } as Agent
}

function unpublishedAgent(ctx: Context, meta: SessionHeader): Agent {
  return {
    id: meta.id,
    session: { id: meta.id, header: meta, events: [] },
    status: 'idle',
    ctx,
  } as unknown as Agent
}

/** One directory-creation call a fake remote execution world received. */
interface RemoteMkdirCall {
  readonly target: FsTarget
  readonly policy: SandboxExecutionPolicy | undefined
}

/**
 * Fake remote-host registry serving exactly `hostId` with one world whose
 * filesystem records directory creation and answers `settle`, or succeeds.
 * @param hostId - the one host this registry serves.
 * @param calls - receives every directory-creation call.
 * @param settle - optional rejection the fake creation throws.
 * @returns the registry service value.
 */
function remoteHosts(hostId: string, calls: RemoteMkdirCall[], settle?: () => Promise<never>): never {
  return {
    get: (id: string) => {
      if (id !== hostId) return undefined
      return {
        world: {
          fs: {
            resolve: (path: string) => Promise.resolve({ targetKey: path as never, displayPath: path }),
            mkdir: (target: FsTarget, _signal?: AbortSignal, policy?: SandboxExecutionPolicy) => {
              calls.push({ target, policy })
              return settle === undefined ? Promise.resolve({ created: true }) : settle()
            },
          },
        },
      }
    },
  } as never
}

describe('ApiSession identity failures', () => {
  it('describes cwd conflicts with and without a recorded cwd', () => {
    expect(new ApiSessionCwdConflict(SessionId('missing-cwd'), '/wanted', undefined).message)
      .toContain('records no cwd')
    expect(new ApiSessionCwdConflict(SessionId('wrong-cwd'), '/wanted', '/existing').message)
      .toContain('belongs to "/existing"')
  })

  it('maps absent and cwd-less point observations to not found', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    await expect(inspectApiSession(ctx, SessionId('missing')))
      .rejects.toBeInstanceOf(ApiSessionNotFound)

    const inspect = vi.fn(() => Promise.resolve(undefined))
    const stat = vi.fn(() => Promise.resolve(undefined))
    const disposeMissing = providePersistence(ctx, {
      list: () => Promise.resolve([]),
      stat,
      inspect,
    })
    await expect(inspectApiSession(ctx, SessionId('missing'))).rejects.toBeInstanceOf(ApiSessionNotFound)
    // Absence is decided by the stat preflight; the log itself is never opened.
    expect(stat).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
    disposeMissing()

    const listed = header('cwd-less-catalog', null)
    const disposeListed = providePersistence(ctx, {
      list: () => Promise.resolve([listed]),
      inspect: () => Promise.resolve({ meta: listed, events: [] }),
    })
    await expect(inspectApiSession(ctx, listed.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
    disposeListed()

    const catalog = header('cwd-less-inspect')
    const inspected = header('cwd-less-inspect', null)
    providePersistence(ctx, {
      list: () => Promise.resolve([catalog]),
      inspect: () => Promise.resolve({ meta: inspected, events: [] }),
    })
    await expect(inspectApiSession(ctx, catalog.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
  })

  it('forwards an explicit inspection signal', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const meta = header('signalled-inspection')
    const inspect = vi.fn(() => Promise.resolve({ meta, inheritedEventCount: SessionLogOffset(0), events: [] }))
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect,
    })
    const signal = new AbortController().signal

    await expect(inspectApiSession(ctx, meta.id, signal)).resolves.toEqual({ meta, inheritedEventCount: SessionLogOffset(0), events: [] })
    expect(inspect).toHaveBeenCalledWith(meta.id, signal)
  })
})

describe('ApiSession Agent lookup and recovery', () => {
  it('resumes directly from a retained observation and rejects an invalid observed header', async () => {
    const { ctx, agents } = await harness()
    const meta = header('observed-resume')
    const resumed = unpublishedAgent(ctx, meta)
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    await expect(agents.resolveObservedAgent(observed)).resolves.toEqual({ agent: resumed })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))

    const invalid = {
      ...observed,
      header: header('observed-without-cwd', null),
    } as SessionObservation
    await expect(agents.resolveObservedAgent(invalid)).resolves.toMatchObject({
      error: { code: 'session/not-found' },
    })
  })

  it('projects live Agent contexts and maps missing cold identities through Typert lookup failures', async () => {
    const { ctx } = await harness()
    const live = agent(ctx, header('live'))
    await ctx.agents.register(live)
    providePersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    const host = ctx.typert.contexts.getHost('agent')
    if (host === undefined) throw new Error('Agent Context resolver was not registered')

    await expect(host.resolve(live.id)).resolves.toBe(live.ctx)
    await expect(host.resolve(SessionId('missing'))).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('returns raced ordinary Agents and ownership failures after resume throws', async () => {
    const ordinary = await harness()
    const ordinaryMeta = header('ordinary-race')
    providePersistence(ordinary.ctx, {
      list: () => Promise.resolve([ordinaryMeta]),
      inspect: () => Promise.resolve({ meta: ordinaryMeta, events: [] }),
    })
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'resume').mockImplementation(async () => {
      await ordinary.ctx.agents.register(winner)
      throw new Error('raced publication')
    })
    await expect(ordinary.agents.resolveAgent(ordinaryMeta.id)).resolves.toEqual({ agent: winner })

    const child = await harness()
    const childMeta = header('child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    vi.spyOn(child.ctx.agents, 'resume').mockImplementation(async () => {
      child.ctx.sessions.create(childMeta.id, {
        meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child publication')
    })
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'session/agent-busy' },
    })
  })

  it('reports not-found and ordinary resume failures without fabricating an Agent', async () => {
    const missing = await harness()
    providePersistence(missing.ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    await expect(missing.agents.resolveAgent(SessionId('missing'))).resolves.toMatchObject({
      error: { code: 'session/not-found' },
    })

    const failed = await harness()
    const meta = header('failed')
    providePersistence(failed.ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    vi.spyOn(failed.ctx.agents, 'resume').mockRejectedValue(new Error('factory unavailable'))
    await expect(failed.agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'gateway/internal', message: expect.stringContaining('factory unavailable') as string },
    })
  })

  it('identifies a held Session writer without classifying other resume failures as contention', async () => {
    const { ctx, agents } = await harness()
    const meta = header('owned-session')
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new SessionAlreadyOwnedError(meta.id))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'session/writer-held', details: { sessionId: meta.id } },
    })
    resume.mockRejectedValue(Object.assign(new Error('another module copy'), { name: 'SessionAlreadyOwnedError' }))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'session/writer-held', details: { sessionId: meta.id } },
    })
    resume.mockRejectedValue(new Error('unrelated failure'))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'gateway/internal' },
    })
  })

  it('retains resume diagnostics without a persistence service', async () => {
    const { ctx, agents } = await harness()
    const meta = header('memory-only-resume')
    ctx.sessions.create(meta.id, { meta })
    vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('factory unavailable'))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'gateway/internal', message: expect.stringContaining('factory unavailable') as string },
    })
  })

  it('requires projected observations before activation', async () => {
    const { agents } = await harness()
    const meta = header('unprojected-observation')
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    expect(() => agents.presetForObservation(observed)).toThrow(
      'Agent activation requires a projected Session observation',
    )
  })
})

describe('ApiSession model selection', () => {
  it('requires the model-selection projection', async () => {
    const { ctx, agents } = await harness()
    const live = agent(ctx, header('missing-model-projection'))
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)

    expect(() => agents.selectionFor(live)).toThrow('required modelSelection projection')
  })

  it('reads a reasoning-free request and consumes only the exact pending selection', async () => {
    const { ctx, agents } = await harness()
    const logged = agent(ctx, header('logged-model'))
    logged.session.append('request/header', {
      header: { config: { provider: 'logged-provider', model: 'logged-model' } },
      reason: 'initial',
    })
    expect(agents.selectionFor(logged).current).toEqual({
      provider: 'logged-provider',
      model: 'logged-model',
    })

    const pending = agent(ctx, header('pending-model'))
    const selection = agents.selectionFor(pending)
    agents.selectForNextRequest(pending, {
      provider: 'selected-provider',
      model: 'selected-model',
      reasoningEffort: 'high' as never,
    })
    expect(selection.current).toMatchObject({
      provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high',
    })
    expect(agents.consumeSelection(pending, 'other-provider', 'selected-model', 'high')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'other-model', 'high')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'selected-model', 'low')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'selected-model', 'high')).toBe(true)
    expect(selection.current).toEqual({ provider: 'fixture', model: 'fixture-model' })

    const untouched = agent(ctx, header('uninstalled-model'))
    expect(agents.consumeSelection(untouched, 'fixture', 'fixture-model', undefined)).toBe(false)
  })
})

describe('ApiSession create or adoption', () => {
  it('shares one in-flight creation between concurrent callers', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-concurrent-'))
    tempDirs.push(cwd)
    const meta = header('concurrent-create', cwd)
    const created = unpublishedAgent(ctx, meta)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      await gate
      return { agent: created, dispose: () => Promise.resolve() }
    })

    const first = agents.ensureSession(meta.id, cwd, false)
    const second = agents.ensureSession(meta.id, cwd, false)
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([created, created])
    expect(create).toHaveBeenCalledOnce()
  })

  it('accepts a raced ordinary creation and rejects a raced attached child', async () => {
    const ordinary = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-create-'))
    tempDirs.push(cwd)
    const ordinaryMeta = header('create-race', cwd)
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'create').mockImplementation(async () => {
      await ordinary.ctx.agents.register(winner)
      throw new Error('raced creation')
    })
    await expect(ordinary.agents.ensureSession(ordinaryMeta.id, cwd, false))
      .resolves.toBe(winner)

    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-child-'))
    tempDirs.push(childCwd)
    const childId = SessionId('create-child-race')
    vi.spyOn(child.ctx.agents, 'create').mockImplementation(async () => {
      child.ctx.sessions.create(childId, {
        meta: { cwd: childCwd, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child creation')
    })
    await expect(child.agents.ensureSession(childId, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
  })

  it('validates ownership and cwd on the Agent returned by creation', async () => {
    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-returned-child-'))
    tempDirs.push(childCwd)
    const childMeta = {
      ...header('returned-child', childCwd),
      parentSession: SessionId('parent'),
      origin: 'subagent' as const,
    }
    const childAgent = unpublishedAgent(child.ctx, childMeta)
    vi.spyOn(child.ctx.agents, 'create').mockResolvedValue({
      agent: childAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(child.agents.ensureSession(childMeta.id, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)

    const wrong = await harness()
    const requestedCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-wrong-cwd-'))
    tempDirs.push(requestedCwd)
    const wrongAgent = unpublishedAgent(wrong.ctx, header('wrong-returned-cwd', '/other'))
    vi.spyOn(wrong.ctx.agents, 'create').mockResolvedValue({
      agent: wrongAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(wrong.agents.ensureSession(wrongAgent.id, requestedCwd, false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('resumes a matching persisted identity and preserves its selected preset', async () => {
    const { ctx, agents } = await harness()
    const meta = { ...header('stored'), agentPreset: 'minimal' }
    const events = [{
      type: 'agent-preset/selected',
      seq: 0,
      time: 1,
      data: { agentPreset: 'minimal' },
    }] as SessionEvent[]
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
    })
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'minimal' }),
      mount: () => Promise.resolve(),
    } as never)
    const resumed = {
      id: meta.id,
      session: {
        id: meta.id,
        header: meta,
        snapshotEvents: () => events,
        eventAt: (seq: number) => events[seq],
        seq: events.length,
      },
      status: 'idle',
      ctx,
    } as unknown as Agent
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })

    await expect(agents.ensureSession(meta.id, '/workspace', true, 'minimal')).resolves.toBe(resumed)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))
  })

  it('rejects an ownership race before resume and a persisted cwd conflict', async () => {
    const child = await harness()
    const childMeta = header('resume-child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    child.ctx.provide('agentPresets', {
      resolve: () => {
        child.ctx.sessions.create(childMeta.id, {
          meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
        })
        return Promise.resolve({ id: 'standard' })
      },
      mount: () => Promise.resolve(),
    } as never)
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'session/agent-busy' },
    })

    const conflict = await harness()
    const stored = header('stored-cwd-conflict', '/stored')
    providePersistence(conflict.ctx, {
      list: () => Promise.resolve([stored]),
      inspect: () => Promise.resolve({ meta: stored, events: [] }),
    })
    await expect(conflict.agents.ensureSession(stored.id, '/requested', true))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('surfaces directory creation failure', async () => {
    const { agents } = await harness()
    const parent = mkdtempSync(join(tmpdir(), 'dsh-session-controller-file-'))
    tempDirs.push(parent)
    const file = join(parent, 'file')
    writeFileSync(file, 'not a directory')
    await expect(agents.ensureSession(SessionId('mkdir-failure'), join(file, 'child'), false))
      .rejects.toThrow('failed to ensure project directory')
  })
})

describe('ApiSession Workspace-host directory creation', () => {
  it('creates the cwd on the Harness host for an unnamed or built-in Workspace host', async () => {
    const { ctx, agents } = await harness()
    const root = mkdtempSync(join(tmpdir(), 'dsh-session-controller-local-cwd-'))
    tempDirs.push(root)

    const unnamedCwd = join(root, 'unnamed', 'project')
    const unnamed = unpublishedAgent(ctx, header('unnamed-cwd', unnamedCwd))
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: unnamed, dispose: () => Promise.resolve() })
    await expect(agents.ensureSession(unnamed.id, unnamedCwd, false)).resolves.toBe(unnamed)
    expect(existsSync(unnamedCwd)).toBe(true)
    // A bare cwd, and the built-in identity, record the local host.
    await expect(agents.resolvedHostOf(unnamed.id)).resolves.toBe('local')

    // The built-in identity must not need the remote-host registry at all.
    const localCwd = join(root, 'local', 'project')
    const local = unpublishedAgent(ctx, header('local-host-cwd', localCwd))
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: local, dispose: () => Promise.resolve() })
    await expect(agents.ensureSession(local.id, localCwd, false, undefined, 'local')).resolves.toBe(local)
    expect(existsSync(localCwd)).toBe(true)
    await expect(agents.resolvedHostOf(local.id)).resolves.toBe('local')
  })

  it('creates a remote Workspace cwd through that host filesystem under the provisioning policy', async () => {
    const { ctx, agents } = await harness()
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: '/deployment-root' })
    const calls: RemoteMkdirCall[] = []
    ctx.provide('remoteHosts', remoteHosts('remote-1', calls))
    const cwd = `/dsh-remote-world-${randomUUID()}`
    const created = unpublishedAgent(ctx, header('remote-cwd', cwd))
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: created, dispose: () => Promise.resolve() })

    await expect(agents.ensureSession(created.id, cwd, false, undefined, 'remote-1')).resolves.toBe(created)
    // A read-only deployment default still provisions the Session's own root,
    // under workspace-write bounded to that root and to nothing wider.
    expect(calls).toEqual([{
      target: { targetKey: cwd, displayPath: cwd },
      policy: { mode: 'workspace-write', workspaceRoot: cwd },
    }])
    expect(existsSync(cwd)).toBe(false)
    // The creating operation records the host that owns the Session cwd.
    await expect(agents.resolvedHostOf(created.id)).resolves.toBe('remote-1')
  })

  it('passes no policy when the composition has no sandbox-policy owner', async () => {
    const { ctx, agents } = await harness()
    const calls: RemoteMkdirCall[] = []
    ctx.provide('remoteHosts', remoteHosts('remote-1', calls))
    const cwd = `/dsh-remote-no-policy-${randomUUID()}`
    const created = unpublishedAgent(ctx, header('remote-no-policy', cwd))
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: created, dispose: () => Promise.resolve() })

    await expect(agents.ensureSession(created.id, cwd, false, undefined, 'remote-1')).resolves.toBe(created)
    expect(calls).toEqual([{ target: { targetKey: cwd, displayPath: cwd }, policy: undefined }])
  })

  it('fails loud when a named Workspace host has no open execution world', async () => {
    const absent = await harness()
    const absentCwd = `/dsh-remote-absent-${randomUUID()}`
    const absentAgent = unpublishedAgent(absent.ctx, header('remote-absent', absentCwd))
    vi.spyOn(absent.ctx.agents, 'create').mockResolvedValue({ agent: absentAgent, dispose: () => Promise.resolve() })
    await expect(absent.agents.ensureSession(absentAgent.id, absentCwd, false, undefined, 'remote-1'))
      .rejects.toThrow('host "remote-1" has no open execution world')
    expect(existsSync(absentCwd)).toBe(false)

    const unopened = await harness()
    unopened.ctx.provide('remoteHosts', remoteHosts('other-host', []))
    const unopenedCwd = `/dsh-remote-unopened-${randomUUID()}`
    const unopenedAgent = unpublishedAgent(unopened.ctx, header('remote-unopened', unopenedCwd))
    vi.spyOn(unopened.ctx.agents, 'create').mockResolvedValue({ agent: unopenedAgent, dispose: () => Promise.resolve() })
    await expect(unopened.agents.ensureSession(unopenedAgent.id, unopenedCwd, false, undefined, 'remote-1'))
      .rejects.toThrow('failed to ensure project directory')
    expect(existsSync(unopenedCwd)).toBe(false)
  })

  it('surfaces a failed remote directory creation', async () => {
    const denied = await harness()
    denied.ctx.provide('remoteHosts', remoteHosts(
      'remote-1',
      [],
      () => Promise.reject(new Error('remote permission denied')),
    ))
    const deniedCwd = `/dsh-remote-denied-${randomUUID()}`
    const deniedAgent = unpublishedAgent(denied.ctx, header('remote-denied', deniedCwd))
    vi.spyOn(denied.ctx.agents, 'create').mockResolvedValue({ agent: deniedAgent, dispose: () => Promise.resolve() })
    await expect(denied.agents.ensureSession(deniedAgent.id, deniedCwd, false, undefined, 'remote-1'))
      .rejects.toThrow(`failed to ensure project directory "${deniedCwd}": Error: remote permission denied`)
    expect(existsSync(deniedCwd)).toBe(false)
  })

  it('resolves a legacy Session through its Workspace and records that host', async () => {
    const legacy = header('legacy-session', '/srv/legacy')
    const workspace = {
      id: 'legacy-workspace',
      hostId: 'remote-7',
      sessionIds: [legacy.id],
    } as unknown as Workspace
    const { ctx, agents } = await harness([workspace])
    providePersistence(ctx, {
      list: () => Promise.resolve([legacy]),
      inspect: () => Promise.resolve({ meta: legacy, events: [] }),
    })
    const resumed = unpublishedAgent(ctx, header('legacy-session', '/srv/legacy'))
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({ agent: resumed, dispose: () => Promise.resolve() })

    await expect(agents.ensureSession(legacy.id, '/srv/legacy', true)).resolves.toBe(resumed)
    // No sidecar record existed, so the Workspace accounting answered and the
    // resume backfilled the record with that host.
    await expect(agents.resolvedHostOf(legacy.id)).resolves.toBe('remote-7')
  })
})
