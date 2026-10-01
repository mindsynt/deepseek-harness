/**
 * Integration tests for the native SSH connection service.
 * These tests require a real SSH server and will be skipped if DEEPSEEK_SSH_TEST_HOST is not set.
 *
 * To run these tests:
 *   DEEPSEEK_SSH_TEST_HOST=localhost DEEPSEEK_SSH_TEST_USER=root \
 *   DEEPSEEK_SSH_TEST_KEY=/path/to/key \
 *   npx vitest run tests/integration.spec.ts
 *
 * @module @deepseek-ai/dsh-ssh-native/tests/integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SshNativeConnection } from '../src/index.ts'
import type { SshNativeConfig } from '../src/index.ts'

/** Read optional test configuration from environment. */
const testHost = process.env.DEEPSEEK_SSH_TEST_HOST
const testUser = process.env.DEEPSEEK_SSH_TEST_USER
const testKey = process.env.DEEPSEEK_SSH_TEST_KEY
const testPassword = process.env.DEEPSEEK_SSH_TEST_PASSWORD
const testPort = process.env.DEEPSEEK_SSH_TEST_PORT ? parseInt(process.env.DEEPSEEK_SSH_TEST_PORT, 10) : 22

/** Whether to run integration tests. */
const shouldRun = testHost !== undefined && testUser !== undefined && (testKey !== undefined || testPassword !== undefined)

describe('SshNativeConnection integration', () => {
  let service: SshNativeConnection | undefined

  beforeAll(async () => {
    if (!shouldRun) return

    const ctx = new Context()
    const config: SshNativeConfig = {
      host: testHost!,
      port: testPort,
      username: testUser!,
      ...(testKey !== undefined ? { identityFile: testKey } : {}),
      ...(testPassword !== undefined ? { password: testPassword } : {}),
      connectTimeout: 10000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 2,
    }
    service = new SshNativeConnection(ctx, config)
    await service.ready
  })

  afterAll(async () => {
    if (service !== undefined) {
      await service.dispose()
    }
  })

  (shouldRun ? describe : describe.skip)('connection', () => {
    it('should establish a connection', async () => {
      expect(service).toBeDefined()
      expect(service!.clientConnection).toBeDefined()
    })

    it('should have SFTP subsystem available', async () => {
      expect(service!.sftpClient).toBeDefined()
    })
  })

  (shouldRun ? describe : describe.skip)('SFTP operations', () => {
    it('should stat a file', async () => {
      const stat = await service!.sftpStat('/etc/hostname')
      expect(stat).toBeDefined()
      expect(stat!.size).toBeGreaterThan(0)
    })

    it('should read a file', async () => {
      const content = await service!.sftpRead('/etc/hostname')
      expect(content).toBeDefined()
      expect(content!.length).toBeGreaterThan(0)
    })

    it('should list a directory', async () => {
      const entries = await service!.sftpReaddir('/etc')
      expect(entries).toBeDefined()
      expect(entries!.length).toBeGreaterThan(0)
      expect(entries![0]!.name).toBeDefined()
    })

    it('should resolve a realpath', async () => {
      const result = await service!.sftpRealpath('/etc/hostname')
      expect(result).toBeDefined()
      expect(result!.path).toContain('/etc')
    })
  })

  (shouldRun ? describe : describe.skip)('exec operations', () => {
    it('should execute a simple command', async () => {
      const handle = await service!.exec('echo hello world')
      const result = await handle.wait()
      expect(result.code).toBe(0)
      expect(result.stdout.toString()).toContain('hello world')
    })

    it('should execute with working directory', async () => {
      const handle = await service!.exec('pwd', { cwd: '/tmp' })
      const result = await handle.wait()
      expect(result.code).toBe(0)
      expect(result.stdout.toString()).toContain('/tmp')
    })

    it('should resolve an executable', async () => {
      const path = await service!.resolveExecutable('bash')
      expect(path).toBeDefined()
      expect(path).toContain('/bin/bash')
    })

    it('should get terminal environment', async () => {
      const env = await service!.terminalEnvironment()
      expect(env.shellPath).toBeDefined()
      expect(env.shellPath).toContain('/bin/')
      expect(env.shellArgs).toContain('-l')
    })
  })

  (shouldRun ? describe : describe.skip)('terminal operations', () => {
    it('should execute with PTY', async () => {
      const handle = await service!.exec('echo PTY test', {
        pty: { cols: 80, rows: 24, term: 'xterm-256color' },
      })
      const result = await handle.wait()
      expect(result.code).toBe(0)
      expect(result.stdout.toString()).toContain('PTY test')
    })
  })
})
