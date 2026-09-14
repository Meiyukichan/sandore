/**
 * main-agent-chat.spec（呈现层统一 · 真机反馈修正后）：主代理卡片的纯逻辑单测。
 *
 * 覆盖两块（全部与 React 无关，故 node 环境即可）：
 * 1. 宿主会话 id 解析（段上的 `parentSessionId` 优先；历史实例回退 `instanceId`）；
 * 2. 助手输出计数与卡片出现判定（`mainAgentOutputCount` / `mainAgentCardShown`：**主代理会话里
 *    有助手消息就出现**——真机反馈修正后不再要求「用户先发过消息」，启动汇报也能带出卡片）；
 *    卡片**位置**固定为步骤列表最后一张、**默认折叠**，与「正在执行哪一步」无关，故插入点解析
 *    与「中止 turn」动作探测都已随对应 UI 删除（本 spec 末尾锁「不再导出」）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  mainAgentCardShown,
  mainAgentOutputCount,
  mainAgentSessionIdOf,
} from './main-agent-chat.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('mainAgentSessionIdOf：宿主（主代理）会话 id 解析', () => {
  it('prefers the segment-persisted parentSessionId (sessionMeta.hostSessionId)', () => {
    expect(mainAgentSessionIdOf([
      { stepId: 'a', status: 'completed' },
      { stepId: 'b', status: 'running', parentSessionId: 'host-1' },
    ], 'inst-1')).toBe('host-1')
  })

  it('falls back to the instanceId (engine identity hostSessionId ≡ instanceId) when no segment carries it', () => {
    // 历史实例：段上没有 sessionMeta.hostSessionId → 用引擎恒等式兜底，而不是空串。
    expect(mainAgentSessionIdOf([
      { stepId: 'a', status: 'completed' },
      { stepId: 'b', status: 'running' },
    ], 'inst-9')).toBe('inst-9')
    expect(mainAgentSessionIdOf([], 'inst-9')).toBe('inst-9')
  })

  it('ignores empty-string parents instead of returning them', () => {
    expect(mainAgentSessionIdOf([
      { stepId: 'a', status: 'running', parentSessionId: '' },
      { stepId: 'b', status: 'running', parentSessionId: 'host-2' },
    ], 'inst-1')).toBe('host-2')
  })
})

describe('mainAgentOutputCount / mainAgentCardShown：主代理有助手消息就出现卡片', () => {
  const order = ['ctx', 'user-1', 'assistant-1']
  const kinds: Record<string, string> = {
    ctx: 'context',
    'user-1': 'user',
    'assistant-1': 'assistant-step',
  }
  const kindOf = (key: string): string | undefined => kinds[key]

  it('counts only assistant-step nodes', () => {
    expect(mainAgentOutputCount(order, kindOf)).toBe(1)
    expect(mainAgentOutputCount([], kindOf)).toBe(0)
    expect(mainAgentOutputCount(['ctx', 'user-1'], kindOf)).toBe(0)
  })

  it('appears from the first assistant message (startup report counts) and never on an empty shell', () => {
    // 真机反馈修正：不再要求「用户先在运行页发过消息」——启动注入后主代理自己汇报
    // 「工作流已启动」时就该出现（那条回复也让计数 > 0）。
    expect(mainAgentCardShown(1)).toBe(true)
    expect(mainAgentCardShown(2)).toBe(true)
    // 没有任何助手消息（视图未就绪 / 主代理还没说话）→ 连空壳都不出现。
    expect(mainAgentCardShown(0)).toBe(false)
    // 与 mainAgentOutputCount 组合起来就是出现条件本身。
    expect(mainAgentCardShown(mainAgentOutputCount(order, kindOf))).toBe(true)
    expect(mainAgentCardShown(mainAgentOutputCount(['ctx', 'user-1'], kindOf))).toBe(false)
  })
})

describe('主代理席位不再暴露「中止 turn」动作（真机反馈第三轮：去掉输入框区的按钮）', () => {
  it('the module no longer exports mainAgentTurnCancelOf (no dead plumbing left behind)', async () => {
    // 该探测链只服务于已删除的输入框停止按钮；删按钮时一并删除函数，防止「半死代码」回潮。
    const module = await import('./main-agent-chat.ts') as Record<string, unknown>
    expect(module['mainAgentTurnCancelOf']).toBeUndefined()
    for (const name of ['mainAgentSessionIdOf', 'mainAgentOutputCount', 'mainAgentCardShown']) {
      expect(typeof module[name], `${name} 仍应导出（卡片出现条件还要用）`).toBe('function')
    }
  })
})
