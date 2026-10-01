/**
 * Tests for the SSH exec subprocess provider.
 * @module @deepseek-ai/dsh-subprocess-ssh-exec/tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SshExecSubprocessRuntime } from '../src/index.ts'

describe('SshExecSubprocessRuntime', () => {
  let ctx: Context
  let mockSshNative: {
    resolveExecutable: ReturnType<typeof vi.fn>
    terminalEnvironment: ReturnType<typeof vi.fn>
    exec: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    ctx = new Context()
    mockSshNative = {
      resolveExecutable: vi.fn(),
      terminalEnvironment: vi.fn(),
      exec: vi.fn(),
    }
    // Set up the mock service on the context
    Object.defineProperty(ctx, 'sshNative', {
      get: () => mockSshNative,
      configurable: true,
    })
  })

  describe('constructor', () => {
    it('should create an instance', () => {
      const service = new SshExecSubprocessRuntime(ctx)
      expect(service).toBeInstanceOf(SshExecSubprocessRuntime)
    })
  })

  describe('terminalEnvironment', () => {
    it('should return posix platform with shell path', async () => {
      mockSshNative.terminalEnvironment.mockResolvedValue({ shellPath: '/bin/bash', shellArgs: ['-l', '-i'] })
      const service = new SshExecSubprocessRuntime(ctx)
      const result = await service.terminalEnvironment()
      expect(result.platform).toBe('posix')
      expect(result.defaultShell).toBe('/bin/bash')
    })
  })

  describe('resolveExecutable', () => {
    it('should resolve an executable', async () => {
      mockSshNative.resolveExecutable.mockResolvedValue('/usr/bin/bash')
      const service = new SshExecSubprocessRuntime(ctx)
      const result = await service.resolveExecutable('bash')
      expect(result).toBe('/usr/bin/bash')
    })

    it('should throw when executable not found', async () => {
      mockSshNative.resolveExecutable.mockResolvedValue(undefined)
      const service = new SshExecSubprocessRuntime(ctx)
      await expect(service.resolveExecutable('nonexistent')).rejects.toThrow()
    })
  })
})
