/**
 * Installer behavior over an injected remote-command runner: engine probing,
 * idempotent reuse, upload with digest verification, input rejection and
 * per-request isolation. No test opens a real SSH connection.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, createSshRunner, SSH_HELPER_NODE_ENGINE, SshHelperInstallerService } from '../src/index.ts'
import type { HelperInstallRequest, RemoteCommandResult, RemoteCommandRunner, RemoteCommandRunOptions, RemoteHelperArtifact } from '../src/index.ts'

/** One command the fake runner observed. */
interface CapturedCall {
  readonly host: string
  readonly command: string
  readonly options: RemoteCommandRunOptions | undefined
}

/** Fake runner recording every call and answering through one programmable responder. */
interface FakeRunner {
  readonly runner: RemoteCommandRunner
  readonly calls: CapturedCall[]
}

/**
 * Build a runner that records calls and answers the nth one with `respond`.
 * @param respond - produces the result for one observed call.
 * @returns the runner and its observed-call log.
 */
function fakeRunner(respond: (call: CapturedCall, index: number) => RemoteCommandResult): FakeRunner {
  const calls: CapturedCall[] = []
  return {
    calls,
    runner: {
      run: (host, command, options) => {
        const call: CapturedCall = { host, command, options }
        calls.push(call)
        return Promise.resolve(respond(call, calls.length - 1))
      },
    },
  }
}

/** One successful remote command result. */
function ok(stdout: string): RemoteCommandResult {
  return { code: 0, stdout, stderr: '' }
}

/** One failing remote command result. */
function failed(code: number, stderr: string): RemoteCommandResult {
  return { code, stdout: '', stderr }
}

/** Fixed artifact digest used by most cases. */
const DIGEST = 'a'.repeat(64)

/** Archive bytes the installer must forward unchanged. */
const ARCHIVE = new TextEncoder().encode('helper-archive-bytes')

/** Build one valid artifact, defaulting to the shared digest and archive. */
function artifact(overrides: Partial<RemoteHelperArtifact> = {}): RemoteHelperArtifact {
  return { archive: ARCHIVE, entry: 'helper.js', digest: DIGEST, ...overrides }
}

/** Build one install request rooted at `/opt/dsh` for host `remote-a`. */
function request(overrides: Partial<HelperInstallRequest> = {}): HelperInstallRequest {
  return { host: 'remote-a', root: '/opt/dsh', workspace: '/srv/work', artifact: artifact(), ...overrides }
}

/**
 * Build the service under a fresh context with the injected runner.
 * @param runner - runner the service must use instead of the local OpenSSH client.
 * @returns the installer service.
 */
function installer(runner: RemoteCommandRunner): SshHelperInstallerService {
  return new SshHelperInstallerService(new Context(), {}, runner)
}

describe('ssh helper installer', () => {
  it('mounts the service as ctx.sshHelperInstaller through apply', () => {
    const ctx = new Context()
    apply(ctx, {})
    expect(ctx.sshHelperInstaller).toBeInstanceOf(SshHelperInstallerService)
  })

  it('names the host and the required Node engine when node is missing', async () => {
    const fake = fakeRunner(() => failed(127, 'command not found'))
    await expect(installer(fake.runner).install(request()))
      .rejects.toThrow(/remote-a[\s\S]*cannot run the SSH helper/)
    await expect(installer(fakeRunner(() => failed(127, '')).runner).install(request()))
      .rejects.toThrow(SSH_HELPER_NODE_ENGINE)
    await expect(installer(fakeRunner(() => ok('')).runner).install(request()))
      .rejects.toThrow('remote-a')
  })

  it('rejects a Node version below the engines range', async () => {
    const fake = fakeRunner((_call, index) => index === 0 ? ok('/usr/bin/node\n') : ok('v22.18.9\n'))
    await expect(installer(fake.runner).install(request())).rejects.toThrow(SSH_HELPER_NODE_ENGINE)
    expect(fake.calls).toHaveLength(2)
  })

  it('rejects a failing version probe without reading its output', async () => {
    const fake = fakeRunner((_call, index) => index === 0 ? ok('/usr/bin/node\n') : failed(1, 'node: not found'))
    await expect(installer(fake.runner).install(request())).rejects.toThrow('node --version reported ""')
    expect(fake.calls).toHaveLength(2)
  })

  it('accepts the boundary versions of the engines range', async () => {
    for (const version of ['v22.19.0', 'v22.30.5', 'v24.0.0']) {
      const fake = fakeRunner((_call, index) => {
        if (index === 0) return ok('/usr/bin/node\n')
        if (index === 1) return ok(`${version}\n`)
        return ok(`${DIGEST}  /opt/dsh/${DIGEST}/helper.js\n`)
      })
      await expect(installer(fake.runner).install(request())).resolves.toEqual({
        node: '/usr/bin/node',
        helper: `/opt/dsh/${DIGEST}/helper.js`,
        helperHash: DIGEST,
        workspace: '/srv/work',
      })
    }
  })

  it('rejects a Node version line that is not vX.Y.Z', async () => {
    const fake = fakeRunner((_call, index) => index === 0 ? ok('/usr/bin/node\n') : ok('not a version\n'))
    await expect(installer(fake.runner).install(request())).rejects.toThrow('remote-a')
  })

  it('reuses a digest-matching install without uploading', async () => {
    const fake = fakeRunner((_call, index) => {
      if (index === 0) return ok('/usr/bin/node\n')
      if (index === 1) return ok('v22.19.0\n')
      return ok(`${DIGEST}  /opt/dsh/${DIGEST}/helper.js\n`)
    })
    const installed = await installer(fake.runner).install(request())
    expect(installed).toEqual({
      node: '/usr/bin/node',
      helper: `/opt/dsh/${DIGEST}/helper.js`,
      helperHash: DIGEST,
      workspace: '/srv/work',
    })
    expect(fake.calls).toHaveLength(3)
    expect(fake.calls.some(call => call.command.includes('tar -xzf'))).toBe(false)
    expect(fake.calls.every(call => call.options?.stdin === undefined)).toBe(true)
  })

  it('probes, checks, uploads and verifies on a first install', async () => {
    const fake = fakeRunner((_call, index) => {
      if (index === 0) return ok('/usr/bin/node\n')
      if (index === 1) return ok('v24.0.0\n')
      if (index === 2) return failed(1, '')
      if (index === 3) return ok('')
      return ok(`${DIGEST}  /opt/dsh/${DIGEST}/helper.js\n`)
    })
    const installed = await installer(fake.runner).install(request())

    expect(fake.calls.map(call => call.command)).toEqual([
      'command -v node',
      'node --version',
      `test -f '/opt/dsh/${DIGEST}/helper.js' && sha256sum '/opt/dsh/${DIGEST}/helper.js'`,
      `mkdir -p '/opt/dsh/${DIGEST}' && tar -xzf - -C '/opt/dsh/${DIGEST}'`,
      `sha256sum '/opt/dsh/${DIGEST}/helper.js'`,
    ])
    expect(Array.from(fake.calls[3]?.options?.stdin ?? [])).toEqual(Array.from(ARCHIVE))
    expect(installed.node).toBe('/usr/bin/node')
    expect(installed.helper).toBe(`/opt/dsh/${DIGEST}/helper.js`)
    expect(installed.helperHash).toBe(DIGEST)
  })

  it('forwards the request SSH client configuration to every runner call', async () => {
    const fake = fakeRunner((_call, index) => {
      if (index === 0) return ok('/usr/bin/node\n')
      if (index === 1) return ok('v24.0.0\n')
      if (index === 2) return failed(1, '')
      if (index === 3) return ok('')
      return ok(`${DIGEST}  /opt/dsh/${DIGEST}/helper.js\n`)
    })
    await installer(fake.runner).install(request({ sshConfigFile: '/state/dsh-abc/config' }))

    expect(fake.calls.every(call => call.options?.sshConfigFile === '/state/dsh-abc/config')).toBe(true)
    expect(fake.calls.map(call => call.options?.stdin === undefined)).toEqual([true, true, true, false, true])
  })

  it('passes no per-call SSH client configuration when the request omits one', async () => {
    const fake = fakeRunner((_call, index) => index === 2 ? ok(`${DIGEST}  x\n`) : ok(index === 0 ? '/usr/bin/node\n' : 'v24.0.0\n'))
    await installer(fake.runner).install(request())
    expect(fake.calls).toHaveLength(3)
    expect(fake.calls.every(call => call.options?.sshConfigFile === undefined)).toBe(true)
  })

  it('reports an unconfirmed install when the remote digest differs', async () => {
    const fake = fakeRunner((_call, index) => {
      if (index < 2) return ok(index === 0 ? '/usr/bin/node\n' : 'v24.0.0\n')
      if (index === 2) return failed(1, '')
      if (index === 3) return ok('')
      return ok(`${'b'.repeat(64)}  /opt/dsh/${DIGEST}/helper.js\n`)
    })
    await expect(installer(fake.runner).install(request())).rejects.toThrow(/unconfirmed/)
  })

  it('reports a failed upload as an unconfirmed install', async () => {
    const fake = fakeRunner((_call, index) => {
      if (index < 2) return ok(index === 0 ? '/usr/bin/node\n' : 'v24.0.0\n')
      if (index === 2) return failed(1, '')
      return failed(2, 'tar: unexpected end of file')
    })
    await expect(installer(fake.runner).install(request())).rejects.toThrow(/unconfirmed/)
    expect(fake.calls).toHaveLength(4)
  })

  it('rejects a relative node resolution', async () => {
    const fake = fakeRunner(() => ok('node\n'))
    await expect(installer(fake.runner).install(request())).rejects.toThrow(/absolute path/)
    expect(fake.calls).toHaveLength(1)
  })

  it('rejects unsafe or unusable request fields before any remote command', async () => {
    const cases: Partial<HelperInstallRequest>[] = [
      { host: 'remote\na' },
      { host: '-remote-a' },
      { root: 'opt/dsh' },
      { workspace: 'srv/work' },
      { artifact: artifact({ entry: '/helper.js' }) },
      { artifact: artifact({ entry: '' }) },
      { artifact: artifact({ digest: 'not-a-digest' }) },
    ]
    for (const fields of cases) {
      const fake = fakeRunner(() => ok(''))
      await expect(installer(fake.runner).install(request(fields))).rejects.toThrow(/ssh helper installer/)
      expect(fake.calls).toHaveLength(0)
    }
  })

  it('single-quotes remote paths and escapes an embedded quote', async () => {
    const fake = fakeRunner((_call, index) => index === 2 ? ok(`${DIGEST}  x\n`) : ok(index === 0 ? '/usr/bin/node\n' : 'v24.0.0\n'))
    await installer(fake.runner).install(request({ root: "/opt/d'sh" }))
    expect(fake.calls[2]?.command).toBe(`test -f '/opt/d'\\''sh/${DIGEST}/helper.js' && sha256sum '/opt/d'\\''sh/${DIGEST}/helper.js'`)
  })

  it('keeps concurrent requests isolated', async () => {
    const digests: Record<string, string> = { 'remote-a': 'a'.repeat(64), 'remote-b': 'b'.repeat(64) }
    const fake = fakeRunner((call) => {
      if (call.command === 'command -v node') return ok(`/usr/bin/node-${call.host}\n`)
      if (call.command === 'node --version') return ok('v24.0.0\n')
      return ok(`${digests[call.host] ?? ''}  helper\n`)
    })
    const service = installer(fake.runner)
    const [first, second] = await Promise.all([
      service.install(request({ host: 'remote-a', root: '/opt/a' })),
      service.install(request({ host: 'remote-b', root: '/opt/b', artifact: artifact({ digest: 'b'.repeat(64) }) })),
    ])
    expect(first).toEqual({ node: '/usr/bin/node-remote-a', helper: `/opt/a/${digests['remote-a']}/helper.js`, helperHash: digests['remote-a'], workspace: '/srv/work' })
    expect(second).toEqual({ node: '/usr/bin/node-remote-b', helper: `/opt/b/${digests['remote-b']}/helper.js`, helperHash: digests['remote-b'], workspace: '/srv/work' })
    for (const call of fake.calls) {
      expect(call.command).not.toContain(call.host === 'remote-a' ? '/opt/b' : '/opt/a')
    }
  })
})

describe('default ssh runner', () => {
  it('returns a non-zero result instead of rejecting when ssh cannot start', async () => {
    const runner = createSshRunner({ sshConfigFile: '/nonexistent/dsh-helper-installer.conf', installTimeoutMs: 5_000 })
    const result = await runner.run('remote-a', 'command -v node')
    expect(result.code).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('returns a non-zero result when the command deadline expires', async () => {
    const runner = createSshRunner({ installTimeoutMs: 1 })
    const result = await runner.run('unreachable.invalid', 'command -v node')
    expect(result.code).not.toBe(0)
  })
})
