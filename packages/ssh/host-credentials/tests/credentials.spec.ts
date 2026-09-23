/**
 * The host-credentials store owns two behaviors: it materializes a
 * DSH-controlled OpenSSH identity from one login's fields, and it keeps that
 * login in the credential seam so later sessions reuse it without prompting.
 * These tests drive both against a temporary state directory and an in-memory
 * record store; no test touches the network or a real host.
 */

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, apply, inject, name, SshHostCredentialsService } from '../src/index.ts'
import type { HostKeyEndpoint, HostKeyScanner, RemoteHostLogin } from '../src/index.ts'

/** Armored key text the fixtures store; its body must never appear in a diagnostic. */
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key-material\n-----END OPENSSH PRIVATE KEY-----'

/** State directories created by this spec, cleaned after every test. */
const temporaryDirectories: string[] = []

/** Minimal in-memory record store mounted as `ctx.credentials` for these tests. */
class FakeCredentials extends Service {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * @param key - the record to read.
   * @returns the stored record, or undefined.
   */
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  /**
   * @param key - the record to replace.
   * @param mutate - receives the current record and returns its replacement.
   * @returns the record after the write.
   */
  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next !== undefined) this.records.set(key, next)
    return next ?? current
  }

  /**
   * @param key - the record to remove.
   * @returns a promise settling once the record is gone.
   */
  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

/**
 * Build a scanner that answers with fixed lines and records every endpoint.
 * @param lines - lines the scanner returns for every endpoint.
 * @param endpoints - receives each scanned endpoint.
 * @returns the scanner.
 */
function fakeScanner(lines: readonly string[], endpoints: HostKeyEndpoint[] = []): HostKeyScanner {
  return {
    scan: (endpoint) => {
      endpoints.push(endpoint)
      return Promise.resolve(lines)
    },
  }
}

/** The context, service and temporary state directory one booted case owns. */
interface Booted {
  readonly ctx: Context
  readonly service: SshHostCredentialsService
  readonly stateDir: string
}

/**
 * Build one isolated context and service over a fresh temporary state directory.
 * @param scanner - host-key scanner the service must use; defaults to one publishing no key.
 * @returns the context, the service under test, and the state directory.
 */
async function boot(scanner: HostKeyScanner = fakeScanner([])): Promise<Booted> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-host-credentials-'))
  temporaryDirectories.push(stateDir)
  const ctx = new Context()
  await ctx.plugin(FakeCredentials)
  return { ctx, service: new SshHostCredentialsService(ctx, { stateDir }, scanner), stateDir }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('plugin protocol', () => {
  it('registers under its stable name and injects the credential seam', () => {
    expect(name).toBe('ssh-host-credentials')
    expect(inject).toEqual(['credentials'])
  })

  it('accepts an explicit absolute state directory and rejects an empty or relative one', () => {
    expect(Config({ stateDir: '/tmp/dsh-state' })).toEqual({ stateDir: '/tmp/dsh-state', scanTimeoutMs: 10_000 })
    expect(Config({ stateDir: '/tmp/dsh-state', scanTimeoutMs: 2500 })).toEqual({ stateDir: '/tmp/dsh-state', scanTimeoutMs: 2500 })
    expect(() => Config({ stateDir: '' })).toThrow()
    expect(() => Config({ stateDir: 'relative/state' })).toThrow()
  })

  it('leaves stateDir unset when the config declares none', () => {
    expect(Config({})).toEqual({ scanTimeoutMs: 10_000 })
    expect(Config()).toEqual({ scanTimeoutMs: 10_000 })
  })

  it('bounds the scan deadline to a positive integer within the timer ceiling', () => {
    expect(() => Config({ stateDir: '/tmp/dsh-state', scanTimeoutMs: 0 })).toThrow()
    expect(() => Config({ stateDir: '/tmp/dsh-state', scanTimeoutMs: 1.5 })).toThrow()
    expect(() => Config({ stateDir: '/tmp/dsh-state', scanTimeoutMs: 2_147_483_648 })).toThrow()
  })

  it('mounts the service as ctx.sshHostCredentials through apply', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-host-credentials-'))
    temporaryDirectories.push(stateDir)
    const ctx = new Context()
    await ctx.plugin(FakeCredentials)

    apply(ctx, { stateDir })
    expect(ctx.sshHostCredentials).toBeInstanceOf(SshHostCredentialsService)
  })
})

describe('materialize', () => {
  it('writes owner-only files and the exact controlled configuration', async () => {
    const { service } = await boot()
    const login: RemoteHostLogin = { host: 'example.com', port: 2222, user: 'deploy', privateKey: PRIVATE_KEY }
    const identity = await service.materialize(login)

    expect(identity.alias).toMatch(/^dsh-[0-9a-f]{16}$/u)
    expect((await stat(identity.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(identity.configPath)).mode & 0o777).toBe(0o600)
    expect((await stat(identity.knownHostsPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(identity.directory, 'identity'))).mode & 0o777).toBe(0o600)

    const config = await readFile(identity.configPath, 'utf8')
    expect(config).toBe([
      '# Generated by dsh-ssh-host-credentials; edit the profile instead.',
      `Host ${identity.alias}`,
      '  HostName example.com',
      '  Port 2222',
      '  User deploy',
      `  IdentityFile ${join(identity.directory, 'identity')}`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      '  ForwardAgent no',
      '  ClearAllForwardings yes',
      '  StrictHostKeyChecking accept-new',
      `  UserKnownHostsFile ${identity.knownHostsPath}`,
      '  GlobalKnownHostsFile /dev/null',
      '  ServerAliveInterval 10',
      '  ServerAliveCountMax 3',
      '',
    ].join('\n'))
    expect(config).not.toContain('secret-key-material')
    expect(await readFile(identity.knownHostsPath, 'utf8')).toBe('')
    expect(await readFile(join(identity.directory, 'identity'), 'utf8')).toBe(`${PRIVATE_KEY}\n`)
  })

  it('normalizes CRLF key endings and ends the key file with one newline', async () => {
    const { service } = await boot()
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\r\nbody\r\n-----END OPENSSH PRIVATE KEY-----'
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy', privateKey: key })
    expect(await readFile(join(identity.directory, 'identity'), 'utf8'))
      .toBe('-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----\n')
  })

  it('keeps exactly one trailing newline when the key already ends with one', async () => {
    const { service } = await boot()
    const identity = await service.materialize({
      host: 'example.com', port: 22, user: 'deploy', privateKey: `${PRIVATE_KEY}\n`,
    })
    expect(await readFile(join(identity.directory, 'identity'), 'utf8')).toBe(`${PRIVATE_KEY}\n`)
  })

  it('omits IdentityFile and writes no identity file without a private key', async () => {
    const { service } = await boot()
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'root' })
    const config = await readFile(identity.configPath, 'utf8')
    expect(config).toContain('  User root')
    expect(config).not.toContain('IdentityFile')
    await expect(stat(join(identity.directory, 'identity'))).rejects.toThrow()
  })

  it('derives one deterministic alias per login and distinct aliases otherwise', async () => {
    const { service } = await boot()
    const login: RemoteHostLogin = { host: 'example.com', port: 22, user: 'deploy' }
    const first = await service.materialize(login)
    const second = await service.materialize(login)
    expect(second.alias).toBe(first.alias)

    const other = await service.materialize({ host: 'example.com', port: 22, user: 'other' })
    const elsewhere = await service.materialize({ host: 'elsewhere.example', port: 22, user: 'deploy' })
    const otherPort = await service.materialize({ host: 'example.com', port: 2200, user: 'deploy' })
    expect(new Set([first.alias, other.alias, elsewhere.alias, otherPort.alias]).size).toBe(4)
  })

  it('replaces an existing directory so stale generated files do not survive', async () => {
    const { service } = await boot()
    const login: RemoteHostLogin = { host: 'example.com', port: 22, user: 'deploy' }
    const first = await service.materialize(login)
    await service.pinHostKey(first, 'example.com ssh-ed25519 KEY')
    expect(await readFile(first.knownHostsPath, 'utf8')).not.toBe('')

    const replacement = await service.materialize(login)
    expect(replacement.directory).toBe(first.directory)
    expect(await readFile(replacement.knownHostsPath, 'utf8')).toBe('')
  })

  it('disposes the directory and tolerates a second disposal', async () => {
    const { service } = await boot()
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await identity.dispose()
    await expect(stat(identity.directory)).rejects.toThrow()
    await expect(identity.dispose()).resolves.toBeUndefined()
  })

  it('keeps two hosts in separate directories', async () => {
    const { service } = await boot()
    const one = await service.materialize({ host: 'one.example', port: 22, user: 'deploy' })
    const two = await service.materialize({ host: 'two.example', port: 22, user: 'deploy' })
    expect(one.directory).not.toBe(two.directory)

    await one.dispose()
    await expect(stat(two.directory)).resolves.toBeDefined()
    expect(await readFile(two.configPath, 'utf8')).toContain('  HostName two.example')
  })

  it('materializes under the derived DSH home when stateDir is omitted', async () => {
    // The derived default would write into the developer's real ~/.dsh, so this
    // test points DSH_HOME at a temporary directory and restores the previous value.
    const previousDSHHome = process.env.DSH_HOME
    const home = await mkdtemp(join(tmpdir(), 'dsh-host-credentials-home-'))
    temporaryDirectories.push(home)
    process.env.DSH_HOME = home
    try {
      const ctx = new Context()
      await ctx.plugin(FakeCredentials)
      const service = new SshHostCredentialsService(ctx, {}, fakeScanner([]))
      const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })

      expect(identity.alias).toMatch(/^dsh-[0-9a-f]{16}$/u)
      expect(identity.directory).toBe(join(home, 'ssh-hosts', identity.alias))
      expect(await readFile(identity.configPath, 'utf8')).toContain('  HostName example.com')
      expect((await stat(identity.configPath)).mode & 0o777).toBe(0o600)

      await service.store('web-1', { host: 'example.com', port: 22, user: 'deploy' })
      await service.forget('web-1')
      await expect(stat(identity.directory)).rejects.toThrow()
    } finally {
      if (previousDSHHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousDSHHome
    }
  })
})

describe('pinHostKey', () => {
  it('appends one confirmed line and keeps the file at 0600', async () => {
    const { service } = await boot()
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await service.pinHostKey(identity, 'example.com ssh-ed25519 KEY-A')
    expect(await readFile(identity.knownHostsPath, 'utf8')).toBe('example.com ssh-ed25519 KEY-A\n')

    await service.pinHostKey(identity, 'example.com ssh-rsa KEY-B')
    expect(await readFile(identity.knownHostsPath, 'utf8'))
      .toBe('example.com ssh-ed25519 KEY-A\nexample.com ssh-rsa KEY-B\n')
    expect((await stat(identity.knownHostsPath)).mode & 0o777).toBe(0o600)
  })

  it('rejects an empty, multiline, NUL-bearing or single-field line', async () => {
    const { service } = await boot()
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    const invalid = [
      '',
      'example.com\nssh-ed25519 KEY',
      'example.com\u0000ssh-ed25519 KEY',
      'example.com',
    ]
    for (const line of invalid) {
      await expect(service.pinHostKey(identity, line)).rejects.toThrow(/host key line/u)
    }
    expect(await readFile(identity.knownHostsPath, 'utf8')).toBe('')
  })
})

describe('trustFirstUse', () => {
  const endpoint: HostKeyEndpoint = { host: 'example.com', port: 22 }

  it('records every scanned key and keeps known_hosts at 0600', async () => {
    const { service } = await boot(fakeScanner([
      'example.com ssh-ed25519 KEY-A\n',
      'example.com ssh-rsa KEY-B\n',
      '# scanned from the network\n',
      '\n',
    ]))
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await service.trustFirstUse(identity, endpoint)
    expect(await readFile(identity.knownHostsPath, 'utf8'))
      .toBe('example.com ssh-ed25519 KEY-A\nexample.com ssh-rsa KEY-B\n')
    expect((await stat(identity.knownHostsPath)).mode & 0o777).toBe(0o600)
  })

  it('is idempotent for one endpoint and preserves lines recorded for another', async () => {
    const { service } = await boot(fakeScanner(['example.com ssh-ed25519 KEY-A']))
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await service.trustFirstUse(identity, endpoint)
    await service.pinHostKey(identity, 'elsewhere.example ssh-ed25519 OTHER')

    await service.trustFirstUse(identity, endpoint)
    expect(await readFile(identity.knownHostsPath, 'utf8'))
      .toBe('example.com ssh-ed25519 KEY-A\nelsewhere.example ssh-ed25519 OTHER\n')
  })

  it('appends only the keys a later scan adds to an already trusted host', async () => {
    const endpoints: HostKeyEndpoint[] = []
    const lines = ['example.com ssh-ed25519 KEY-A']
    const { service } = await boot(fakeScanner(lines, endpoints))
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await service.trustFirstUse(identity, endpoint)
    lines.push('example.com ssh-rsa KEY-B')
    await service.trustFirstUse(identity, { host: 'example.com', port: 22 })
    expect(await readFile(identity.knownHostsPath, 'utf8'))
      .toBe('example.com ssh-ed25519 KEY-A\nexample.com ssh-rsa KEY-B\n')
    expect(endpoints).toEqual([endpoint, endpoint])
  })

  it('treats a missing known_hosts as empty and restores it at 0600', async () => {
    const { service } = await boot(fakeScanner(['example.com ssh-ed25519 KEY-A']))
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await rm(identity.knownHostsPath, { force: true })
    await service.trustFirstUse(identity, endpoint)
    expect(await readFile(identity.knownHostsPath, 'utf8')).toBe('example.com ssh-ed25519 KEY-A\n')
    expect((await stat(identity.knownHostsPath)).mode & 0o777).toBe(0o600)
  })

  it('propagates an unreadable known_hosts instead of treating it as empty', async () => {
    const { service } = await boot(fakeScanner(['example.com ssh-ed25519 KEY-A']))
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await rm(identity.knownHostsPath, { force: true })
    await mkdir(identity.knownHostsPath)
    const rejected = await service.trustFirstUse(identity, endpoint).catch((error: unknown) => error)
    expect((rejected as NodeJS.ErrnoException).code).toBe('EISDIR')
  })

  it('rejects a scan that publishes no key', async () => {
    for (const lines of [[], [''], ['# only a comment']]) {
      const { service } = await boot(fakeScanner(lines))
      const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
      await expect(service.trustFirstUse(identity, endpoint)).rejects.toThrow(/example\.com:22[\s\S]*published no host key/u)
      expect(await readFile(identity.knownHostsPath, 'utf8')).toBe('')
    }
  })

  it('rejects every malformed scanned line instead of dropping it', async () => {
    const malformed = [
      'example.com ssh-ed25519',
      'example.com ssh-ed25519 KEY\nssh-rsa OTHER',
      'example.com\u0000ssh-ed25519 KEY',
    ]
    for (const line of malformed) {
      const { service } = await boot(fakeScanner([line]))
      const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
      await expect(service.trustFirstUse(identity, endpoint)).rejects.toThrow(/scanned host key line for example\.com:22/u)
      expect(await readFile(identity.knownHostsPath, 'utf8')).toBe('')
    }
  })

  it('propagates a scanner failure unchanged', async () => {
    const failure = new Error('ssh-keyscan could not reach example.com')
    const { service } = await boot({ scan: () => Promise.reject(failure) })
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    await expect(service.trustFirstUse(identity, endpoint)).rejects.toBe(failure)
  })

  it('rejects a malformed endpoint by field before scanning', async () => {
    const endpoints: HostKeyEndpoint[] = []
    const { service } = await boot(fakeScanner(['example.com ssh-ed25519 KEY'], endpoints))
    const identity = await service.materialize({ host: 'example.com', port: 22, user: 'deploy' })
    const cases: readonly { readonly endpoint: HostKeyEndpoint; readonly expected: RegExp }[] = [
      { endpoint: { host: 'bad host', port: 22 }, expected: /host "bad host"/u },
      { endpoint: { host: 'example.com', port: 0 }, expected: /port 0/u },
      { endpoint: { host: 'example.com', port: 65_536 }, expected: /port 65536/u },
      { endpoint: { host: 'example.com', port: 22.5 }, expected: /port 22\.5/u },
    ]
    for (const invalid of cases) {
      await expect(service.trustFirstUse(identity, invalid.endpoint)).rejects.toThrow(invalid.expected)
    }
    expect(endpoints).toEqual([])
  })
})

describe('login validation', () => {
  it('rejects each malformed field by name and value', async () => {
    const { service } = await boot()
    const cases: readonly { readonly login: RemoteHostLogin; readonly expected: RegExp }[] = [
      { login: { host: 'bad host', port: 22, user: 'deploy' }, expected: /host "bad host"/u },
      { login: { host: 'bad\nhost', port: 22, user: 'deploy' }, expected: /host "bad\\nhost"/u },
      { login: { host: 'example.com', port: 0, user: 'deploy' }, expected: /port 0/u },
      { login: { host: 'example.com', port: 65_536, user: 'deploy' }, expected: /port 65536/u },
      { login: { host: 'example.com', port: 22, user: 'bad user' }, expected: /user "bad user"/u },
      { login: { host: 'example.com', port: 22, user: 'deploy', privateKey: '' }, expected: /privateKey must not be empty/u },
      { login: { host: 'example.com', port: 22, user: 'deploy', privateKey: 'no marker here' }, expected: /privateKey must contain/u },
      { login: { host: 'example.com', port: 22, user: 'deploy', privateKey: 'PRIVATE KEY\u0000' }, expected: /privateKey must not contain a NUL/u },
    ]
    for (const { login, expected } of cases) {
      await expect(service.materialize(login)).rejects.toThrow(expected)
    }
  })

  it('never echoes private key text in a diagnostic', async () => {
    const { service } = await boot()
    const rejected = await service
      .materialize({ host: 'example.com', port: 22, user: 'deploy', privateKey: 'not-an-armored-secret-material' })
      .catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).not.toContain('not-an-armored-secret-material')
  })
})

describe('store, load and forget', () => {
  it('round-trips login material with and without a private key', async () => {
    const { service } = await boot()
    const withKey: RemoteHostLogin = { host: 'example.com', port: 2222, user: 'deploy', privateKey: PRIVATE_KEY }
    await service.store('web-1', withKey)
    expect(await service.load('web-1')).toStrictEqual(withKey)

    const withoutKey: RemoteHostLogin = { host: 'git.example', port: 22, user: 'git' }
    await service.store('git-1', withoutKey)
    expect(await service.load('git-1')).toStrictEqual(withoutKey)
  })

  it('reports nothing stored for an unknown id', async () => {
    const { service } = await boot()
    expect(await service.load('never-stored')).toBeUndefined()
  })

  it('forgets the record and every materialized file, and tolerates an unknown id', async () => {
    const { service } = await boot()
    const login: RemoteHostLogin = { host: 'example.com', port: 22, user: 'deploy', privateKey: PRIVATE_KEY }
    await service.store('web-1', login)
    const identity = await service.materialize(login)

    await service.forget('web-1')
    expect(await service.load('web-1')).toBeUndefined()
    await expect(stat(identity.directory)).rejects.toThrow()
    await expect(service.forget('never-stored')).resolves.toBeUndefined()
  })

  it('rejects ids that cannot address a record', async () => {
    const { service } = await boot()
    for (const id of ['', 'a/b', 'a\\b', 'a b']) {
      await expect(service.load(id)).rejects.toThrow(/host id/u)
      await expect(service.store(id, { host: 'example.com', port: 22, user: 'deploy' })).rejects.toThrow(/host id/u)
    }
  })

  it('rejects a stored payload that is not this package record', async () => {
    const { ctx, service } = await boot()
    const key = credentialKey('ssh-host-credentials', 'web-1')
    const payloads: readonly CredentialRecord[] = [
      { kind: 'api-key', key: 'sk-value' },
      { kind: 'grant', payload: { version: 2, login: { host: 'example.com', port: 22, user: 'deploy' } } },
      { kind: 'grant', payload: null },
      { kind: 'grant', payload: { version: 1 } },
      { kind: 'grant', payload: { version: 1, login: { host: 'example.com' } } },
    ]
    for (const record of payloads) {
      await ctx.credentials.modifyRecord(key, async () => record)
      await expect(service.load('web-1')).rejects.toThrow(/ssh-host-credentials\/web-1[\s\S]*version[\s\S]*1/u)
    }
  })
})
