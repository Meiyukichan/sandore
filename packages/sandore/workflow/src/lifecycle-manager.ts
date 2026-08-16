/**
 * 生命周期协调器（单步/全局暂停与恢复的纯协调器）。
 *
 * `LifecycleManager` 是暂停/恢复能力的「纯协调器」：不持有引擎状态，仅经注入的
 * 回调/选项访问宿主主代理、`subagents.interrupt`/`followup`、`readState`/
 * `commitState`（不可变重建 + 持久化）、`emitStepPaused`/`emitStepResumed`（事件
 * 双发）与暂停登记表读写。暂停登记表（内存 `Set<string>`，值 = 子代理 SessionId）
 * 是「暂停集」的唯一权威，与 `WorkflowTaskState.pausedChildIds` 数组同步（登记即
 * add + 持久化，恢复即 delete + 持久化）；`Agent.status`（仅 `idle|running`，无
 * paused 态）不能替代登记表查询。
 *
 * 单步暂停：`executedSteps[].sessionMeta.childId` 反查子代理 SessionId →
 * `interrupt(childId, { kind: 'ancestor', agent: hostAgent })` → 登记表 add →
 * Step 置 `paused`（`pausedAt`）→ 持久化 → 双发 `sandore/step-paused`。已空闲
 * Step（`agent.status === 'idle' && !inbox.hasPending`）幂等 no-op；不存在/终态
 * Step 抛 `SandoreError('INVALID_OPERATION')`。单步恢复：反查 childId → 移出登记表
 * → `followup(hostAgent, childId, text(resumePrompt ?? 默认提示))` → Step 置
 * `running`（`resumedAt`/`resumePrompt`）→ 持久化 → 双发 `sandore/step-resumed`；
 * 非登记 Step 抛 `INVALID_OPERATION`。
 * @module @deepseek-ai/dsh-sandore-workflow/src/lifecycle-manager
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import type { Agent, SubagentInterruptAuthority } from '../../microflow/src/subagents.ts';
import { SandoreError } from './errors.ts';
import type { WorkflowTaskState } from './schema.ts';
import type { StepStatus } from './types.ts';

/** 已执行 Step 的运行时形状（与状态快照 `executedSteps` 元素严格一致）。 */
type ExecutedStep = WorkflowTaskState['executedSteps'][number];

/** Step 终态集合：暂停对终态 Step 抛 `INVALID_OPERATION`。 */
const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set(['completed', 'failed']);

/** 恢复提示词的缺省值（`resumeStep`/`resumeAllSteps` 未显式提供时使用）。 */
const DEFAULT_RESUME_PROMPT = '请继续完成当前任务。';

/** 当前 ISO 时间戳。 */
function now(): string {
  return new Date().toISOString();
}

/** 生命周期协调器的依赖（全部经回调/选项注入，保持纯协调器可单测）。 */
export interface LifecycleManagerOptions {
  /** 宿主主代理（interrupt 的 ancestor authority + followup 的 parent 三合一）。 */
  readonly hostAgent: Agent;
  /** 暂停登记表初始值（startInstance 为空，崩溃恢复时从快照 `pausedChildIds` 重建）。 */
  readonly initialPausedChildIds: readonly string[];
  /** `ctx.subagents.interrupt` 的注入包装。 */
  readonly interrupt: (childId: string, authority: SubagentInterruptAuthority) => void;
  /** `ctx.subagents.followup` 的注入包装。 */
  readonly followup: (childId: string, content: ContentBlock[], signal: AbortSignal) => Promise<void> | void;
  /** 按 childId 查活子代理（空闲幂等 no-op 判定用）。 */
  readonly getAgent: (childId: string) => Agent | undefined;
  /** 引擎级取消信号（followup 的 `options.signal`）。 */
  readonly signal: AbortSignal;
  /** 读当前完整状态快照。 */
  readonly readState: () => WorkflowTaskState;
  /** 不可变重建 + 持久化当前状态快照。 */
  readonly commitState: (next: WorkflowTaskState) => void;
  /** 双发 `sandore/step-paused` 事件。 */
  readonly emitStepPaused: (stepId: string, childId: string) => void;
  /** 双发 `sandore/step-resumed` 事件。 */
  readonly emitStepResumed: (stepId: string, childId: string, resumePrompt?: string) => void;
}

/**
 * 生命周期协调器。
 *
 * 持有暂停登记表（内存 `Set`），通过注入的依赖驱动单步/全局暂停与恢复；状态更新
 * 以「不可变重建 + commitState」落到引擎 `active.state` 与持久化快照。
 */
export class LifecycleManager {
  private readonly pausedChildIds: Set<string>;

  constructor(private readonly deps: LifecycleManagerOptions) {
    this.pausedChildIds = new Set(deps.initialPausedChildIds);
  }

  /** 暂停登记表当前内容（子代理 SessionId 集合，仅只读投影）。 */
  get pausedIds(): readonly string[] {
    return [...this.pausedChildIds];
  }

  /** 某子代理 SessionId 是否在暂停登记表中。 */
  hasPaused(childId: string): boolean {
    return this.pausedChildIds.has(childId);
  }

  /** 暂停单个 Step（经 childId 反查 + interrupt + 登记表 add + 状态 paused + 事件）。 */
  pauseStep(stepId: string): void {
    const step = this.findStep(stepId);
    if (step === undefined) {
      throw new SandoreError(`step '${stepId}' not found`, 'INVALID_OPERATION');
    }
    if (this.isNonSubagentCommand(step)) {
      // shell/prompt Step（sessionMeta.synthetic 合成占位，无真实子代理）不可暂停：
      // interrupt 一个无活代理 id 是静默 no-op，会误标 paused（假暂停）。直接拒绝。
      throw new SandoreError(
        `step '${stepId}' is a non-subagent step (${step.command?.type}) and cannot be paused`,
        'INVALID_OPERATION',
      );
    }
    if (TERMINAL_STEP_STATUSES.has(step.status)) {
      throw new SandoreError(`step '${stepId}' is in terminal state '${step.status}'`, 'INVALID_OPERATION');
    }
    const childId = this.childIdOf(step);
    if (this.pausedChildIds.has(childId)) {
      // 已在登记表：重复暂停幂等 no-op（避免重复 interrupt / 重复标记）。
      return;
    }
    const child = this.deps.getAgent(childId);
    if (child !== undefined && child.status === 'idle' && !child.inbox.hasPending) {
      // 目标子代理恰好在 interrupt 前完成（空闲且 inbox 无 pending）：幂等 no-op，
      // 不产生中断副作用、不误标 paused（按 Step 实际完成状态处理）。
      return;
    }
    this.deps.interrupt(childId, { kind: 'ancestor', agent: this.deps.hostAgent });
    this.pausedChildIds.add(childId);
    this.commitStepStatus(step, 'paused', { pausedAt: now() });
    this.deps.emitStepPaused(this.stepIdOf(step), childId);
  }

  /** 恢复单个 Step（反查 childId + 移出登记表 + followup + 状态 running + 事件）。 */
  async resumeStep(stepId: string, resumePrompt?: string): Promise<void> {
    const step = this.findStep(stepId);
    if (step === undefined) {
      throw new SandoreError(`step '${stepId}' not found`, 'INVALID_OPERATION');
    }
    const childId = this.childIdOf(step);
    if (!this.pausedChildIds.has(childId)) {
      throw new SandoreError(`step '${stepId}' is not paused`, 'INVALID_OPERATION');
    }
    const content: ContentBlock[] = [{ type: 'text', text: resumePrompt ?? DEFAULT_RESUME_PROMPT }];
    await this.deps.followup(childId, content, this.deps.signal);
    this.pausedChildIds.delete(childId);
    this.commitStepStatus(step, 'running', {
      resumedAt: now(),
      ...(resumePrompt === undefined ? {} : { resumePrompt }),
    });
    this.deps.emitStepResumed(this.stepIdOf(step), childId, resumePrompt);
  }

  /** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
  pauseAllSteps(): void {
    const targets = this.deps.readState().executedSteps.filter(
      step =>
        (step.status === 'running' || step.status === 'interacting') &&
        !this.isNonSubagentCommand(step),
    );
    for (const step of targets) {
      this.pauseStep(this.stepIdOf(step));
    }
  }

  /** 恢复登记表内全部 Step（逐个 followup，完成后登记表清空）。 */
  async resumeAllSteps(resumePrompt?: string): Promise<void> {
    const childIds = [...this.pausedChildIds];
    for (const childId of childIds) {
      const step = this.findStepByChildId(childId);
      if (step === undefined) {
        continue;
      }
      await this.resumeStep(this.stepIdOf(step), resumePrompt);
    }
  }

  /** 按 stepId（定义 id 或唯一执行 id）在 executedSteps 中反查 Step。 */
  private findStep(stepId: string): ExecutedStep | undefined {
    const steps = this.deps.readState().executedSteps;
    return steps.find(step => step.stepId === stepId) ?? steps.find(step => step.id === stepId);
  }

  /** 按子代理 SessionId 反查 Step（`resumeAllSteps` 遍历登记表用）。 */
  private findStepByChildId(childId: string): ExecutedStep | undefined {
    const steps = this.deps.readState().executedSteps;
    return steps.find(step => this.childIdOf(step) === childId);
  }

  /** 反查 Step 的子代理 SessionId（缺省回退唯一执行 id）。 */
  private childIdOf(step: ExecutedStep): string {
    return step.sessionMeta?.childId ?? step.id;
  }

  /** 判定 Step 是否为非子代理命令（shell/prompt 合成占位，无真实子代理，不可暂停）。 */
  private isNonSubagentCommand(step: ExecutedStep): boolean {
    const type = step.command?.type;
    return type === 'shell' || type === 'prompt';
  }

  /** Step 对外展示 id（定义 stepId，缺省回退唯一执行 id）。 */
  private stepIdOf(step: ExecutedStep): string {
    return step.stepId ?? step.id;
  }

  /** 不可变重建状态：更新单个 Step 状态 + 同步登记表 + 持久化。 */
  private commitStepStatus(
    step: ExecutedStep,
    status: StepStatus,
    extra: { pausedAt?: string; resumedAt?: string; resumePrompt?: string },
  ): void {
    const state = this.deps.readState();
    const next: WorkflowTaskState = {
      ...state,
      status: this.pausedChildIds.size > 0 ? 'paused' : 'running',
      executedSteps: state.executedSteps.map(item => {
        if (item.id !== step.id) {
          return item;
        }
        return {
          ...item,
          status,
          ...(extra.pausedAt === undefined ? {} : { pausedAt: extra.pausedAt }),
          ...(extra.resumedAt === undefined ? {} : { resumedAt: extra.resumedAt }),
          ...(extra.resumePrompt === undefined ? {} : { resumePrompt: extra.resumePrompt }),
        };
      }),
      pausedChildIds: [...this.pausedChildIds],
      updatedAt: now(),
    };
    this.deps.commitState(next);
  }
}
