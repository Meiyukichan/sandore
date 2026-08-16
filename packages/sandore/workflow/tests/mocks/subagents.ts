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
  SubagentListEntry,
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

/** 可续接子代理状态机状态：`running` 活跃、`interrupted` 被 interrupt。 */
export type FakeChildStatus = 'running' | 'interrupted';

/** 内存 mock subagents：记录调用并维护 interrupt→followup 状态机。 */
export class FakeSubagents implements SubagentRuntime {
  readonly continuableStarts: ContinuableStartSpec[] = [];
  readonly followups: FakeFollowup[] = [];
  readonly interrupts: Array<{ targetSessionId: SessionId; authority: SubagentInterruptAuthority }> = [];
  readonly startCalls: Array<{ name: string; request: SubagentStartRequest }> = [];
  readonly listChildrenCalls: Array<{ parentSessionId: SessionId; signal?: AbortSignal }> = [];
  /** interrupt 触发的 whenIdle 取消回调注册表（childId → 使挂起 whenIdle Promise reject 的钩子）。 */
  readonly whenIdleCancels = new Map<SessionId, () => void>();
  private readonly childParent = new Map<SessionId, SessionId>();
  private readonly childStates = new Map<SessionId, FakeChildStatus>();

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    this.continuableStarts.push(spec);
    const index = this.continuableStarts.length;
    const childId = `child-${index}`;
    this.childParent.set(childId, spec.request.parent.id);
    this.childStates.set(childId, 'running');
    return { childId, messageId: `msg-${index}` };
  }

  async followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId> {
    this.followups.push({ parent, childId, content, options });
    this.childStates.set(childId, 'running');
    return `msg-${this.followups.length}`;
  }

  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.interrupts.push({ targetSessionId, authority });
    this.childStates.set(targetSessionId, 'interrupted');
    // interrupt 联动 whenIdle 取消：命中注册钩子即拒绝挂起的 whenIdle Promise（模拟 cancel）。
    this.whenIdleCancels.get(targetSessionId)?.();
  }

  async listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]> {
    this.listChildrenCalls.push(signal === undefined ? { parentSessionId } : { parentSessionId, signal });
    const entries: SubagentListEntry[] = [];
    for (const [id, state] of this.childStates) {
      if (this.childParent.get(id) !== parentSessionId) continue;
      entries.push({
        kind: 'child',
        id,
        activity: state === 'running' ? 'running' : 'inactive',
        hasChildren: false,
        mode: 'continuable',
        label: 'test child',
      });
    }
    return entries;
  }

  /** 查询某可续接子代理当前状态（`startContinuable` 后为 running，interrupt 后为 interrupted）。 */
  childStatus(childId: SessionId): FakeChildStatus | undefined {
    return this.childStates.get(childId);
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
