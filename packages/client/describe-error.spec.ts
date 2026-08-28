/**
 * describe-error.ts（错误消息归一化）的单元测试：`Error` 取 `.message`、
 * 非 Error 抛错值回落 `String`。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/describe-error.spec
 */
import { describe, expect, it } from 'vitest'

import { describeError } from './describe-error.ts'

describe('describeError', () => {
  it('returns the message of an Error instance', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('returns the string form of a non-Error thrown value', () => {
    expect(describeError('nope')).toBe('nope')
  })
})
