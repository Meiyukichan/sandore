/**
 * step-retry.spec（批 B2）：面板内重试的纯逻辑回归——可见性判定、模式集合与文案键、
 * 提交载荷装配（默认 message / revert 边界传递）、回退点选项映射与下拉值转换、
 * 错误映射（引擎原文优先 + F1 分类）、回退点区降级文案分支。
 *
 * 组件渲染与接线（点击 → 端口调用、错误行、下拉）见 step-retry-row.spec（jsdom）与
 * step-chat-retry-wiring.spec（面板级 jsdom）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/step-retry.spec
 */
import { describe, expect, it } from 'vitest'

import {
  STEP_RETRY_BOUNDARY_DEFAULT,
  STEP_RETRY_MODES,
  stepRetryBoundaryHintOf,
  stepRetryBoundaryOf,
  stepRetryBoundaryOptionsOf,
  stepRetryBoundarySelectValue,
  stepRetryErrorKind,
  stepRetryErrorText,
  stepRetryMessageOf,
  stepRetryModeLabelKey,
  stepRetryRequestOf,
  stepRetryRevertUnavailable,
  stepRetryVisible,
  type StepRetryBoundariesState,
  type StepRetryTarget,
} from './step-retry.ts'

/** 可重试的失败段（真实子代理 step）。 */
function failedTarget(overrides: Partial<StepRetryTarget> = {}): StepRetryTarget {
  return { stepId: 'step-a', status: 'failed', commandType: 'prompt', synthetic: false, ...overrides }
}

describe('stepRetryVisible（重试行可见性）', () => {
  it('shows the row only for a failed real subagent step', () => {
    expect(stepRetryVisible(failedTarget())).toBe(true)
    // 四个子代理 command 都算真实子代理 step（与引擎 isSubagentStep 同码表）。
    for (const commandType of ['prompt', 'agent', 'skill', 'mcp']) {
      expect(stepRetryVisible(failedTarget({ commandType }))).toBe(true)
    }
  })

  it('hides the row for non-failed / synthetic / shell / unknown segments', () => {
    // 引擎只重试 failed 段（completed no-op、其它状态抛 INVALID_OPERATION）。
    for (const status of ['running', 'interacting', 'completed', 'paused', 'blocked', 'ready']) {
      expect(stepRetryVisible(failedTarget({ status }))).toBe(false)
    }
    // shell 合成会话：引擎 retryStep 前置拦截（非子代理 step）——UI 不给入口。
    expect(stepRetryVisible(failedTarget({ commandType: 'shell', synthetic: true }))).toBe(false)
    expect(stepRetryVisible(failedTarget({ synthetic: true }))).toBe(false)
    // 缺 commandType / 未知 command：无法确认是真实子代理（引擎会拒），不显示。
    expect(stepRetryVisible(failedTarget({ commandType: undefined }))).toBe(false)
    expect(stepRetryVisible(failedTarget({ commandType: 'terminal' }))).toBe(false)
    // 空 stepId：无从寻址（防御）。
    expect(stepRetryVisible(failedTarget({ stepId: '  ' }))).toBe(false)
    // 旧调用方不传目标片段 → 不显示。
    expect(stepRetryVisible(undefined)).toBe(false)
  })
})

describe('模式集合与文案键', () => {
  it('exposes the engine三模式 in display order', () => {
    expect(STEP_RETRY_MODES).toEqual(['continue', 'revert', 'fork'])
  })

  it('maps each mode onto the existing DiscussionInput locale keys', () => {
    expect(stepRetryModeLabelKey('continue')).toBe('run.retry.mode.continue')
    expect(stepRetryModeLabelKey('revert')).toBe('run.retry.mode.revert')
    expect(stepRetryModeLabelKey('fork')).toBe('run.retry.mode.fork')
  })
})

describe('stepRetryMessageOf（默认 message）', () => {
  it('uses the draft verbatim when it has content', () => {
    expect(stepRetryMessageOf('请重跑并保留产物', '请重试该步骤')).toBe('请重跑并保留产物')
    // 不 trim：用户排版（前导空格/换行）属于内容，原样投递。
    expect(stepRetryMessageOf('  带空格的正文\n第二行', '默认')).toBe('  带空格的正文\n第二行')
  })

  it('falls back to the localized default when the draft is blank', () => {
    expect(stepRetryMessageOf('', '请重试该步骤')).toBe('请重试该步骤')
    expect(stepRetryMessageOf('   \n\t ', '请重试该步骤')).toBe('请重试该步骤')
  })
})

describe('stepRetryRequestOf（提交载荷）', () => {
  it('carries stepId/mode/message and omits the boundary key outside revert', () => {
    const request = stepRetryRequestOf(failedTarget(), 'continue', '', { defaultMessage: '请重试该步骤' })
    expect(request).toEqual({ stepId: 'step-a', mode: 'continue', message: '请重试该步骤' })
    // 键必须**缺席**（exactOptionalPropertyTypes：不能是显式 undefined）。
    expect('revertBoundary' in request).toBe(false)
    // fork 同样不携带（引擎自决 fork 边界，用户选择对它无意义）。
    const forked = stepRetryRequestOf(failedTarget(), 'fork', '换个思路', { defaultMessage: '默认' }, 42)
    expect(forked).toEqual({ stepId: 'step-a', mode: 'fork', message: '换个思路' })
    expect('revertBoundary' in forked).toBe(false)
  })

  it('carries the revert boundary only in revert mode', () => {
    const picked = stepRetryRequestOf(failedTarget(), 'revert', '', { defaultMessage: '请重试该步骤' }, 128)
    expect(picked).toEqual({
      stepId: 'step-a',
      mode: 'revert',
      message: '请重试该步骤',
      revertBoundary: 128,
    })
    // 未选边界（默认）= 不携带，交引擎按最后一个闭合 turn 回退。
    const byDefault = stepRetryRequestOf(failedTarget(), 'revert', '重来', { defaultMessage: '默认' })
    expect(byDefault).toEqual({ stepId: 'step-a', mode: 'revert', message: '重来' })
    expect('revertBoundary' in byDefault).toBe(false)
  })
})

describe('回退点选项映射与下拉值', () => {
  it('keeps valid options in order and drops malformed ones', () => {
    expect(stepRetryBoundaryOptionsOf([
      { seq: 120, turn: 0, preview: '第一轮' },
      { seq: Number.NaN, turn: 1, preview: '' },
      { seq: 200, turn: 1 },
      null as never,
      { seq: 240, turn: 2, preview: '第三轮' },
    ])).toEqual([
      { seq: 120, turn: 0, preview: '第一轮' },
      { seq: 200, turn: 1 },
      { seq: 240, turn: 2, preview: '第三轮' },
    ])
    expect(stepRetryBoundaryOptionsOf(undefined)).toEqual([])
  })

  it('round-trips the select value through default/seq', () => {
    expect(stepRetryBoundarySelectValue(undefined)).toBe(STEP_RETRY_BOUNDARY_DEFAULT)
    expect(stepRetryBoundarySelectValue(128)).toBe('128')
    expect(stepRetryBoundaryOf('default')).toBeUndefined()
    expect(stepRetryBoundaryOf('')).toBeUndefined()
    expect(stepRetryBoundaryOf('abc')).toBeUndefined()
    expect(stepRetryBoundaryOf('128')).toBe(128)
  })
})

describe('错误映射（引擎原文优先，F1 分类）', () => {
  it('shows the engine message verbatim (F1 wording stays readable)', () => {
    const f1 = new Error(
      "INVALID_OPERATION: step 'step-a' 的子代理会话已销毁（DSH 0.1.2-rc.1 对已结算子代理 dispose，"
      + '无法续跑），不能重试；请重新运行该 Step/实例',
    )
    const text = stepRetryErrorText(f1, '重试失败')
    expect(text).toContain('子代理会话已销毁')
    expect(text.startsWith('INVALID_OPERATION')).toBe(true)
    expect(stepRetryErrorKind(f1)).toBe('disposed')
  })

  it('classifies the DSH not-resumable / disposed family and everything else', () => {
    expect(stepRetryErrorKind(new Error('subagent session has been disposed'))).toBe('disposed')
    expect(stepRetryErrorKind('NOT_RESUMABLE: no continuable state')).toBe('disposed')
    expect(stepRetryErrorKind(new Error('INVALID_OPERATION: only failed steps can be retried'))).toBe('other')
    expect(stepRetryErrorKind(undefined)).toBe('other')
  })

  it('falls back to the localized text when there is no message', () => {
    expect(stepRetryErrorText(new Error(''), '重试失败')).toBe('重试失败')
    expect(stepRetryErrorText('裸字符串错误', '重试失败')).toBe('裸字符串错误')
    expect(stepRetryErrorText(undefined, '重试失败')).toBe('重试失败')
  })
})

describe('回退点区降级文案', () => {
  it('maps each boundaries state onto a hint (or none)', () => {
    expect(stepRetryBoundaryHintOf({ kind: 'idle' })).toBeUndefined()
    expect(stepRetryBoundaryHintOf({ kind: 'loading' }))
      .toEqual({ kind: 'loading', key: 'run.retry.boundary.loading' })
    expect(stepRetryBoundaryHintOf({ kind: 'ready', options: [] }))
      .toEqual({ kind: 'empty', key: 'run.retry.boundary.empty' })
    expect(stepRetryBoundaryHintOf({ kind: 'ready', options: [{ seq: 1, turn: 0 }] })).toBeUndefined()
    expect(stepRetryBoundaryHintOf({ kind: 'error', message: 'boom' })).toEqual({
      kind: 'error',
      key: 'run.step.chat.retry.boundariesFailed',
      message: 'boom',
    })
  })

  it('warns lightly when revert has no closed turn to fall back to', () => {
    const empty: StepRetryBoundariesState = { kind: 'ready', options: [] }
    expect(stepRetryRevertUnavailable(empty, 'revert')).toBe(true)
    expect(stepRetryRevertUnavailable(empty, 'continue')).toBe(false)
    expect(stepRetryRevertUnavailable({ kind: 'ready', options: [{ seq: 1, turn: 0 }] }, 'revert')).toBe(false)
    expect(stepRetryRevertUnavailable({ kind: 'loading' }, 'revert')).toBe(false)
    expect(stepRetryRevertUnavailable({ kind: 'error', message: 'x' }, 'revert')).toBe(false)
  })
})
