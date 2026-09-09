/**
 * 恢复协调器（重试三模式 + 崩溃恢复的纯协调器）。
 *
 * `RecoveryManager` 是「纯协调器」：不持有引擎状态，仅经注入的选项/回调访问宿主
 * 主代理、子代理投递/`agents.create`、`sessions.fork`/`sessions.get`、
 * `readState`/`commitState`（不可变重建 + 持久化）与 `emitStepRetried`（事件双发）。
 * 它负责重试/恢复的「决策与准备」：前置校验、状态清理、`RetryRecord` 历史、子代理
 * 会话准备（continue 同会话 / revert 安全边界 fork / fork 全量 fork），随后把真正的
 * 执行（whenIdle + finalAssistantOutput + finalize + DAG 推进）交给引擎注入的
 * `resumeExecution` 续跑。上游适配：`ctx.subagents.followup` 已删，`followup` 注入
 * 包装改由引擎经 queue 投递通道（subagent-delivery.ts）实现。
 *
 * 重试三模式：`continue` 同会话 `followup`（sessionId 不变）；`revert` 计算最后一个
 * 闭合 turn 的末事件 seq 作安全边界（或用用户传入的 `revertBoundary` 选更早闭合 turn）
 * → `sessions.fork(childId, boundary)` 取前缀 → `agents.create({ seed: forked.events,
 * sessionId: 新合成 childId })`（新 session id，`parentSessionId` 记旧值）；`fork` 省略
 * boundary 保留全量历史（尾部未闭合时自动回退到最后一个闭合 turn/end 防 OPEN_TURN）
 * → `agents.create({ seed })` 新 agent 续跑。三模式共用重试续跑循环：置 `running` →
 * 清残留字段 → `RetryRecord` 入 `retryHistory` → 发射 `sandore/step-retried` →
 * followup/续跑 → `resumeExecution`。仅 `failed` Step 可重试（completed 实例/Step
 * 返回无害 no-op），执行中抛 `INVALID_OPERATION`。
 *
 * 崩溃恢复：`recover()` 按快照 `executedSteps` 分类处理——合成 session（shell）
 * 标 `failed`、仅对第一个 `running`/`interacting` 子代理 Step `followup` 冷恢复（与引擎
 * 单步续跑收口一致）、`paused` 交由引擎从 `pausedChildIds` 重建登记表等待手动 resume。
 * @module @meiyukichan/dsh-sandore/workflow/src/recovery-manager
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

import type { Agent, AgentHandle, CreateAgentOptions } from '../microflow/subagents';
import { SandoreError } from './errors.ts';
import type { RetryRecord, UserMessageRecord, WorkflowTaskState } from './schema.ts';

/** 重试三模式。 */
export type RetryMode = 'continue' | 'revert' | 'fork';

/** 已执行 Step 的运行时形状（与状态快照 `executedSteps` 元素严格一致）。 */
type ExecutedStep = WorkflowTaskState['executedSteps'][number];

/** fork 源会话最小结构（仅需 `events`，用于安全边界计算与 seed 提取）。 */
export interface ForkSourceSession {
  readonly events: readonly SessionEvent[];
}

/** revert 回退点候选：一个闭合 turn 的末事件 seq + turn 编号 + assistant 文本预览。 */
export interface RevertBoundaryOption {
  /** 闭合 turn 的 `turn/end` 事件 seq（传给 `retryStep` 的 `revertBoundary`）。 */
  readonly seq: number;
  /** turn 编号（事件 `data.turn`；展示用「Turn N+1」）。 */
  readonly turn: number;
  /** 该 turn 内 assistant 文本块预览（前 80 字符；无 assistant 文本则为空串）。 */
  readonly preview: string;
}

/** 单实例恢复例程的分类结果（供引擎决定是否重跑主循环）。 */
export interface RecoverResult {
  /** 存在可续跑的子代理 Step（running/interacting 已 followup 冷恢复）。 */
  readonly hasResume: boolean;
  /** 存在合成 session Step（shell，已标 failed，实例不可恢复续跑）。 */
  readonly hasFailure: boolean;
}

/** 恢复协调器的依赖（全部经回调/选项注入，保持纯协调器可单测）。 */
export interface RecoveryManagerOptions {
  /** 引擎级取消信号（followup 的 `options.signal`）。 */
  readonly signal: AbortSignal;
  /** 读当前完整状态快照。 */
  readonly readState: () => WorkflowTaskState;
  /** 不可变重建 + 持久化当前状态快照。 */
  readonly commitState: (next: WorkflowTaskState) => void;
  /** 追加一条用户指令消息（写入 `state.userMessages` 并持久化）。 */
  readonly appendUserMessage: (record: UserMessageRecord) => void;
  /** 子代理 prompt 投递的注入包装（已绑定宿主主代理作 parent；引擎经 queue 投递通道实现）。 */
  readonly followup: (childId: string, content: ContentBlock[], signal: AbortSignal) => Promise<void> | void;
  /** `ctx.agents.create` 的注入包装（revert/fork 创建带 seed 的新子代理）。 */
  readonly createAgent: (options: CreateAgentOptions) => Promise<AgentHandle>;
  /** `ctx.sessions.get` 的注入包装（安全边界计算读子代理事件流）。 */
  readonly getSession: (id: string) => ForkSourceSession | undefined;
  /**
   * 子代理 live 判定（`ctx.agents.get` 的注入包装；可选）。
   *
   * 注入时 retryStep 在产生新段前 fail-fast（F1）：failed Step 的子代理 settle 即被
   * DSH dispose（continuable 状态注销），followup 对已销毁会话会挂起（曾 40min 无
   * 终态）或抛 NOT_RESUMABLE——目标 live 判定失败直接抛可读错误，不产生虚假重试段。
   * 未注入（纯依赖单测）时放行，保持旧语义。
   */
  readonly getAgent?: (childId: string) => Agent | undefined;
  /**
   * 子代理会话 fork 的注入包装（boundary 省略 = 全量历史）。
   *
   * 2026-08-25 real-e2e：改异步——live 已移除（子代理 settle/dispose）时从持久化
   * 回退读事件（`ctx.sessions.fork` 只认 live，直接抛 SESSION_NOT_FOUND）。
   */
  readonly forkSession: (source: string, boundary?: number) => ForkSourceSession | Promise<ForkSourceSession>;
  /** 双发 `sandore/step-retried` 事件（含 Step 名称与可选循环迭代路径）。 */
  readonly emitStepRetried: (stepId: string, mode: RetryMode, name: string, loopIteration?: number[]) => void;
  /** 重试/恢复后的续跑执行（whenIdle + finalAssistantOutput + finalize + DAG 推进）。 */
  readonly resumeExecution: () => Promise<void>;
}

/** Step 终态集合（completed 实例/Step 的 no-op 判定）。 */
const TERMINAL_STEP_STATUSES: ReadonlySet<ExecutedStep['status']> = new Set(['completed', 'failed']);

/** 当前 ISO 时间戳。 */
function now(): string {
  return new Date().toISOString();
}

/** 文本 ContentBlock 的构造。 */
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

/** 合成新子代理 SessionId（纯 UUID 格式）。 */
export function synthesizeChildId(_stepId: string): string {
  return globalThis.crypto.randomUUID();
}

/**
 * 计算 revert 模式的安全 turn 边界：最后一个闭合 turn 的末事件 seq。
 *
 * 事件流中 `turn/end` 标记一个闭合 turn 的结束；若事件流无任何 `turn/end`（整个
 * 会话处于未闭合 turn），返回 `undefined`（revert 以错误结束）。fork 前据此截取前缀
 * 可避免 DSH `sessions.fork` 的 `OPEN_TURN` 校验失败。
 * @param events - 子代理会话事件流（含 `turn/start`/`turn/end` 边界事件）。
 * @returns 最后一个闭合 turn 的末事件 seq，或无法取到合法闭合 turn 时为 `undefined`。
 */
export function computeSafeRevertBoundary(events: readonly SessionEvent[]): number | undefined {
  let lastClosedTurnEndSeq: number | undefined;
  for (const event of events) {
    if (event.type === 'turn/end') {
      lastClosedTurnEndSeq = event.seq;
    }
  }
  return lastClosedTurnEndSeq;
}

/**
 * 判定会话事件流尾部是否存在未闭合 turn（最后一个 turn 边界为 `turn/start` 而非 `turn/end`）。
 *
 * DSH `sessions.fork` 默认 boundary（=最后事件 seq）在未闭合尾部下确定性抛 `OPEN_TURN`：
 * 只要末事件落在某个 `turn/start` 之后且无匹配 `turn/end`，fork(undefined) 即失败。
 * `retryStep` 的 fork 模式据此自动回退到最后一个闭合 turn/end，避免「子代理 turn 未闭合即失败」
 * 的常见场景下直接抛错。
 * @param events - 子代理会话事件流（含 `turn/start`/`turn/end` 边界事件）。
 * @returns 末事件落在未闭合 turn 内为 true。
 */
export function hasUnclosedTurnTail(events: readonly SessionEvent[]): boolean {
  let lastTurnBoundaryType: string | undefined;
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      lastTurnBoundaryType = event.type;
    }
  }
  return lastTurnBoundaryType === 'turn/start';
}

/** 从 assistant/message 事件提取纯文本（仅 text 块；其余块忽略）。 */
function assistantTextOf(event: SessionEvent): string {
  const message = (event.data as { message?: { content?: ReadonlyArray<{ type: string; text?: string }> } } | undefined)?.message;
  if (message === undefined) return '';
  const content = message.content ?? [];
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('');
}

/** 截断至 max 字符（超出加省略号）。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 列出会话事件流中所有闭合 turn 的回退点候选（UI revert 回退点选择的数据源）。
 *
 * 遍历事件，按 turn/start → … → turn/end 配对；每个闭合 turn 产出一个候选，
 * `seq` = 该 turn/end 的事件 seq，`turn` = 该 turn 编号，`preview` = turn 内
 * assistant 文本块拼接的前 80 字符。未闭合的尾部 turn（有 turn/start 无 turn/end）
 * 不产出候选（与 `computeSafeRevertBoundary` 语义一致）。
 * @param events - 子代理会话事件流。
 * @returns 闭合 turn 回退点候选列表（按事件 seq 升序）。
 */
export function listClosedTurnBoundaries(events: readonly SessionEvent[]): RevertBoundaryOption[] {
  const options: RevertBoundaryOption[] = [];
  let currentTurn: number | undefined;
  let currentPreview = '';
  for (const event of events) {
    if (event.type === 'turn/start') {
      currentTurn = (event.data as { turn?: number } | undefined)?.turn ?? 0;
      currentPreview = '';
    } else if (event.type === 'assistant/message') {
      const text = assistantTextOf(event);
      if (text === '') continue;
      currentPreview = currentPreview === '' ? text : `${currentPreview}\n${text}`;
    } else if (event.type === 'turn/end') {
      if (currentTurn !== undefined) {
        options.push({ seq: event.seq, turn: currentTurn, preview: truncate(currentPreview, 80) });
      }
      currentTurn = undefined;
      currentPreview = '';
    }
  }
  return options;
}

/**
 * 恢复协调器。
 *
 * 持有注入的依赖，实现 `retryStep`（三模式重试）与 `recover`（Step 分类恢复）；
 * 状态更新以「不可变重建 + commitState」落到引擎 `active.state` 与持久化快照。
 */
export class RecoveryManager {
  constructor(private readonly deps: RecoveryManagerOptions) {}

  /**
   * 重试单个 failed Step（continue/revert/fork 三模式共用续跑循环）。
   *
   * 前置校验：实例 completed 或 Step completed → 无害 no-op（不抛错、不改状态）；
   * Step running/interacting/paused → 抛 `INVALID_OPERATION`；仅 failed 可重试。
   * 随后清残留字段 + 置 running + 追加 `RetryRecord`（result 先 `running`）+ 发射
   * `sandore/step-retried`，按模式准备子代理会话（continue 不变 / revert 安全边界
   * fork + 新 agent / fork 全量 fork + 新 agent），followup 后 `resumeExecution`
   * 续跑，最后据实际结果更新 `retryHistory` 末条 result。
   * @param stepId - 待重试 Step 的定义 id（或唯一执行 id）。
   * @param mode - 重试模式。
   * @param message - 重试附带的提示消息。
   * @param revertBoundary - 可选：revert 模式用户所选闭合 turn/end 的事件 seq；
   *   省略 = 最后一个闭合 turn/end（默认兼容，与改造前行为一致）。
   */
  async retryStep(stepId: string, mode: RetryMode, message: string, revertBoundary?: number): Promise<void> {
    const state = this.deps.readState();
    if (state.status === 'completed') {
      // completed 实例：结构化 no-op（不抛错、不改变状态）。
      return;
    }
    const step = findStep(state.executedSteps, stepId);
    if (step === undefined) {
      throw new SandoreError(`step '${stepId}' not found`, 'INVALID_OPERATION');
    }
    if (step.status === 'completed') {
      return;
    }
    if (step.status !== 'failed') {
      throw new SandoreError(`step '${stepId}' is '${step.status}', only failed steps can be retried`, 'INVALID_OPERATION');
    }
    // shell 合成 session 无真实子代理可续跑：前置拦截（与 recover 分类语义一致），
    // 避免 commitRunningStep/emitStepRetried/retryHistory 产生虚假重试历史与事件。
    if (!isSubagentStep(step)) {
      throw new SandoreError(`step '${stepId}' is not a resumable subagent step (shell cannot be retried)`, 'INVALID_OPERATION');
    }
    // F1（rc.1 dispose 语义）：failed Step 的子代理 settle 即被 DSH dispose 并移出
    // agents registry——continuable 状态注销，followup 会对已销毁会话挂起（曾 40min
    // 无终态）或抛 NOT_RESUMABLE。注入 getAgent 时预检目标会话 live：已销毁 →
    // fail-fast（在 commit 任何新段/事件之前），给可读错误而非卡死或误导性失败。
    if (this.deps.getAgent !== undefined && this.deps.getAgent(childIdOf(step)) === undefined) {
      throw new SandoreError(
        `step '${stepId}' 的子代理会话已销毁（DSH 0.1.2-rc.1 对已结算子代理 dispose，无法续跑），不能重试；请重新运行该 Step/实例`,
        'INVALID_OPERATION',
      );
    }

    // 1. 以 failed 段为基底追加新段（保留旧 failed 段定格快照）+ RetryRecord 入新段 retryHistory。
    const retryRecord: RetryRecord = { mode, timestamp: now(), userMessage: message, result: 'running' };
    const cleaned = cleanStepResidue(step);
    const newSegmentId = globalThis.crypto.randomUUID();
    let runningStep: ExecutedStep = {
      ...cleaned,
      id: newSegmentId,
      attemptIndex: (cleaned.attemptIndex ?? 0) + 1,
      createdAt: now(),
      startedAt: now(),
      status: 'running',
      retryHistory: [...(cleaned.retryHistory ?? []), retryRecord],
    };
    this.commitRunningStep(state, runningStep);
    this.deps.appendUserMessage({
      id: `usr-${globalThis.crypto.randomUUID()}`,
      kind: 'retry',
      target: stepIdOf(step),
      content: message,
      createdAt: now(),
    });
    this.deps.emitStepRetried(stepIdOf(step), mode, step.name, step.loopIteration);

    // 2. 按模式准备子代理会话（revert/fork 需 fork + 新 agent + 更新 childId/parentSessionId）。
    let childId = childIdOf(step);
    try {
      if (mode === 'revert' || mode === 'fork') {
        const sourceEvents = this.deps.getSession(childId)?.events ?? [];
        let boundary: number | undefined;
        if (mode === 'revert') {
          // revert 回退点可选：用户传入的 revertBoundary（闭合 turn/end seq）优先；
          // 省略时回退到 computeSafeRevertBoundary（最后一个闭合 turn/end，默认兼容）。
          boundary = revertBoundary ?? computeSafeRevertBoundary(sourceEvents);
          if (boundary === undefined) {
            throw new SandoreError(
              `cannot revert step '${stepId}': no closed turn boundary in child session`,
              'INVALID_OPERATION',
            );
          }
        } else {
          // fork 防御（必要，非可选）：源会话存在未闭合尾部时 fork(undefined) 确定性
          // 抛 OPEN_TURN（DSH sessions.fork 默认 boundary=末事件 seq，末事件落在未闭合
          // turn 内即拒绝）。检测到未闭合尾部时自动回退到最后一个闭合 turn/end
          // （对齐 computeSafeRevertBoundary 语义）；源会话无任何闭合 turn 时仍抛错
          // （无法安全 fork）。源会话尾部已闭合时 boundary 保持 undefined（全量历史）。
          if (hasUnclosedTurnTail(sourceEvents)) {
            boundary = computeSafeRevertBoundary(sourceEvents);
            if (boundary === undefined) {
              throw new SandoreError(
                `cannot fork step '${stepId}': source session has an open turn tail with no closed turn to fall back to`,
                'INVALID_OPERATION',
              );
            }
          }
        }
        const forked = await this.deps.forkSession(childId, boundary);
        const newChildId = synthesizeChildId(stepIdOf(step));
        // 上游适配：meta 删 seedLength（会话头校验显式拒绝），改 `isSeeded: true` +
        // 顶层 `inheritedEventCount`。parentSession 传源 childId（审计语义）；引擎的
        // createAgent 包装会覆盖为宿主主代理 id（DSH lineage 校验要求）。
        await this.deps.createAgent({
          sessionId: newChildId,
          meta: { origin: 'subagent', parentSession: childId, isSeeded: true },
          inheritedEventCount: forked.events.length,
          seed: forked.events,
        });
        // 更新 sessionMeta.childId 为新 session id，parentSessionId 记旧值。
        // 注意：此处是同 id 段的原地更新（upsert），不能再用 commitRunningStep（append）——
        // 否则 executedSteps 会出现两个同 id 段。
        const sessionMeta = {
          ...(runningStep.sessionMeta ?? { command: 'agent' as const, synthetic: false }),
          childId: newChildId,
          synthetic: false,
        };
        runningStep = { ...runningStep, sessionMeta, parentSessionId: childId };
        this.commitStep(this.deps.readState(), runningStep);
        childId = newChildId;
      }
      await this.deps.followup(childId, textBlock(message), this.deps.signal);
    } catch (error) {
      // 会话准备或 followup 失败：回退新段/工作流为 failed 并记录失败结果，保持可重试。
      this.failRetry(newSegmentId);
      throw error;
    }

    // 3. 续跑执行（whenIdle + finalAssistantOutput + finalize + DAG 推进）。
    try {
      await this.deps.resumeExecution();
    } catch (error) {
      this.failRetry(newSegmentId);
      throw error;
    }

    // 4. 据实际结果更新新段 retryHistory 末条 result。
    const finalState = this.deps.readState();
    const finalStep = findStep(finalState.executedSteps, newSegmentId);
    const result = finalStep?.status === 'completed' ? 'completed' : 'failed';
    this.setRetryResult(newSegmentId, result);
  }

  /**
   * 单实例恢复例程的 Step 分类处理（崩溃恢复）。
   *
   * 遍历快照 `executedSteps`：`running`/`interacting` 的子代理 Step 经 `followup`
   * 冷恢复（absent child 自动从持久化 Session 恢复）；合成 session（shell）
   * 无真实子代理，标记 `failed`（不可恢复）；`completed`/`failed`/`paused` 无需处理
   * （paused 登记表由引擎从 `pausedChildIds` 重建，等待手动 resume）。
   * @returns 分类结果（是否有可续跑子代理 / 是否有合成 session 失败）。
   */
  async recover(): Promise<RecoverResult> {
    const state = this.deps.readState();
    const coldResumePrompt = '请从崩溃前的断点继续完成当前任务。';
    const running = state.executedSteps.filter(step => step.status === 'running' || step.status === 'interacting');

    // shell 合成 session：子进程已丢失，标 failed（不可恢复）。
    let hasFailure = false;
    for (const step of running) {
      if (isSubagentStep(step)) {
        continue;
      }
      this.commitStep(this.deps.readState(), { ...step, status: 'failed', error: 'synthetic session is not recoverable' });
      hasFailure = true;
    }

    // 缺陷 10 多路恢复：遍历全部 running/interacting 子代理 Step 逐个 followup
    // （对齐基准恢复 E 步）。并发落地后多个 Step 同时 running 为常态——全部 followup，
    // 不再只取第一个（原 `.find()` 只取首条属防御性代码，并发后变真实缺陷）。
    // 合成 session 失败时整体失败，不发起 followup。
    let hasResume = false;
    if (!hasFailure) {
      const resumeSteps = running.filter(isSubagentStep);
      for (const resumeStep of resumeSteps) {
        const childId = childIdOf(resumeStep);
        await this.deps.followup(childId, textBlock(coldResumePrompt), this.deps.signal);
        hasResume = true;
      }
    }
    return { hasResume, hasFailure };
  }

  /** 不可变重建状态：更新单个 Step（按唯一执行 id 定位，不改实例状态）+ updatedAt。 */
  private commitStep(prev: WorkflowTaskState, step: ExecutedStep): void {
    this.deps.commitState({
      ...prev,
      executedSteps: prev.executedSteps.map(item => (item.id === step.id ? step : item)),
      updatedAt: now(),
    });
  }

  /** 重试发起：追加新执行段（保留旧 failed 段定格快照）并置实例 running + updatedAt。 */
  private commitRunningStep(prev: WorkflowTaskState, step: ExecutedStep): void {
    this.deps.commitState({
      ...prev,
      status: 'running',
      executedSteps: [...prev.executedSteps, step],
      updatedAt: now(),
    });
  }

  /** 重试会话准备/续跑失败：Step 回退 failed、实例 failed，记录 retryHistory 末条 result=failed。 */
  private failRetry(stepId: string): void {
    const state = this.deps.readState();
    const step = findStep(state.executedSteps, stepId);
    if (step === undefined) {
      return;
    }
    const retryHistory = markLastRetryResult(step.retryHistory ?? [], 'failed');
    this.deps.commitState({
      ...state,
      status: 'failed',
      executedSteps: state.executedSteps.map(item =>
        item.id === stepId ? { ...item, status: 'failed' as const, retryHistory } : item,
      ),
      updatedAt: now(),
    });
  }

  /** 更新 retryHistory 末条记录的 result。 */
  private setRetryResult(stepId: string, result: RetryRecord['result']): void {
    const state = this.deps.readState();
    const step = findStep(state.executedSteps, stepId);
    if (step === undefined || step.retryHistory === undefined || step.retryHistory.length === 0) {
      return;
    }
    const retryHistory = markLastRetryResult(step.retryHistory, result);
    this.deps.commitState({
      ...state,
      executedSteps: state.executedSteps.map(item => (item.id === stepId ? { ...item, retryHistory } : item)),
      updatedAt: now(),
    });
  }
}

/** 从 executedSteps 中按定义 stepId 或唯一执行 id 反查 Step。 */
function findStep(steps: readonly ExecutedStep[], stepId: string): ExecutedStep | undefined {
  return steps.find(step => step.stepId === stepId) ?? steps.find(step => step.id === stepId);
}

/** 反查 Step 的子代理 SessionId（缺省回退唯一执行 id）。 */
function childIdOf(step: ExecutedStep): string {
  return step.sessionMeta?.childId ?? step.id;
}

/** Step 对外展示 id（定义 stepId，缺省回退唯一执行 id）。 */
function stepIdOf(step: ExecutedStep): string {
  return step.stepId ?? step.id;
}

/** 判定 Step 是否为可续接子代理 Step（agent/skill/mcp/prompt，非 shell 合成 session）。 */
function isSubagentStep(step: ExecutedStep): boolean {
  const command = step.sessionMeta?.command ?? step.command?.type;
  return command === 'agent' || command === 'skill' || command === 'mcp' || command === 'prompt';
}

/** 清除上一轮重试的残留字段（暂停细节/门禁评估现场；保留 sessionMessages 供消息框展示）。 */
function cleanStepResidue(step: ExecutedStep): ExecutedStep {
  const {
    pausedAt: _pausedAt,
    pauseEntryId: _pauseEntryId,
    finalizeMeta: _finalizeMeta,
    ...rest
  } = step;
  return rest as ExecutedStep;
}

/** 更新 retryHistory 末条记录的 result（返回新数组）。 */
function markLastRetryResult(history: readonly RetryRecord[], result: RetryRecord['result']): RetryRecord[] {
  if (history.length === 0) {
    return [];
  }
  return history.map((record, index) => (index === history.length - 1 ? { ...record, result } : record));
}
