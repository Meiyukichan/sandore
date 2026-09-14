/**
 * token-format.spec：B3 本地复刻（rc.1 ui-chat chat/token-format.ts）的纯函数
 * 回归——紧凑/精确 token 数 + 缓存命中百分比（含不把部分命中凑整为 100% 的
 * 诚实精度逻辑）。文案经 sandore zh 字典桩注入（number.thousand/million/
 * groupSeparator 模板）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/token-format.spec
 */
import { describe, expect, it } from 'vitest'

import { zh } from '../locales.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'

/** sandore zh 字典桩翻译（与渲染冒烟同款）。 */
function makeT() {
  const lookup = zh as unknown as Record<string, string>
  return (key: string, params?: Record<string, unknown>): string => {
    let text = lookup[key] ?? key
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value))
      }
    }
    return text
  }
}
const t = makeT() as never

describe('formatTokens（紧凑 token 数，rc.1 语义）', () => {
  it('keeps raw numbers below one thousand', () => {
    expect(formatTokens(0, t)).toBe('0')
    expect(formatTokens(517, t)).toBe('517')
    expect(formatTokens(999, t)).toBe('999')
  })

  it('scales thousands with one decimal under 100 units', () => {
    expect(formatTokens(1_000, t)).toBe('1K')
    expect(formatTokens(12_200, t)).toBe('12.2K')
    expect(formatTokens(99_950, t)).toBe('100K') // ≥100 单位整数取整
    expect(formatTokens(517_000, t)).toBe('517K')
  })

  it('scales millions like rc.1', () => {
    expect(formatTokens(1_200_000, t)).toBe('1.2M')
    expect(formatTokens(12_345_678, t)).toBe('12.3M')
    expect(formatTokens(1_000_000_000, t)).toBe('1000M')
  })
})

describe('formatExactTokens（千分位分组）', () => {
  it('groups digits with the locale separator', () => {
    expect(formatExactTokens(0, t)).toBe('0')
    expect(formatExactTokens(123, t)).toBe('123')
    expect(formatExactTokens(1_234, t)).toBe('1,234')
    expect(formatExactTokens(1_234_567, t)).toBe('1,234,567')
    expect(formatExactTokens(12_000, t)).toBe('12,000')
  })
})

describe('formatCacheHitPercent（缓存命中百分比，诚实精度）', () => {
  it('returns null without prompt input and full 100 on a complete hit', () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull()
    expect(formatCacheHitPercent(500, 0)).toBeNull()
    expect(formatCacheHitPercent(500, 500)).toBe('100')
  })

  it('rounds ordinary ratios to integer percent with positive ties up', () => {
    expect(formatCacheHitPercent(0, 1_000)).toBe('0')
    expect(formatCacheHitPercent(500, 1_000)).toBe('50')
    expect(formatCacheHitPercent(999, 1_000)).toBe('99.9') // 不凑整 100
  })

  it('keeps a partial hit honest near 100%', () => {
    // 99.95% 命中不该凑整为 100%（额外小数位保证诚实）
    expect(formatCacheHitPercent(99_950, 100_000)).toBe('99.95')
    // 精确 100% 才显示 100
    expect(formatCacheHitPercent(100_000, 100_000)).toBe('100')
  })
})
