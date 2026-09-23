/**
 * `ssh-keyscan` runner behavior over an injected child process: the exact argv,
 * the collected key lines, and the loud failures for a non-zero exit, a spawn
 * error and a deadline. No test starts a real scan.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSshKeyscanRunner } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn }))

/** One collected output stream, delivering each write as one `data` event. */
class Output extends EventEmitter {
  setEncoding(_encoding: string): void {}
  write(text: string): void {
    if (text.length > 0) this.emit('data', text)
  }
}

/** One fake `ssh-keyscan` process. */
class Child extends EventEmitter {
  readonly stdout = new Output()
  readonly stderr = new Output()
  readonly signals: string[] = []
  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    queueMicrotask(() => { this.emit('close', null) })
    return true
  }
}

/** One programmed fake-process behaviour: its output, exit, spawn error or the choice to stay open. */
interface ProgramBehaviour {
  readonly code?: number | null
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: Error
  readonly hold?: boolean
}

/**
 * Program one fake process to write its output and then close, fail or stay open.
 * @param behaviour - output, exit code, spawn error or the choice to stay open.
 * @returns the fake process the mocked spawn returns.
 */
function program(behaviour: ProgramBehaviour): Child {
  const child = new Child()
  transport.spawn.mockReturnValue(child)
  queueMicrotask(() => {
    child.stdout.write(behaviour.stdout ?? '')
    child.stderr.write(behaviour.stderr ?? '')
    if (behaviour.error !== undefined) {
      child.emit('error', behaviour.error)
      child.emit('close', 255)
      return
    }
    if (behaviour.hold !== true) queueMicrotask(() => { child.emit('close', behaviour.code === undefined ? 0 : behaviour.code) })
  })
  return child
}

/** One endpoint every case scans. */
const endpoint = { host: 'example.com', port: 22 } as const

afterEach(() => { transport.spawn.mockReset() })

describe('ssh-keyscan runner', () => {
  it('scans with the default deadline when the config omits one', async () => {
    program({ stdout: 'example.com ssh-ed25519 KEY\n' })
    const scan = createSshKeyscanRunner({ stateDir: '/tmp/dsh-keyscan' })
    expect(await scan.scan(endpoint)).toEqual(['example.com ssh-ed25519 KEY', ''])
    expect(transport.spawn).toHaveBeenCalledWith('ssh-keyscan', [
      '-p', '22', '-T', '10', '-t', 'rsa,ecdsa,ed25519', 'example.com',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
  })

  it('rounds a configured deadline up to whole seconds and passes the port', async () => {
    program({ stdout: 'example.com ssh-rsa KEY' })
    const scan = createSshKeyscanRunner({ stateDir: '/tmp/dsh-keyscan', scanTimeoutMs: 2500 })
    expect(await scan.scan({ host: 'example.com', port: 2222 })).toEqual(['example.com ssh-rsa KEY'])
    expect(transport.spawn).toHaveBeenCalledWith('ssh-keyscan', [
      '-p', '2222', '-T', '3', '-t', 'rsa,ecdsa,ed25519', 'example.com',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
  })

  it('rejects a non-zero exit with the endpoint and a bounded stderr fragment', async () => {
    program({ code: 1, stderr: `${'x'.repeat(300)}\n` })
    const scan = createSshKeyscanRunner({ stateDir: '/tmp/dsh-keyscan' })
    const rejected = await scan.scan(endpoint).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(Error)
    const message = (rejected as Error).message
    expect(message).toBe(`ssh-host-credentials: ssh-keyscan example.com:22 exited with code 1: ${'x'.repeat(200)}`)
  })

  it('reports a process terminated by a signal with the connection-failure code', async () => {
    program({ code: null })
    const scan = createSshKeyscanRunner({ stateDir: '/tmp/dsh-keyscan' })
    await expect(scan.scan(endpoint)).rejects.toThrow('ssh-host-credentials: ssh-keyscan example.com:22 exited with code 255')
  })

  it('ignores a spawn error that arrives after the scan settled', async () => {
    const child = program({ stdout: 'example.com ssh-ed25519 KEY' })
    const scan = createSshKeyscanRunner({ stateDir: '/tmp/dsh-keyscan' })
    const keys = await scan.scan(endpoint)
    expect(() => { child.emit('error', new Error('late spawn failure')) }).not.toThrow()
    expect(keys).toEqual(['example.com ssh-ed25519 KEY'])
  })

  it('rejects a scan that cannot start even though the process also closes', async () => {
    program({ error: new Error('spawn ssh-keyscan ENOENT') })
    const scan = createSshKeyscanRunner({ stateDir: '/tmp/dsh-keyscan' })
    await expect(scan.scan(endpoint)).rejects.toThrow(/ssh-keyscan example\.com:22 could not start: spawn ssh-keyscan ENOENT/u)
  })

  it('terminates and rejects a scan that exceeds its deadline', async () => {
    const child = program({ hold: true, stderr: 'still connecting\n' })
    const scan = createSshKeyscanRunner({ stateDir: '/tmp/dsh-keyscan', scanTimeoutMs: 20 })
    await expect(scan.scan(endpoint)).rejects.toThrow('ssh-host-credentials: ssh-keyscan example.com:22 did not answer within 20 ms: still connecting')
    expect(child.signals).toEqual(['SIGTERM'])
  })
})
