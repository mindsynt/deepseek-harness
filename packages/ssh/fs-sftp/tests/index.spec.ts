/**
 * Tests for the SFTP filesystem provider.
 * @module @deepseek-ai/dsh-fs-sftp/tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { SftpFileSystem } from '../src/index.ts'

describe('SftpFileSystem', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  describe('constructor', () => {
    it('should create an instance', () => {
      const service = new SftpFileSystem(ctx)
      expect(service).toBeInstanceOf(SftpFileSystem)
    })
  })

  describe('processPath', () => {
    it('should return the target key as a string', () => {
      const service = new SftpFileSystem(ctx)
      const target = { targetKey: '/tmp/test.txt', displayPath: '/tmp/test.txt' } as FsTarget
      expect(service.processPath(target)).toBe('/tmp/test.txt')
    })
  })

  describe('contains', () => {
    it('should return true for nested paths', () => {
      const service = new SftpFileSystem(ctx)
      const parent = { targetKey: '/tmp', displayPath: '/tmp' } as FsTarget
      const child = { targetKey: '/tmp/test.txt', displayPath: 'test.txt' } as FsTarget
      expect(service.contains(parent, child)).toBe(true)
    })

    it('should return false for sibling paths', () => {
      const service = new SftpFileSystem(ctx)
      const parent = { targetKey: '/tmp', displayPath: '/tmp' } as FsTarget
      const child = { targetKey: '/etc/passwd', displayPath: 'passwd' } as FsTarget
      expect(service.contains(parent, child)).toBe(false)
    })
  })
})
