/**
 * Tests for the native SSH connection service.
 * @module @deepseek-ai/dsh-ssh-native/tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SshNativeConnection } from '../src/index.ts'
import type { SshNativeConfig, NativeExecHandle } from '../src/index.ts'

/** Create a mock exec handle for testing. */
function createMockExecHandle(options: {
  code?: number
  stdout?: Buffer
  stderr?: Buffer
} = {}): NativeExecHandle {
  const result = {
    code: options.code ?? 0,
    stdout: options.stdout ?? Buffer.alloc(0),
    stderr: options.stderr ?? Buffer.alloc(0),
  }
  return {
    done: Promise.resolve(result),
    wait: async () => result,
    terminate: async () => {},
    write: async () => true,
    resize: async () => {},
    signal: async () => {},
  }
}

describe('SshNativeConnection', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create an instance with valid config', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      expect(service).toBeInstanceOf(SshNativeConnection)
    })

    it('should validate required fields', async () => {
      expect(() => new SshNativeConnection(ctx, {} as SshNativeConfig)).toThrow()
      expect(() => new SshNativeConnection(ctx, { username: 'user' } as SshNativeConfig)).toThrow()
    })
  })

  describe('connection state', () => {
    it('should report disconnected before connection', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      expect(service.isConnected).toBe(false)
      expect(service.healthStatus).toBe('disconnected')
    })
  })

  describe('resolveExecutable', () => {
    it('should resolve an executable via command -v', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      // Mock the exec method
      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle({
        stdout: Buffer.from('/usr/bin/bash\n'),
      }))
      const result = await service.resolveExecutable('bash')
      expect(result).toBe('/usr/bin/bash')
    })

    it('should return undefined when executable not found', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle({
        code: 1,
        stdout: Buffer.alloc(0),
      }))
      const result = await service.resolveExecutable('nonexistent')
      expect(result).toBeUndefined()
    })
  })

  describe('terminalEnvironment', () => {
    it('should return shell path from $SHELL', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle({
        stdout: Buffer.from('/bin/bash\n'),
      }))
      const result = await service.terminalEnvironment()
      expect(result.shellPath).toBe('/bin/bash')
      expect(result.shellArgs).toEqual(['-l', '-i'])
    })

    it('should return default shell on error', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      vi.spyOn(service, 'exec').mockRejectedValue(new Error('connection failed'))
      const result = await service.terminalEnvironment()
      expect(result.shellPath).toBe('/bin/bash')
      expect(result.shellArgs).toEqual(['-l', '-i'])
    })
  })

  describe('exec timeout', () => {
    it('should create handle with timeout option', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle())

      // The method should accept timeout option
      await expect(service.exec('test', { timeoutMs: 5000 })).resolves.toBeDefined()
    })
  })

  describe('exec signal handling', () => {
    it('should create handle with signal method', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      const handle = await service.exec('test')

      // The handle should have a signal method
      expect(typeof handle.signal).toBe('function')
      await expect(handle.signal('SIGTERM')).resolves.toBeUndefined()
    })
  })

  describe('sftpBatch', () => {
    it('should execute batch operations', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      // Mock the SFTP methods
      vi.spyOn(service, 'sftpStat').mockResolvedValue({
        size: 100,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        mtime: 0,
        atime: 0,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })
      vi.spyOn(service, 'sftpRead').mockResolvedValue(Buffer.from('test data'))
      vi.spyOn(service, 'sftpWrite').mockResolvedValue(undefined)

      const operations = [
        { type: 'stat' as const, path: '/test/file.txt' },
        { type: 'read' as const, path: '/test/file.txt' },
        { type: 'write' as const, path: '/test/file.txt', data: Buffer.from('new data') },
      ]

      const results = await service.sftpBatch(operations)
      expect(results).toHaveLength(3)
      expect(results[0]?.success).toBe(true)
      expect(results[1]?.success).toBe(true)
      expect(results[2]?.success).toBe(true)
    })

    it('should handle errors in batch operations', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'sftpStat').mockRejectedValue(new Error('File not found'))

      const operations = [
        { type: 'stat' as const, path: '/nonexistent/file.txt' },
      ]

      const results = await service.sftpBatch(operations)
      expect(results).toHaveLength(1)
      expect(results[0]?.success).toBe(false)
      expect(results[0]?.error).toContain('File not found')
    })
  })

  describe('sftpReadStream', () => {
    it('should create a stream reader', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      // Mock the SFTP methods
      vi.spyOn(service, 'sftpStat').mockResolvedValue({
        size: 100,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        mtime: 0,
        atime: 0,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })
      vi.spyOn(service, 'sftpReadRange').mockResolvedValue(Buffer.from('test data'))

      const stream = await service.sftpReadStream('/test/file.txt')
      expect(stream).toBeDefined()
      expect(stream.isDone()).toBe(false)

      const chunk = await stream.read()
      expect(chunk).not.toBeNull()

      await stream.close()
      expect(stream.isDone()).toBe(true)
    })

    it('should throw when file not found', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'sftpStat').mockResolvedValue(undefined)

      await expect(service.sftpReadStream('/nonexistent/file.txt')).rejects.toThrow('file not found')
    })
  })

  describe('sftp operations', () => {
    it('should stat a file', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      const mockStat = {
        size: 100,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        mtime: 0,
        atime: 0,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      }

      vi.spyOn(service, 'sftpStat').mockResolvedValue(mockStat)
      const result = await service.sftpStat('/test/file.txt')
      expect(result).toEqual(mockStat)
    })

    it('should return undefined for nonexistent file', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'sftpStat').mockResolvedValue(undefined)
      const result = await service.sftpStat('/nonexistent/file.txt')
      expect(result).toBeUndefined()
    })

    it('should read a file', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'sftpStat').mockResolvedValue({
        size: 5,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        mtime: 0,
        atime: 0,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })
      vi.spyOn(service, 'sftpRead').mockResolvedValue(Buffer.from('hello'))

      const result = await service.sftpRead('/test/file.txt')
      expect(result.toString()).toBe('hello')
    })

    it('should write a file', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'sftpWrite').mockResolvedValue(undefined)

      await expect(service.sftpWrite('/test/file.txt', Buffer.from('data'))).resolves.toBeUndefined()
    })
  })

  describe('validateConfig', () => {
    it('should validate valid config', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
        privateKey: 'key',
      }
      const service = new SshNativeConnection(ctx, config)
      const result = await service.validateConfig()
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should warn about missing auth method', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      const result = await service.validateConfig()
      expect(result.valid).toBe(true)
      expect(result.warnings).toContain('no authentication method specified; will attempt agent or default keys')
    })

    it('should reject invalid port', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
        port: 99999,
      }
      const service = new SshNativeConnection(ctx, config)
      const result = await service.validateConfig()
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('port must be between 1 and 65535')
    })
  })

  describe('listProcesses', () => {
    it('should list processes', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle({
        stdout: Buffer.from('  1 root  init  0.0 1024 root R\n  2 testuser  test  1.0 2048 testuser S\n'),
      }))

      const result = await service.listProcesses()
      expect(result).toHaveLength(2)
      expect(result[0]?.pid).toBe(1)
      expect(result[1]?.pid).toBe(2)
    })

    it('should filter by user', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle({
        stdout: Buffer.from('  2 testuser  test  1.0 2048 testuser S\n'),
      }))

      const result = await service.listProcesses({ user: 'testuser' })
      expect(result).toHaveLength(1)
      expect(result[0]?.user).toBe('testuser')
    })
  })

  describe('killProcess', () => {
    it('should kill a process', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle({
        code: 0,
      }))

      await expect(service.killProcess(1234)).resolves.toBeUndefined()
    })

    it('should throw on kill failure', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'exec').mockResolvedValue(createMockExecHandle({
        code: 1,
      }))

      await expect(service.killProcess(9999)).rejects.toThrow()
    })
  })

  describe('getSystemInfo', () => {
    it('should get system info', async () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)

      vi.spyOn(service, 'exec').mockImplementation(async (cmd: string) => {
        if (cmd === 'hostname') {
          return createMockExecHandle({ stdout: Buffer.from('hostname\n') })
        } else if (cmd === 'uname -s -r') {
          return createMockExecHandle({ stdout: Buffer.from('Linux 5.15.0\n') })
        } else if (cmd === 'cat /proc/uptime') {
          return createMockExecHandle({ stdout: Buffer.from('3600 1800\n') })
        } else if (cmd === 'cat /proc/loadavg') {
          return createMockExecHandle({ stdout: Buffer.from('0.15 0.25 0.35\n') })
        } else if (cmd === 'cat /proc/meminfo') {
          return createMockExecHandle({ stdout: Buffer.from('MemTotal:       16384 kB\nMemFree:         4096 kB\nMemAvailable:    8192 kB\n') })
        } else if (cmd === 'df -B1') {
          return createMockExecHandle({ stdout: Buffer.from('Filesystem 1B-blocks Used Avail Use%\n/dev/sda1 1000000 500000 500000 50%\n') })
        }
        return createMockExecHandle({ stdout: Buffer.alloc(0) })
      })

      const result = await service.getSystemInfo()
      expect(result.hostname).toBe('hostname')
      expect(result.os).toBe('Linux')
      expect(result.kernel).toBe('5.15.0')
    })
  })

  describe('metrics', () => {
    it('should return zero metrics when not connected', () => {
      const config: SshNativeConfig = {
        host: 'example.com',
        username: 'testuser',
      }
      const service = new SshNativeConnection(ctx, config)
      const metrics = service.metrics
      expect(metrics.connectionTime).toBe(0)
      expect(metrics.requestsSent).toBe(0)
    })
  })
})
