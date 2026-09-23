/**
 * Selected-host world probe: the sampling that keeps a remote browse or
 * creation entry from addressing an execution world the Host no longer holds.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteHostView, RemoteHostsListValue, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSelectedHostWorldProbe } from '../src/client/selected-host-world.ts'

/**
 * One host as the wire reports it.
 * @param id - registry identity.
 * @param open - whether the Host holds an execution world for it.
 * @returns the wire view.
 */
function view(id: string, open: boolean): RemoteHostView {
  return {
    record: {
      id,
      label: id,
      host: `${id}.example`,
      root: '/srv/dsh',
      workspace: '/srv/work',
      manifest: '/tmp/helper.json',
      helperHash: 'a'.repeat(64),
    },
    open,
  }
}

/**
 * Build the `hosts` face one probe reads.
 * @param answer - what the `list` verb settles with, or the rejection it throws.
 * @returns the face and its `list` spy.
 */
function face(answer: RemoteResult<RemoteHostsListValue> | Error) {
  const list = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  return { list, hosts: () => ({ list }) as never }
}

describe('createSelectedHostWorldProbe', () => {
  it('addresses this machine without reading the host list', async () => {
    const b = face({ ok: true, value: { items: [] } })
    const probe = createSelectedHostWorldProbe(b.hosts, () => undefined)
    await expect(probe()).resolves.toBe('addressable')
    expect(b.list).not.toHaveBeenCalled()
  })

  it('addresses the entry while the composition mounts no host namespace', async () => {
    const probe = createSelectedHostWorldProbe(() => undefined, () => 'alpha')
    await expect(probe()).resolves.toBe('addressable')
  })

  it('addresses a selected host the Host still holds a world for', async () => {
    const b = face({ ok: true, value: { items: [view('alpha', false), view('bravo', true)] } })
    const probe = createSelectedHostWorldProbe(b.hosts, () => 'bravo')
    await expect(probe()).resolves.toBe('addressable')
  })

  it('reports a selected host whose world is gone, whether it closed or left the list', async () => {
    const closed = face({ ok: true, value: { items: [view('alpha', false)] } })
    await expect(createSelectedHostWorldProbe(closed.hosts, () => 'alpha')()).resolves.toBe('disconnected')

    const absent = face({ ok: true, value: { items: [view('bravo', true)] } })
    await expect(createSelectedHostWorldProbe(absent.hosts, () => 'alpha')()).resolves.toBe('disconnected')
  })

  it('addresses the entry when the list is refused or rejected, leaving the carrier to report itself', async () => {
    const refused = face({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    await expect(createSelectedHostWorldProbe(refused.hosts, () => 'alpha')()).resolves.toBe('addressable')

    const rejected = face(new Error('socket closed'))
    await expect(createSelectedHostWorldProbe(rejected.hosts, () => 'alpha')()).resolves.toBe('addressable')
  })
})
