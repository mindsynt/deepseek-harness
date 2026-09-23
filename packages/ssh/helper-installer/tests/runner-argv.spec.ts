/**
 * Default `ssh` runner over an injected child process: the exact argv, the
 * standard input it writes, and the exit result it reports for collected
 * output, a spawn error and a standard-input fault. No test starts a real `ssh`.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSshRunner } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn }))

/** One collected output stream; encoding is ignored because every write is one `data` event. */
class Output extends EventEmitter {
  setEncoding(_encoding: string): void {}
}

/** One fake `ssh` process that records the bytes written to its standard input. */
class Child extends EventEmitter {
  readonly stdout = new Output()
  readonly stderr = new Output()
  readonly stdin: EventEmitter & { end(bytes?: Uint8Array): void }
  written: Uint8Array | undefined

  constructor() {
    super()
    this.stdin = Object.assign(new EventEmitter(), {
      end: (bytes?: Uint8Array) => { this.written = bytes },
    })
  }
}

/** Every fake process the mocked `spawn` returned, in spawn order. */
const children: Child[] = []

/** Program the next spawn to return a fake process that closes successfully. */
function program(): void {
  transport.spawn.mockImplementation(() => {
    const child = new Child()
    children.push(child)
    queueMicrotask(() => { child.emit('close', 0) })
    return child
  })
}

/**
 * The argv of one spawn call.
 * @param index - position in the recorded spawn order.
 * @returns the argument vector passed to `ssh`.
 */
function argv(index: number): string[] {
  return transport.spawn.mock.calls[index]?.[1] as string[]
}

/** One fault a programmed fake process raises after the runner registered its listeners. */
interface ProgrammedFault {
  readonly stdout?: string
  readonly stderr?: string
  readonly stdinError?: Error
  readonly error?: Error
}

/**
 * Program the next spawn to return a fake process that writes its output and raises its faults.
 * A spawn error is followed by close, as Node reports a client that could not start.
 * @param fault - output chunks and the standard-input or spawn error to raise.
 * @returns the fake process the mocked spawn returned.
 */
function programFault(fault: ProgrammedFault): Child {
  const child = new Child()
  children.push(child)
  transport.spawn.mockReturnValue(child)
  queueMicrotask(() => {
    if (fault.stdout !== undefined) child.stdout.emit('data', fault.stdout)
    if (fault.stderr !== undefined) child.stderr.emit('data', fault.stderr)
    if (fault.stdinError !== undefined) child.stdin.emit('error', fault.stdinError)
    if (fault.error !== undefined) {
      child.emit('error', fault.error)
      child.emit('close', 255)
      return
    }
    child.emit('close', 0)
  })
  return child
}

afterEach(() => {
  transport.spawn.mockReset()
  children.length = 0
})

describe('default ssh runner argv', () => {
  it('puts a per-call client configuration first and overrides the plugin config', async () => {
    program()
    const runner = createSshRunner({ sshConfigFile: '/etc/dsh/plugin.conf' })
    await runner.run('remote-a', 'command -v node', { sshConfigFile: '/state/dsh-abc/config' })
    expect(transport.spawn).toHaveBeenCalledWith('ssh', [
      '-F', '/state/dsh-abc/config',
      '-T',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes', 'remote-a', 'command -v node',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
  })

  it('uses the plugin client configuration when the call names none', async () => {
    program()
    await createSshRunner({ sshConfigFile: '/etc/dsh/plugin.conf' }).run('remote-a', 'command -v node')
    expect(argv(0).slice(0, 2)).toEqual(['-F', '/etc/dsh/plugin.conf'])
  })

  it('omits -F when neither the call nor the plugin config names a file', async () => {
    program()
    await createSshRunner().run('remote-a', 'command -v node')
    expect(argv(0)).not.toContain('-F')
    expect(argv(0).slice(0, 2)).toEqual(['-T', '-o'])
  })

  it('writes the per-call standard input to the client', async () => {
    program()
    const bytes = new TextEncoder().encode('helper-archive-bytes')
    await createSshRunner().run('remote-a', 'tar -xzf -', { stdin: bytes })
    expect(Array.from(children[0]?.written ?? [])).toEqual(Array.from(bytes))
  })

  it('closes standard input with no bytes when the call supplies none', async () => {
    program()
    await createSshRunner().run('remote-a', 'command -v node')
    expect(children[0]?.written).toBeUndefined()
  })
})

describe('default ssh runner result', () => {
  it('collects standard output and standard error until the client closes', async () => {
    programFault({ stdout: 'v24.0.0\n', stderr: 'warning: something\n' })
    const result = await createSshRunner().run('remote-a', 'node --version')
    expect(result).toEqual({ code: 0, stdout: 'v24.0.0\n', stderr: 'warning: something\n' })
  })

  it('reports a client that cannot start as exit code 255 with its message before the collected error', async () => {
    const child = programFault({ error: new Error('spawn ssh ENOENT'), stderr: 'partial\n' })
    const result = await createSshRunner().run('remote-a', 'command -v node')
    expect(result).toEqual({ code: 255, stdout: '', stderr: 'spawn ssh ENOENT\npartial' })
    // Node emits close after a spawn error; the settled call must not resolve twice.
    expect(() => { child.emit('close', 255) }).not.toThrow()
  })

  it('ignores a spawn error that arrives after the client already closed', async () => {
    const child = programFault({ stdout: 'ok\n' })
    const result = await createSshRunner().run('remote-a', 'command -v node')
    expect(() => { child.emit('error', new Error('late spawn failure')) }).not.toThrow()
    expect(result).toEqual({ code: 0, stdout: 'ok\n', stderr: '' })
  })

  it('ignores the broken pipe a remote command leaves behind', async () => {
    programFault({ stdinError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) })
    const result = await createSshRunner().run('remote-a', 'tar -xzf -', { stdin: new TextEncoder().encode('archive') })
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('records any other standard-input fault in the diagnostics', async () => {
    programFault({ stdinError: Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' }) })
    const result = await createSshRunner().run('remote-a', 'tar -xzf -', { stdin: new TextEncoder().encode('archive') })
    expect(result).toEqual({ code: 0, stdout: '', stderr: 'write ECONNRESET' })
  })
})
