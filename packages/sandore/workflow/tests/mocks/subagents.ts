/**
 * 内存 mock subagents（测试专用，非发布面）。
 *
 * 提供 `startContinuable`/`followup`/`interrupt`/`start` 等价语义：`startContinuable`
 * 记录委派请求并 resolve 为 `{ childId, messageId }`（inbox 接受即 resolve）。以
 * `ctx.provide('subagents', …)` 注入。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/subagents
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import type {
  Agent,
  ContinuableStart,
  ContinuableStartSpec,
  MessageId,
  SessionId,
  SubagentFollowupOptions,
  SubagentInterruptAuthority,
  SubagentResult,
  SubagentRun,
  SubagentRuntime,
  SubagentStartRequest,
} from '../../../microflow/src/subagents.ts';

/** 一次 `followup` 调用的记录。 */
export interface FakeFollowup {
  parent: Agent;
  childId: SessionId;
  content: ContentBlock[];
  options: SubagentFollowupOptions;
}

/** 内存 mock subagents：记录调用并可注入行为。 */
export class FakeSubagents implements SubagentRuntime {
  readonly continuableStarts: ContinuableStartSpec[] = [];
  readonly followups: FakeFollowup[] = [];
  readonly interrupts: Array<{ targetSessionId: SessionId; authority: SubagentInterruptAuthority }> = [];
  readonly startCalls: Array<{ name: string; request: SubagentStartRequest }> = [];

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    this.continuableStarts.push(spec);
    const index = this.continuableStarts.length;
    return { childId: `child-${index}`, messageId: `msg-${index}` };
  }

  async followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId> {
    this.followups.push({ parent, childId, content, options });
    return `msg-${this.followups.length}`;
  }

  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.interrupts.push({ targetSessionId, authority });
  }

  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    this.startCalls.push({ name, request });
    const result: SubagentResult = { output: [], stopReason: 'completed' };
    return {
      id: `run-${this.startCalls.length}`,
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: async () => {},
    };
  }
}
