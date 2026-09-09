/**
 * `subagents.ts` 会话消息归一化（collectSessionMessages）的 rc.1 形状测试：
 * 真实 `tool/result` 载荷是 `ToolResultBlock`（tool-result 包装，文本嵌内层
 * content），非顶层 text 块——锁定递归提取语义。
 * @module @meiyukichan/dsh-sandore/microflow/src/session-messages.spec
 */
import { describe, expect, it } from 'vitest';

import { collectSessionMessages } from './subagents.ts';

/** 构造一个事件（类型收窄为 SessionEvent 的编译期哨兵；形状与 core/session 对齐）。 */
function eventOf(type: string, data: unknown): never {
  return { type, seq: 0, time: 0, data } as never;
}

describe('collectSessionMessages（rc.1 tool/result 真实形状）', () => {
  it('extracts text nested inside ToolResultBlock wrappers (rc.1 tool/result shape)', () => {
    const events = [
      // rc.1 真实形状：message.content = [ToolResultBlock{ type:'tool-result', content:[text…] }]
      eventOf('tool/result', {
        message: {
          content: [
            {
              type: 'tool-result',
              content: [{ type: 'text', text: 'build ok' }, { type: 'text', text: '2 files changed' }],
            },
          ],
        },
      }),
      // 旧形状兼容：顶层 text 块直接可读。
      eventOf('tool/result', { message: { content: [{ type: 'text', text: 'legacy shape' }] } }),
    ];
    const rows = collectSessionMessages(events as never);
    expect(rows).toEqual([
      { type: 'tool', output: 'build ok\n2 files changed' },
      { type: 'tool', output: 'legacy shape' },
    ]);
  });

  it('skips empty results and keeps assistant/user rows intact', () => {
    const events = [
      eventOf('tool/result', { message: { content: [{ type: 'tool-result', content: [] }] } }),
      eventOf('tool/result', { message: { content: [] } }),
      eventOf('assistant/message', {
        message: { content: [{ type: 'text', text: 'hi' }, { type: 'reasoning', text: 'think' }, { type: 'tool-call', name: 'read', arguments: {} }] },
      }),
      eventOf('user/message', { content: [{ type: 'text', text: 'ask' }] }),
    ];
    const rows = collectSessionMessages(events as never);
    expect(rows).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'reasoning', text: 'think' },
      { type: 'tool', tool: 'read', args: {} },
      { type: 'text', text: 'ask' },
    ]);
  });
});
