/**
 * 内存 mock subagents（测试专用，非发布面）。
 *
 * 提供 `startContinuable`/`followup`/`interrupt`/`start` 等价语义：`startContinuable`
 * 记录委派请求并 resolve 为 `{ childId, messageId }`（inbox 接受即 resolve）。以
 * `ctx.provide('subagents', …)` 注入。
 *
 * **settle 仿真**（对齐 DSH `SubagentContinuationManager`）：continuable 子代理「完成 =
 * settle」。本 mock 不后台驱动 settle——由测试经 `settleChild(childId, stopReason)`
 * 显式触发（模拟子代理自然完成/出错）；`interrupt` 自动 settle(`aborted`)（模拟 DSH
 * interrupt → 子代理静止 → settle 销毁）。settle 经 `sandore/subagent-settled` 事件
 * 发射，供 workflow-engine 的 `awaitSubagentSettlement`（`ctx.on('sandore/subagent-settled')`）
 * 路由到对应 childId 的等待者——与真实 DSH `subagent/end`→`sandore/subagent-settled`
 * 转译同一通道。`followup`（settle 后）模拟 cold-resume：状态回 `running`，等待测试
 * 再次 `settleChild`（续跑产出）。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/subagents
 */
import type { Context } from '@deepseek-ai/cordis';
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
  SubagentSettlement,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-sandore-microflow/src/subagents';

/** 一次 `followup` 调用的记录。 */
export interface FakeFollowup {
  parent: Agent;
  childId: SessionId;
  content: ContentBlock[];
  options: SubagentFollowupOptions;
}

/** 可续接子代理状态机状态：`running` 活跃、`interrupted` 被 interrupt（已 settle aborted）。 */
export type FakeChildStatus = 'running' | 'interrupted';

/** 内存 mock subagents：记录调用、维护 interrupt→settle 状态机、发射 settle 事件。 */
export class FakeSubagents implements SubagentRuntime {
  readonly continuableStarts: ContinuableStartSpec[] = [];
  readonly followups: FakeFollowup[] = [];
  readonly interrupts: Array<{ targetSessionId: SessionId; authority: SubagentInterruptAuthority }> = [];
  readonly startCalls: Array<{ name: string; request: SubagentStartRequest }> = [];
  readonly listChildrenCalls: Array<{ parentSessionId: SessionId; signal?: AbortSignal }> = [];
  /** 已发射的 settle 事件载荷（按发射顺序，供断言）。 */
  readonly settlements: Array<SubagentSettlement> = [];
  /** 可选：followup 抛错注入（缺陷 11 测试：recover() followup 失败落 failed）。 */
  followupError: Error | undefined = undefined;
  private readonly childParent = new Map<SessionId, SessionId>();
  private readonly childStates = new Map<SessionId, FakeChildStatus>();

  constructor(
    private readonly ctx?: Context,
    /** 取活子代理（auto-settle 判定 status 用；测试 harness 注入 `(id) => agents.get(id)`）。 */
    private readonly getAgent?: (id: SessionId) => { readonly status: 'idle' | 'running'; readonly session: { readonly events: readonly { type: string }[] } } | undefined,
  ) {}

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    this.continuableStarts.push(spec);
    const index = this.continuableStarts.length;
    const childId = `child-${index}`;
    this.childParent.set(childId, spec.request.parent.id);
    this.childStates.set(childId, 'running');
    // 真实 DSH：子代理静止（idle + 无 owned children + 无 accepted）即 settle。mock 无真实
    // LLM，以 `child.status === 'idle'` 为「子代理已跑完」代理信号——`startContinuable` 后
    // 若 child 已 idle（测试预填输出 / 空输出跑完）即自动 settle(completed)；`running`（挂起
    // /暂停测试）则不自动 settle，由测试 `settleChild`/`interrupt` 驱动。经 `sandore/
    // subagent-settled` 事件 + 引擎缓冲路由（buffer 解决早于 awaiter 的竞态）。
    this.maybeAutoSettle(childId);
    return { childId, messageId: `msg-${index}` };
  }

  async followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId> {
    if (this.followupError !== undefined) {
      throw this.followupError;
    }
    this.followups.push({ parent, childId, content, options });
    // cold-resume 仿真：settle 后的 followup 重建 Activation，状态回 running。
    this.childStates.set(childId, 'running');
    // 若 child 已 idle（续跑产出 / 空输出跑完），自动 settle(completed) 模拟续跑完成。
    this.maybeAutoSettle(childId);
    return `msg-${this.followups.length}`;
  }

  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.interrupts.push({ targetSessionId, authority });
    this.childStates.set(targetSessionId, 'interrupted');
    // 模拟 DSH interrupt → 子代理静止 → settle(aborted)：自动发射 settle 事件。
    // 真实 DSH 中 `SubagentContinuationManager.interrupt` 发 `agent.cancel` 后，
    // `watchSettlement` 观察到静止即 dispose + notifySettlement(aborted) + emit subagent/end。
    this.emitSettlement({ childId: targetSessionId, stopReason: 'aborted' });
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

  /**
   * 测试手动触发子代理 settle（模拟自然完成/出错）。发射 `sandore/subagent-settled`
   * 事件，供 workflow-engine `awaitSubagentSettlement` 路由。`output` 缺省时由
   * `collectSubagentOutput` 回退 `finalAssistantOutput(child.session.events)` 读取。
   */
  settleChild(childId: SessionId, stopReason: SubagentStopReason, output?: readonly ContentBlock[]): void {
    this.childStates.set(childId, stopReason === 'completed' ? 'running' : 'interrupted');
    this.emitSettlement({
      childId,
      stopReason,
      ...(output === undefined ? {} : { output }),
    });
  }

  /** 发射 `sandore/subagent-settled` 事件（与 DSH 适配层 `subagent/end`→本事件同通道）。 */
  private emitSettlement(settlement: SubagentSettlement): void {
    this.settlements.push(settlement);
    if (this.ctx === undefined) return;
    // 与 sandore `emitContained` 同形：unscoped dispatch，同 ctx 的 `ctx.on` 监听器接收。
    for (const callback of this.ctx.events.dispatch('emit', ['sandore/subagent-settled', settlement])) {
      try {
        const returned: unknown = callback(settlement);
        void Promise.resolve(returned).catch(() => {});
      } catch {
        // 监听器异常不应影响 mock 状态机。
      }
    }
  }

  /**
   * 若 `child.status === 'idle'`（子代理已跑完），自动 settle(completed) 模拟真实 DSH
   * 子代理静止即 settle。经微任务延迟（让 collectSubagentOutput 先注册 awaiter 或落入引擎
   * 缓冲）。`running`（挂起/暂停测试）则不自动 settle——由测试 `settleChild`/`interrupt` 驱动。
   */
  private maybeAutoSettle(childId: SessionId): void {
    if (this.getAgent === undefined) return;
    const child = this.getAgent(childId);
    if (child === undefined || child.status !== 'idle') return;
    queueMicrotask(() => {
      const latest = this.getAgent?.(childId);
      if (latest !== undefined && latest.status === 'idle') {
        this.settleChild(childId, 'completed');
      }
    });
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
