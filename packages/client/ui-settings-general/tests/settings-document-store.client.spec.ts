import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsDocumentStore } from '../src/client/settings-document-store.ts'

/** Store over a real mirror derived from the same scripted context. */
function derivedDocumentStore(remote: object) {
  const ctx = { remote } as never
  return new SettingsDocumentStore(ctx, new SettingsDescribeMirror(ctx))
}

function response(hasDocument = false) {
  return { ok: true, value: { writable: true, hasDocument, namespaces: [] } }
}

function capable(value = true): RemoteResult<boolean> {
  return { ok: true, value }
}

function opened(): RemoteResult<{ opened: true }> {
  return { ok: true, value: { opened: true } }
}

function describeFailed(message: string) {
  return { ok: false as const, error: new RemoteError('gateway/internal', message, {}) }
}

describe('SettingsDocumentStore', () => {
  it('loads provider metadata and asks the settings domain to open its document', async () => {
    const describe = vi.fn(() => Promise.resolve(response(true)))
    const openDocument = vi.fn(() => Promise.resolve(opened()))
    const controller = derivedDocumentStore({
      settings: {
        describe,
        canOpenSettingsDocument: () => Promise.resolve(capable()),
        openSettingsDocument: openDocument,
      },
    })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({
      status: 'ready', opening: false, error: null,
    })
    await controller.open()
    expect(openDocument).toHaveBeenCalledWith()
  })

  it('marks absent or failed metadata unavailable without opening anything', async () => {
    const openDocument = vi.fn(() => Promise.resolve(opened()))
    const absent = derivedDocumentStore({
      settings: {
        describe: () => Promise.resolve(response()),
        canOpenSettingsDocument: () => Promise.resolve(capable()),
        openSettingsDocument: openDocument,
      },
    })
    await absent.load()
    await absent.open()
    expect(absent.store.getSnapshot().status).toBe('unavailable')
    expect(openDocument).not.toHaveBeenCalled()

    const failed = derivedDocumentStore({
      settings: {
        describe: () => Promise.reject(new Error('offline')),
        canOpenSettingsDocument: () => Promise.resolve(capable()),
        openSettingsDocument: openDocument,
      },
    })
    await failed.load()
    expect(failed.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: 'offline' })

    const rejected = derivedDocumentStore({
      settings: {
        describe: () => Promise.resolve(describeFailed('provider failed')),
        canOpenSettingsDocument: () => Promise.resolve(capable()),
        openSettingsDocument: openDocument,
      },
    })
    await rejected.load()
    expect(rejected.store.getSnapshot()).toMatchObject({
      status: 'unavailable', error: 'provider failed',
    })
  })

  it('removes the action when the Host cannot open the document natively', async () => {
    const openDocument = vi.fn(() => Promise.resolve(opened()))
    const controller = derivedDocumentStore({
      settings: {
        describe: () => Promise.resolve(response(true)),
        canOpenSettingsDocument: () => Promise.resolve(capable(false)),
        openSettingsDocument: openDocument,
      },
    })
    await controller.load()
    await controller.open()
    expect(controller.store.getSnapshot()).toEqual({
      status: 'unavailable', opening: false, error: null,
    })
    expect(openDocument).not.toHaveBeenCalled()
  })

  it('treats a refused or failed opener probe as unavailable without recording an error', async () => {
    const refused = derivedDocumentStore({
      settings: {
        describe: () => Promise.resolve(response(true)),
        canOpenSettingsDocument: () => Promise.resolve({
          ok: false as const, error: new RemoteError('gateway/internal', 'probe refused', {}),
        }),
        openSettingsDocument: vi.fn(),
      },
    })
    await refused.load()
    expect(refused.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: null })

    const failed = derivedDocumentStore({
      settings: {
        describe: () => Promise.resolve(response(true)),
        canOpenSettingsDocument: () => Promise.reject(new Error('offline')),
        openSettingsDocument: vi.fn(),
      },
    })
    await failed.load()
    expect(failed.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: null })
  })

  it('treats a Host that does not answer the opener probe as unavailable', async () => {
    const controller = derivedDocumentStore({
      settings: {
        describe: () => Promise.resolve(response(true)),
        openSettingsDocument: vi.fn(),
      },
    })
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: null })
  })

  it('collapses concurrent open gestures and recovers after a failure', async () => {
    let resolveOpen!: (response: RemoteResult<{ opened: true }>) => void
    const openDocument = vi.fn(() => new Promise<RemoteResult<{ opened: true }>>((resolve) => { resolveOpen = resolve }))
    const controller = derivedDocumentStore({
      settings: {
        describe: () => Promise.resolve(response(true)),
        canOpenSettingsDocument: () => Promise.resolve(capable()),
        openSettingsDocument: openDocument,
      },
    })
    await controller.load()
    const first = controller.open()
    const second = controller.open()
    expect(openDocument).toHaveBeenCalledOnce()
    resolveOpen({ ok: false, error: new RemoteError('gateway/internal', 'no default editor', {}) })
    await Promise.all([first, second])
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', opening: false, error: 'no default editor',
    })
  })

  it('recovers availability via a mirror refresh after a failed first read', async () => {
    // A first read that failed leaves the action unavailable with the miss
    // recorded; the mirror's next refresh (a commit or reconnect) recovers it.
    const ctx = {
      remote: {
        settings: {
          describe: vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(response(true)),
          canOpenSettingsDocument: vi.fn(() => Promise.resolve(capable())),
          openSettingsDocument: vi.fn(),
        },
      },
    } as never
    const mirror = new SettingsDescribeMirror(ctx)
    const caught = new SettingsDocumentStore(ctx, mirror)
    await caught.load()
    expect(caught.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: 'offline' })
    await mirror.load()
    expect(caught.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
  })
})
