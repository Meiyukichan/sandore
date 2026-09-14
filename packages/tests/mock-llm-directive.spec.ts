/**
 * mock-llm 指令解析与「宿主照办 run」门控的 fixture 级单测（纯函数，node 环境）。
 *
 * 为什么要在这里测 e2e 基建：`e2e/mock-llm/index.js` 是整层 M/F e2e 的**行为脚本引擎**，
 * 它自身出问题时症状是「用例全红但看不出原因」（本次真实踩坑：指令体正则 `[^\]]*` 会在
 * 载荷内第一个 `]` 处截断，于是 `toolargs={"targets":["<stepId>"]}` 这类指令**整条匹配失败**，
 * mock 静默按默认文本回复，宿主主代理那次「照办 send_message」永不发生）。所以：
 * 1. **指令解析**必须能吃下「载荷里带 `]`/`}`/空格的 JSON」——否则带数组入参的工具指令写不出来；
 * 2. **宿主照办门控**必须三重成立、且对 step 子代理（提示词总带指令）**永不误命中**——
 *    这条是 parent 明确要求锁住的（误命中会让每个 step 都被要求去 run 工作流）。
 *
 * 导入路径是本仓唯一一处「packages 下的 spec 直接引用 e2e/ 产物」：mock 插件本身是纯 JS、
 * 无任何宿主依赖（见其文件头），import 它不会拉起 DSH 运行时。
 * @module @meiyukichan/dsh-sandore/tests/mock-llm-directive.spec
 */
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../../e2e/mock-llm/index.js'
import {
  hostRunCallOf,
  hostRunOriginalInputOf,
  parseDirective,
} from '../../e2e/mock-llm/index.js'

/** 宿主协作上下文的注入文本（形状对齐 packages/workflow/host-context.ts）。 */
const HOST_CONTEXT = [
  '## 用户指令',
  '用户选择用工作流「e2e-demo」执行下面这个任务，请调用 sandore_workflow_run 启动它：',
  'e2e-demo-req',
  '',
  '（启动参数：workflowId = "wfl-abc-123"，originalInput = 上面这段任务原文；cwd/model/permission 新建时已选好，无需重复传。）',
  '',
  '## 工作流协作规则',
  '工作流启动后由引擎独立驱动它的各个 Step（每个 Step 是一个子代理会话）。',
].join('\n')

describe('parseDirective：指令解析（含载荷内 `]` / `}` / 空格）', () => {
  it('parses a plain directive and flag keys', () => {
    expect(parseDirective('[[e2e-mock text=final-answer chunks=3]]')).toEqual({ text: 'final-answer', chunks: '3' })
    expect(parseDirective('前文 [[e2e-mock once]] 后文')).toEqual({ once: '1' })
  })

  it('keeps brace-balanced JSON values that contain `]` (the regression this locks)', () => {
    // 关键回归：`[^\]]*` 的老正则会在这里截断 → 整条指令解析不出来。
    const directive = '[[e2e-mock once=1 tool=sandore_workflow_send_message toolargs={"targets":["step-a"],"message":"hi there"}]]'
    expect(parseDirective(`请把下面这句话发给步骤 step-a：hi there ${directive}`)).toEqual({
      once: '1',
      tool: 'sandore_workflow_send_message',
      toolargs: '{"targets":["step-a"],"message":"hi there"}',
    })
  })

  it('handles multiple directives with later-wins override and stray brackets', () => {
    const text = '[e2e] [[e2e-mock text=a]] 中间 ]] [[e2e-mock text=b hold=1000]]'
    expect(parseDirective(text)).toEqual({ text: 'b', hold: '1000' })
  })

  it('ignores an unterminated directive instead of throwing', () => {
    expect(parseDirective('[[e2e-mock text=oops')).toEqual({})
  })
})

describe('hostRunCallOf：宿主照办 run 的三重门控', () => {
  const call = (scan: string, hasDirective: boolean, sessionKey: string, turn: number) =>
    hostRunCallOf(scan, hasDirective, sessionKey, turn)

  it('fires on the first call carrying the host context (parses ids from the text, never hardcoded)', () => {
    const result = call(HOST_CONTEXT, false, 'sess-1', 1)
    expect(result?.workflowId).toBe('wfl-abc-123')
    expect(result?.originalInput).toBe('e2e-demo-req')
  })

  it('never fires for a session whose prompt carries an [[e2e-mock …]] directive (step subagents)', () => {
    // step 子代理的提示词里既有自己的指令、也可能拼进别的内容 → 一律不照办。
    expect(call(`${HOST_CONTEXT}\n[[e2e-mock text=step-answer hold=1000]]`, true, 'sess-step', 1)).toBeUndefined()
  })

  it('never fires without the host-context marker or without a parseable workflowId', () => {
    expect(call('普通提示词，没有任何标记', false, 'sess-2', 1)).toBeUndefined()
    expect(call('请调用 sandore_workflow_run 启动它：但没有启动参数行', false, 'sess-3', 1)).toBeUndefined()
  })

  it('is a pure predicate: the once-per-session latch lives in the stream (see the integration block below)', () => {
    expect(call(HOST_CONTEXT, false, 'sess-pure', 1)).toBeDefined()
    expect(call(HOST_CONTEXT, false, 'sess-pure', 2)).toBeDefined()
  })
})

/** 一次模型调用的入参形状（mock 只读 messages/system/sessionId/provider/model/signal）。 */
function callOptions(sessionId: string, texts: readonly string[]): Record<string, unknown> {
  return {
    sessionId,
    provider: 'e2e-mock',
    model: 'mock-1',
    messages: texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })),
  }
}

/** 把一次 mock 调用的 chunk 序列收成数组（供断言 finish 语义与 tool-call 名字）。 */
async function collect(stream: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const chunks: Record<string, unknown>[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 取出 chunk 序列里的 tool-call 名与 finish 原因（断言面）。 */
function outcomeOf(chunks: readonly Record<string, unknown>[]): {
  readonly tools: readonly string[]
  readonly finish: unknown
} {
  const tools: string[] = []
  let finish: unknown
  for (const chunk of chunks) {
    if (chunk.type === 'block-end') {
      const block = chunk.block as { type?: string; name?: string } | undefined
      if (block?.type === 'tool-call' && typeof block.name === 'string') tools.push(block.name)
    }
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { tools, finish }
}

describe('mock adapter 集成：宿主照办 run 与一次性门控（fake ctx 驱动真实 stream）', () => {
  /** 挂起 mock adapter 并取回它（`ctx.llm.registerAdapter` 的结构面）。 */
  function mountMock(): { stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>> } {
    let adapter: { stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>> } | undefined
    const ctx = {
      llm: {
        registerAdapter: (_providers: readonly string[], value: typeof adapter) => { adapter = value },
      },
      on: vi.fn(),
      logger: { info: vi.fn() },
    }
    apply(ctx, { provider: 'e2e-mock', model: 'mock-1' })
    if (adapter === undefined) throw new Error('mock adapter 未注册')
    return adapter
  }

  it('duplicates the host run call exactly once per session, then falls back to text', async () => {
    const adapter = mountMock()
    const session = `sess-int-${Math.random().toString(36).slice(2, 8)}`
    // 第 1 次调用：宿主协作上下文（无指令）→ 照办 run（tool-call + finish:tool-calls）。
    const first = outcomeOf(await collect(adapter.stream(callOptions(session, [HOST_CONTEXT]))))
    expect(first.tools).toEqual(['sandore_workflow_run'])
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    // 第 2 次调用：同一会话（历史里那段文本还在）→ 只服务一次 ⇒ 回落默认文本。
    const second = outcomeOf(await collect(adapter.stream(callOptions(session, [HOST_CONTEXT]))))
    expect(second.tools).toEqual([])
    expect(second.finish).toEqual({ kind: 'stop' })
  })

  it('never duplicates a run call for a step session (its prompt carries a directive)', async () => {
    const adapter = mountMock()
    const stepPrompt = `你是执行者。[[e2e-mock text=step-answer hold=1000]]\n${HOST_CONTEXT}`
    const outcome = outcomeOf(await collect(adapter.stream(callOptions('sess-step-int', [stepPrompt]))))
    expect(outcome.tools).toEqual([])
    expect(outcome.finish).toEqual({ kind: 'stop' })
  })

  it('honours a one-shot forced tool call (once=1) regardless of the call index', async () => {
    const adapter = mountMock()
    const session = `sess-once-${Math.random().toString(36).slice(2, 8)}`
    const directive = '[[e2e-mock once=1 tool=sandore_workflow_send_message toolargs={"targets":["step-a"],"message":"hi"}]]'
    // 先来一次无关调用（占掉 call#1，模拟「照办 run + 工具结果回灌」的真实占号）。
    await collect(adapter.stream(callOptions(session, ['普通提示词'])))
    const first = outcomeOf(await collect(adapter.stream(callOptions(session, [`请发给 step-a：hi ${directive}`]))))
    expect(first.tools).toEqual(['sandore_workflow_send_message'])
    // 同一条消息仍在历史里 → 不得重复发同一次调用。
    const second = outcomeOf(await collect(adapter.stream(callOptions(session, [`请发给 step-a：hi ${directive}`]))))
    expect(second.tools).toEqual([])
  })
})

describe('hostRunOriginalInputOf：从注入文本里原样取「用户指令」那一段', () => {
  it('returns the block between the marker line and the blank line', () => {
    expect(hostRunOriginalInputOf(HOST_CONTEXT)).toBe('e2e-demo-req')
  })

  it('keeps multi-line requirements and returns undefined without the marker', () => {
    const multi = HOST_CONTEXT.replace('e2e-demo-req', '第一行\n第二行')
    expect(hostRunOriginalInputOf(multi)).toBe('第一行\n第二行')
    expect(hostRunOriginalInputOf('没有标记')).toBeUndefined()
  })
})
