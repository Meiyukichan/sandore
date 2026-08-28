/**
 * remote.ts（SandoreRemoteError / unwrap）的单元测试：验证 `RemoteResult` 解包
 * 的薄封装行为——`ok:true` 取 `value`，`ok:false` 抛 `SandoreRemoteError`（`Error`
 * 子类，保留 `code` 与 `details`，LF.24 只抛 Error 子类）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/remote.spec
 */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'

import { SandoreRemoteError, unwrap } from './remote.ts'

/** 捕获 `fn` 抛出的 {@link SandoreRemoteError}；未抛错或非 SandoreRemoteError 返回 `undefined`。 */
function catchRemoteError(fn: () => unknown): SandoreRemoteError | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return err instanceof SandoreRemoteError ? err : undefined
  }
}

describe('unwrap', () => {
  it('returns the value when result is ok', () => {
    const ok: RemoteResult<{ id: string }> = { ok: true, value: { id: 'wfl-1' } }

    expect(unwrap(ok)).toEqual({ id: 'wfl-1' })
  })

  it('throws SandoreRemoteError preserving code and details when result is a failure', () => {
    const details = { line: 3, hint: 'unexpected token' }
    const failure: RemoteFailure = { code: 'YAML_PARSE', message: 'broken yaml', details }
    const failed: RemoteResult<{ id: string }> = { ok: false, error: failure }

    const err = catchRemoteError(() => unwrap(failed))

    expect(err).toBeInstanceOf(SandoreRemoteError)
    expect(err).toBeInstanceOf(Error)
    expect(err?.code).toBe('YAML_PARSE')
    expect(err?.details).toBe(details)
  })
})
