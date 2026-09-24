import { describe, expect, it } from 'vitest'
import { formatCostAmount } from '../src/client/chat/cost-format.ts'

describe('formatCostAmount', () => {
  it('keeps exactly two fraction digits', () => {
    expect(formatCostAmount(0.0123)).toBe('0.01')
    expect(formatCostAmount(0.5)).toBe('0.50')
    expect(formatCostAmount(12)).toBe('12.00')
    expect(formatCostAmount(10.14444)).toBe('10.14')
    expect(formatCostAmount(1988.572256)).toBe('1988.57')
  })

  it('formats zero and sub-cent amounts at the same precision', () => {
    expect(formatCostAmount(0)).toBe('0.00')
    expect(formatCostAmount(0.0000005)).toBe('0.00')
    expect(formatCostAmount(0.004)).toBe('0.00')
    expect(formatCostAmount(0.005)).toBe('0.01')
  })

  it('rounds binary floating-point tails at the display precision', () => {
    expect(formatCostAmount(0.1 + 0.2)).toBe('0.30')
    expect(formatCostAmount(1 / 3)).toBe('0.33')
  })

  it('keeps large amounts in plain decimal notation', () => {
    expect(formatCostAmount(1e21)).toBe('1000000000000000000000.00')
  })
})
