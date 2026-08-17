/**
 * sandore 工作流引擎运行时（Stage 级线性主循环）。
 *
 * `SandoreEngineRuntime` 继承 {@link SandoreEngine}：`startInstance` 异步完成
 * 读定义 → parse → 生成 instanceId → 初始化 pending 快照 → `ctx.agents.create`
 * 创建宿主主代理（setup 注册 8 个 `sandore_*` 工具）→ fire-and-forget
 * `execute`；`execute` 以 Stage 级线性主循环编排（StageExecutor 执行 Stage 内
 * Step → 收集 StageContract → `tryAdvanceStage` 跟随 `Stage.next`）。每次状态
 * 变化 `persistState` 并双发 `sandore/*` 事件（`ctx.emit` + 宿主 Session
 * `append`）；每个 Step 完成后经 `onPersist` 钩子立即追加到
 * `state.executedSteps` 并持久化；`childId = step-{stepId}-{execId 前 8 位}`
 * 合成 sessionMeta。
 * @module @deepseek-ai/dsh-sandore-workflow/src/workflow-engine
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session';
// 加载 @deepseek-ai/dsh-session-title 的 Cordis 面声明（使 `ctx.sessionTitle` 类型可用）。
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title';
import z from '@deepseek-ai/schemastery';

import { WorkflowDagNavigator } from './dag-navigator.ts';
import { SandoreError } from './errors.ts';
import { createHostAgentSetup } from './host-agent.ts';
import { InteractionManager } from './interaction-manager.ts';
import { LifecycleManager } from './lifecycle-manager.ts';
import type { SandorePersistence } from './persistence.ts';
import { RecoveryManager } from './recovery-manager.ts';
import type { RetryMode } from './recovery-manager.ts';
import type { WorkflowDefinition, WorkflowTaskState, WorkflowStage } from './schema.ts';
import { SandoreEngine } from './seam.ts';
import type { SandoreConfig } from './seam.ts';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionPayload,
  DagResultInfo,
  DagRun,
  DagRunInfo,
  DagStartRequest,
  DagInstanceState,
  ExecutedStepDefault,
  PendingPermissionEntry,
  PendingQuestionEntry,
  StageContract,
  StepStatus,
} from './types.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

import { FinalizeManager } from '@deepseek-ai/dsh-sandore-microflow/src/finalize-manager';
import { StageExecutor } from '@deepseek-ai/dsh-sandore-microflow/src/stage-executor';
import type { StageExecutorResume, StageStepHooks } from '@deepseek-ai/dsh-sandore-microflow/src/stage-executor';
import type { StepRunnerConfig } from '@deepseek-ai/dsh-sandore-microflow/src/step-runner';
import type { Agent } from '@deepseek-ai/dsh-sandore-microflow/src/subagents';

/** 运行中的实例（控制器 + 宿主 Session + 宿主主代理 + 定义 + 状态快照 + 交互管理器）。 */
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly hostAgent: Agent;
  readonly definition: WorkflowDefinition;
  readonly interactions: InteractionManager;
  readonly lifecycle: LifecycleManager;
  readonly recovery: RecoveryManager;
  state: WorkflowTaskState;
  /** resume 请求标志：resumeStep/resumeAllSteps 触发，主循环 paused 等待时消费。 */
  resumeRequested: boolean;
  /** 主循环 paused 等待 resume 的 waiter 集合（resume 触发时 resolve）。 */
  resumeWaiters: Array<() => void>;
}

/** 实例终态集合：`abortInstance` 对终态实例拒绝操作。 */
const TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted']);

/** 渲染任意抛出值为可读消息。 */
function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 当前 ISO 时间戳。 */
function now(): string {
  return new Date().toISOString();
}

/** 从 executedSteps 中定位处于 interacting 且携带 ask 载荷的 Step。 */
function findAskStep(
  steps: WorkflowTaskState['executedSteps'],
): { step: WorkflowTaskState['executedSteps'][number]; payload: AskUserQuestionPayload } | undefined {
  for (const step of steps) {
    const payload = step.finalizeMeta?.assessResult?.askQuestion;
    if (step.status === 'interacting' && payload !== undefined) {
      return { step, payload };
    }
  }
  return undefined;
}

/** 生成 `YYYYMMDD-HHmmss-xxx` 实例 ID。 */
function makeInstanceId(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const suffix = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 3);
  return `${datePart}-${timePart}-${suffix}`;
}

/** 构造实例初始（pending）状态快照。 */
function makeInitialState(options: {
  readonly instanceId: string;
  readonly request: DagStartRequest;
  readonly definition: WorkflowDefinition;
  readonly createdAt: string;
  readonly cwd: string;
}): WorkflowTaskState {
  const { instanceId, request, definition, createdAt, cwd } = options;
  return {
    taskId: instanceId,
    jobId: request.jobId,
    workflowId: request.workflowId,
    cwd,
    status: 'pending',
    originalInput: request.originalInput,
    currentStageId: definition.stages[0]?.id ?? '',
    executedSteps: [],
    stageInfos: definition.stages.map(stage => ({ id: stage.id, name: stage.name, status: 'blocked' })),
    pendingInteractions: [],
    pendingQueue: [],
    visitCounts: {},
    passThroughVars: {},
    activeLoopIterationStack: [],
    activeLoopNodeId: null,
    activeLoopStack: [],
    pausedChildIds: [],
    stageContracts: {},
    createdAt,
    updatedAt: createdAt,
  };
}

/** 从完整状态快照投影 `DagInstanceState`（引擎 `getState` 的返回形状）。 */
function toDagInstanceState(state: WorkflowTaskState): DagInstanceState {
  return {
    taskId: state.taskId,
    jobId: state.jobId,
    workflowId: state.workflowId,
    status: state.status,
    originalInput: state.originalInput,
    currentStageId: state.currentStageId,
    // 存储 schema 的 executedSteps（output 为宽松 JSON 形状）与 browser-safe
    // DagInstanceState（output 为 dsh-llm ContentBlock[]）结构兼容，仅类型更窄。
    executedSteps: state.executedSteps as unknown as DagInstanceState['executedSteps'],
    stageInfos: state.stageInfos,
    pendingQueue: state.pendingQueue,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * 工作流引擎运行时。
 *
 * 作为 workflow 包默认导出：实现 11 个实例级生命周期方法
 * （start/recover/abort/reply/pause/resume/retry/getState），其中 8 个
 * 交互/生命周期/恢复方法转调 interaction/lifecycle/recovery 三管理器。
 */
export default class SandoreEngineRuntime extends SandoreEngine {
  static Config: z<SandoreConfig> = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    maxConcurrentSteps: z.natural().default(0),
    defaultProvider: z.string(),
    defaultModel: z.string(),
  });

  static inject = ['sessions', 'sessionPersistence', 'subagents', 'agents', 'llm', 'shell', 'fs', 'storageDomain', 'sandorePersistence', 'userQuestions', 'sessionTitle'];

  private readonly instances = new Map<string, ActiveInstance>();

  constructor(ctx: Context, private readonly config: SandoreConfig) {
    super(ctx);
  }

  /** 启动时（Cordis Service.init）自动扫描并恢复孤儿实例（崩溃恢复启动扫描）。 */
  protected async [Service.init](): Promise<void> {
    await this.recoverOrphanedInstances();
  }

  /** 启动实例：读定义 → parse → 初始化 pending 快照 → 创建宿主主代理 → fire-and-forget 执行。 */
  async startInstance(request: DagStartRequest): Promise<DagRun> {
    const persistence = this.persistence();
    if (persistence === undefined) {
      throw new SandoreError('sandore persistence is not available', 'INVALID_OPERATION');
    }
    const record = persistence.definitions.get(request.workflowId);
    if (record === undefined) {
      throw new SandoreError(`definition '${request.workflowId}' not found`, 'NODE_NOT_FOUND');
    }
    const definition = parseWorkflowYaml(record.yaml);
    const instanceId = makeInstanceId();
    const createdAt = now();
    const cwd = request.cwd ?? '/tmp';
    const state = makeInitialState({ instanceId, request, definition, createdAt, cwd });
    const controller = new AbortController();
    // 经 agents.create 创建宿主主代理（setup 在发布前注册 8 个 sandore_* 工具并注入
    // 编排器角色说明）；setup 抛错时 agents.create 回滚，此处的 await 会向上抛出。
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(instanceId),
      meta: { cwd },
      setup: createHostAgentSetup({ instanceId, engine: this }),
    });
    const hostAgent = handle.agent;
    // agents.create 已把宿主 Session 发布进 ctx.sessions，此处读回 live 会话用于事件双发。
    const session = this.ctx.sessions.get(SessionId(instanceId));
    if (session === undefined) {
      throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
    }
    // 补设宿主会话标题（source=user 优先于 DSH fallback 自动摘要）；rename 失败仅记录
    // warn，不得使 startInstance 失败或中断实例执行。
    try {
      this.ctx.sessionTitle.rename(session, `工作流实例 ${instanceId}`);
    } catch (error) {
      this.ctx.logger.warn(`sandore: set host session title failed: ${renderError(error)}`);
    }
    const active = this.buildActiveInstance(controller, session, hostAgent, definition, state);
    this.instances.set(instanceId, active);
    void this.persistState(active);
    void this.execute(instanceId);
    return { instanceId, status: 'running' };
  }

  /** 查询实例的当前状态快照（内存活跃实例优先，state 表兜底读）。 */
  getState(instanceId: string): DagInstanceState {
    const active = this.instances.get(instanceId);
    if (active !== undefined) {
      return toDagInstanceState(active.state);
    }
    // 内存未命中（如进程重启后）回退到持久化 state 表读回最后快照。
    const persisted = this.persistence()?.state.get(instanceId);
    if (persisted === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    return toDagInstanceState(persisted);
  }

  /**
   * 中止运行中的实例：置中止标志 → 登记表内全部子代理 interrupt（ancestor）→
   * 实例 aborted 终态（保留持久化快照）→ 双发 `sandore/aborted` → 清理内存
   * ActiveInstance（getState 退回 state 表仍可读到 aborted 快照）。
   */
  async abortInstance(instanceId: string): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      // 内存已清理（先前中止）：回退持久化 state 表判断终态，保持 INVALID_OPERATION 语义。
      const persisted = this.persistence()?.state.get(instanceId);
      if (persisted !== undefined && TERMINAL_STATUSES.has(persisted.status)) {
        throw new SandoreError(`instance '${instanceId}' is already in terminal state '${persisted.status}'`, 'INVALID_OPERATION');
      }
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(active.state.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, 'INVALID_OPERATION');
    }

    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };

    // 置中止标志（主循环观察到 signal.aborted 后退出）。
    active.controller.abort();
    // 中止传播：对暂停登记表内全部子代理执行 interrupt（ancestor authority）。
    for (const childId of active.lifecycle.pausedIds) {
      this.ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: active.hostAgent });
    }
    // 实例 aborted 终态（清理前落盘，保证清理后 getState 仍能读到 aborted 快照）。
    active.state = { ...active.state, status: 'aborted', updatedAt: now() };
    await this.persistState(active);
    this.emitAborted(active.session, info);
    // 清理内存 ActiveInstance（保留持久化快照）。
    this.instances.delete(instanceId);
  }

  /**
   * 恢复单个实例（崩溃恢复入口）。
   *
   * 对终态实例抛 `INVALID_OPERATION`；内存未命中时从持久化 state 表读回快照，经
   * `ctx.agents.resume` 冷恢复宿主主代理（setup 重跑）→ `recovery.recover()` 分类恢复
   * Step（running/interacting 子代理 followup 冷恢复、合成 session 标 failed）→ 重建
   * 登记表 → 重跑 `runInstance` 续跑，返回 `DagRun`。
   */
  async recoverInstance(instanceId: string): Promise<DagRun> {
    const existing = this.instances.get(instanceId);
    if (existing !== undefined) {
      if (TERMINAL_STATUSES.has(existing.state.status)) {
        throw new SandoreError(`instance '${instanceId}' is already in terminal state '${existing.state.status}'`, 'INVALID_OPERATION');
      }
      return { instanceId, status: existing.state.status };
    }
    const persistence = this.persistence();
    if (persistence === undefined) {
      throw new SandoreError('sandore persistence is not available', 'INVALID_OPERATION');
    }
    const snapshot = persistence.state.get(instanceId);
    if (snapshot === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(snapshot.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${snapshot.status}'`, 'INVALID_OPERATION');
    }
    const record = persistence.definitions.get(snapshot.workflowId);
    if (record === undefined) {
      throw new SandoreError(`definition '${snapshot.workflowId}' not found`, 'NODE_NOT_FOUND');
    }
    const definition = parseWorkflowYaml(record.yaml);
    const controller = new AbortController();
    // 冷恢复宿主主代理（resume 重跑 setup 注册 8 个 sandore_* 工具 + instanceId 闭包）。
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(instanceId),
      setup: createHostAgentSetup({ instanceId, engine: this }),
    });
    const hostAgent = handle.agent;
    const session = this.ctx.sessions.get(SessionId(instanceId));
    if (session === undefined) {
      throw new SandoreError(`host session '${instanceId}' was not published`, 'INVALID_OPERATION');
    }
    const active = this.buildActiveInstance(controller, session, hostAgent, definition, snapshot);
    this.instances.set(instanceId, active);
    await this.persistState(active);

    const recoverResult = await active.recovery.recover();
    if (recoverResult.hasFailure) {
      active.state = { ...active.state, status: 'failed', updatedAt: now() };
      await this.persistState(active);
      return { instanceId, status: 'failed' };
    }
    if (recoverResult.hasResume) {
      void this.resumeExecution(active);
      return { instanceId, status: 'running' };
    }
    // paused-only 实例：登记表已从 pausedChildIds 重建，保持 paused 等待手动 resume，不重跑。
    if (this.hasPausedStep(active)) {
      return { instanceId, status: active.state.status };
    }
    // 空 executedSteps / 纯 completed 非终态快照（startInstance 后、任何 Step 执行前崩溃）：
    // 真正重跑 runInstance 从 currentStageId 续跑（不永久 running）。
    active.state = { ...active.state, status: 'running', updatedAt: now() };
    await this.persistState(active);
    void this.resumeExecution(active);
    return { instanceId, status: 'running' };
  }

  /**
   * 孤儿实例启动扫描：遍历 state 表全部条目 → 跳过终态 → 逐个调用
   * `recoverInstance`。单实例失败不阻断（逐实例 try/catch），返回
   * `{ recovered, errors }`。
   */
  async recoverOrphanedInstances(): Promise<{
    recovered: string[];
    errors: Array<{ instanceId: string; error: string }>;
  }> {
    const recovered: string[] = [];
    const errors: Array<{ instanceId: string; error: string }> = [];
    const persistence = this.persistence();
    if (persistence === undefined) {
      return { recovered, errors };
    }
    for (const [instanceId, snapshot] of persistence.state.entries()) {
      if (TERMINAL_STATUSES.has(snapshot.status)) {
        continue;
      }
      try {
        await this.recoverInstance(instanceId);
        recovered.push(instanceId);
      } catch (error) {
        errors.push({ instanceId, error: renderError(error) });
      }
    }
    return { recovered, errors };
  }

  async replyQuestion(instanceId: string, requestId: string, answers: AskUserQuestionAnswer): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    await active.interactions.replyQuestion(requestId, answers);
  }

  async replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    await active.interactions.replyPermission(requestId, reply);
  }

  /** 暂停单个 Step（委托生命周期协调器：反查 childId → interrupt → 登记表 → 状态 paused）。 */
  async pauseStep(instanceId: string, stepId: string): Promise<void> {
    const active = this.requireActive(instanceId);
    active.lifecycle.pauseStep(stepId);
  }

  /** 恢复单个 Step（委托生命周期协调器：反查 childId → 移出登记表 → followup → 状态 running）。 */
  async resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void> {
    const active = this.requireActive(instanceId);
    await active.lifecycle.resumeStep(stepId, resumePrompt);
    this.notifyResume(active);
  }

  /** 暂停实例内全部 running/interacting Step（completed/failed 与非子代理 Step 跳过）。 */
  async pauseAllSteps(instanceId: string): Promise<void> {
    const active = this.requireActive(instanceId);
    active.lifecycle.pauseAllSteps();
  }

  /** 恢复登记表内全部 Step（逐个 followup 并清空登记表）。 */
  async resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void> {
    const active = this.requireActive(instanceId);
    await active.lifecycle.resumeAllSteps(resumePrompt);
    this.notifyResume(active);
  }

  /** 重试单个 Step（continue/revert/fork 三模式，委托恢复协调器）。 */
  async retryStep(instanceId: string, stepId: string, mode: RetryMode, message: string): Promise<void> {
    const active = this.requireActive(instanceId);
    await active.recovery.retryStep(stepId, mode, message);
  }

  // ── 执行主体 ─────────────────────────────────────────────────────────────

  private async execute(instanceId: string): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      return;
    }
    await this.runAndCatch(active, false);
  }

  /** 重试/恢复后的续跑执行（复用 runInstance 主循环，从快照续跑，不重发 start）。 */
  private async resumeExecution(active: ActiveInstance): Promise<void> {
    await this.runAndCatch(active, true);
  }

  /** 运行主循环并兜底引擎级故障为 failed 终态。 */
  private async runAndCatch(active: ActiveInstance, isResume: boolean): Promise<void> {
    try {
      await this.runInstance(active, isResume);
    } catch (error) {
      // 引擎级意外故障（非 Step 失败）：响亮落为 failed 终态。
      active.state = { ...active.state, status: 'failed', updatedAt: now() };
      await this.persistState(active);
      const info: DagRunInfo = {
        taskId: active.state.taskId,
        workflowId: active.state.workflowId,
        jobId: active.state.jobId,
      };
      this.emitEnd(active.session, info, {
        taskId: active.state.taskId,
        jobId: active.state.jobId,
        status: 'failed',
        error: renderError(error),
      });
    }
  }

  private async runInstance(active: ActiveInstance, isResume = false): Promise<void> {
    const { controller, session, hostAgent, definition } = active;
    const signal = controller.signal;
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };

    if (!isResume) {
      active.state = { ...active.state, status: 'running', updatedAt: now() };
      await this.persistState(active);
      this.emitStart(session, info);
    }

    const runnerConfig = this.runnerConfig(definition, hostAgent, active);
    // 从快照播种执行位置：优先续跑 running/interacting Step 所在 Stage（崩溃恢复/重试），
    // 否则回退 currentStageId；已完成 Stage 契约一并播种（DAG 续跑不重跑已完成 Stage）。
    const navigator = new WorkflowDagNavigator(
      definition,
      this.ctx,
      runnerConfig,
      { activeLoopStack: active.state.activeLoopStack, activeLoopIterationStack: active.state.activeLoopIterationStack },
      { currentStageId: this.resumeStageId(active), stageContracts: active.state.stageContracts },
    );
    const loopManager = navigator.loopManagerInstance;
    /** 当前循环迭代路径（无活跃循环时省略，供 step-* 事件 payload 使用）。 */
    const currentLoopIteration = (): number[] | undefined => {
      const path = loopManager.buildLoopIterationPath();
      return path.length > 0 ? path : undefined;
    };
    const finalizeManager = new FinalizeManager(this.ctx, runnerConfig);
    let stageId = navigator.currentNodeId;

    while (stageId !== '') {
      const stage = definition.stages.find(item => item.id === stageId);
      if (stage === undefined) {
        break;
      }

      this.markStageStatus(active, stageId, 'running');
      await this.persistState(active);
      this.emitStageStart(session, info, stageId);

      const hooks: StageStepHooks = {
        onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId, step.name ?? step.id, currentLoopIteration()),
        onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output, step.name ?? step.id, currentLoopIteration()),
        onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error, step.name ?? step.id, currentLoopIteration()),
      };

      const resumeFrom = this.resumeInfo(active, stage);

      const executor = new StageExecutor({
        ctx: this.ctx,
        stageDef: stage,
        workflowDef: definition,
        input: {
          originalInput: active.state.originalInput,
          contractArtifacts: navigator.getContractArtifacts(),
          passThroughVars: active.state.passThroughVars,
        },
        sharedState: {
          cwd: active.state.cwd,
          jobId: active.state.jobId,
          taskId: active.state.taskId,
        },
        runnerConfig,
        signal,
        hooks,
        loopManager,
        finalizeManager,
        resolveNextNodes: (nodeId, context) => navigator.resolveNextNodes(nodeId, context),
        visitCounts: active.state.visitCounts,
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
        onPersist: async (executed) => {
          // 逐 Step 持久化：每个 Step 完成后立即追加/更新到 executedSteps 并落盘。
          // 按唯一执行 id upsert，避免 ask 回复续跑时同一 Step（interacting → completed）
          // 被重复追加；崩溃恢复时无需等待 Stage 结束即可读到已完成 Step 快照。
          const entry = executed as unknown as WorkflowTaskState['executedSteps'][number];
          const index = active.state.executedSteps.findIndex(item => item.id === entry.id);
          active.state = {
            ...active.state,
            executedSteps:
              index >= 0
                ? active.state.executedSteps.map((item, i) => (i === index ? entry : item))
                : [...active.state.executedSteps, entry],
            updatedAt: now(),
          };
          await this.persistState(active);
        },
      });

      let result = await executor.execute();

      // 交互/暂停循环：ask 回复或 pause→resume 后从断点续跑（重跑门禁 + 推进剩余 Step），
      // 直至 Stage 完成或失败。
      while (result.status === 'interacting' || result.status === 'paused') {
        if (result.status === 'interacting') {
          // Step 收尾判定为 ask：Step 进入 interacting，等待用户回复。
          this.markStageStatus(active, stageId, 'interacting');
          active.state = { ...active.state, status: 'interacting', updatedAt: now() };
          await this.persistState(active);

          const ask = findAskStep(active.state.executedSteps);
          if (ask === undefined) {
            // 无 ask 载荷（异常收尾）：保持 interacting，等待后续恢复机制。
            return;
          }
          const entry: PendingQuestionEntry = {
            id: ask.step.id,
            stageId: ask.step.stageId,
            stepId: ask.step.stepId ?? ask.step.id,
            sessionId: active.state.taskId,
            requestId: globalThis.crypto.randomUUID(),
            kind: 'question',
            status: 'pending',
            payload: ask.payload,
            createdAt: now(),
          };
          await active.interactions.ask({ entry, ...(signal === undefined ? {} : { signal }) });
        } else {
          // Step 被 interrupt 打断且命中暂停登记表：等待 resumeStep/resumeAllSteps 的
          // followup 续跑（D-3「命中则等待 resume 的 followup Promise」），不落 failed、
          // 不推进下一 Stage、不发射 step-failed。
          await this.waitForResume(active);
        }

        // 中止可能在 paused 等待期命中（waitForResume 与 signal.aborted 竞争后返回）：
        // 直接退出循环，交由下方 aborted 处理分支落终态。
        if (signal.aborted) {
          break;
        }

        // 回复/恢复后从断点续跑：executor 重跑门禁审查并推进剩余 Step。
        result = await executor.execute();
      }

      if (signal.aborted) {
        // aborted 处理分支：paused 等待期命中（waitForResume 与 signal.aborted 竞争后
        // 退出循环，result 仍为 'paused'）或 Step 因中止失败（result 为 'failed'）。
        // abortInstance 已落 aborted 态并双发 sandore/aborted，此处仅在尚未落态时兜底
        // （`active.state.status !== 'aborted'` 守卫避免 sandore/aborted 双发）。
        this.markStageStatus(active, stageId, 'failed');
        if (active.state.status !== 'aborted') {
          active.state = { ...active.state, status: 'aborted', updatedAt: now() };
          await this.persistState(active);
          this.emitAborted(session, info);
        }
        return;
      }

      // executedSteps 已通过 onPersist 逐 Step 追加/更新并持久化，此处仅合并透传变量。
      active.state = {
        ...active.state,
        passThroughVars: { ...active.state.passThroughVars, ...result.passThroughVars },
        updatedAt: now(),
      };

      if (result.status === 'failed') {
        this.markStageStatus(active, stageId, 'failed');
        active.state = {
          ...active.state,
          status: 'failed',
          stageContracts: { ...active.state.stageContracts, [stageId]: result.stageContract },
          updatedAt: now(),
        };
        await this.persistState(active);
        this.emitEnd(session, info, {
          taskId: info.taskId,
          jobId: info.jobId,
          status: 'failed',
          ...(result.errorDetail === undefined ? {} : { error: result.errorDetail }),
        });
        return;
      }

      const stageContract: StageContract = result.stageContract;

      this.markStageStatus(active, stageId, 'completed');
      navigator.setStageContract(stageId, stageContract);
      active.state = {
        ...active.state,
        currentStageId: stageId,
        stageContracts: { ...active.state.stageContracts, [stageId]: stageContract },
        updatedAt: now(),
      };
      await this.persistState(active);
      this.emitStageCompleted(session, info, stageId, stageContract);

      if (!navigator.tryAdvanceStage()) {
        stageId = '';
      } else {
        stageId = navigator.currentNodeId;
      }
    }

    active.state = { ...active.state, status: 'completed', updatedAt: now() };
    await this.persistState(active);
    this.emitEnd(session, info, { taskId: info.taskId, jobId: info.jobId, status: 'completed' });
  }

  // ── 状态辅助 ─────────────────────────────────────────────────────────────

  private markStageStatus(active: ActiveInstance, stageId: string, status: StepStatus): void {
    active.state = {
      ...active.state,
      stageInfos: active.state.stageInfos.map(item => (item.id === stageId ? { ...item, status } : item)),
    };
  }

  private runnerConfig(definition: WorkflowDefinition, hostAgent: Agent, active: ActiveInstance): StepRunnerConfig {
    return {
      defaultTimeoutMs: this.config.defaultTimeoutMs ?? 7200000,
      ...(this.config.defaultProvider === undefined ? {} : { defaultProvider: this.config.defaultProvider }),
      ...(this.config.defaultModel === undefined ? {} : { defaultModel: this.config.defaultModel }),
      skills: definition.skills,
      mcps: definition.mcps,
      agents: definition.agents,
      hostAgent,
      onChildStarted: (stepId, childId) => {
        // 子代理真实 childId 就绪：把 running Step 的 sessionMeta 从合成占位切换为
        // 真实子代理 SessionId（暂停反查 childId 依赖该字段）。
        const entry = active.state.executedSteps.find(item => item.stepId === stepId && item.status === 'running');
        if (entry === undefined || entry.sessionMeta === undefined) {
          return;
        }
        const sessionMeta = { ...entry.sessionMeta, childId, synthetic: false };
        active.state = {
          ...active.state,
          executedSteps: active.state.executedSteps.map(item => (item.id === entry.id ? { ...item, sessionMeta } : item)),
          updatedAt: now(),
        };
        void this.persistState(active);
      },
      isPausedChild: (childId) => active.lifecycle.hasPaused(childId),
      onDelegatedAsk: async ({ childId, output, stepId, stageId }) => {
        // 子代理 final result 含 [[SANDORE_ASK]] 标记块：解析 + 转接引擎级 ask，
        // 答案经 interactions.followup 注回子代理（microflow 续跑后重新取 final output）。
        const result = await active.interactions.delegateSubagentAsk({
          childId,
          output,
          stageId,
          stepId,
          sessionId: active.state.taskId,
          ...(active.controller.signal === undefined ? {} : { signal: active.controller.signal }),
        });
        return result.delegated;
      },
    };
  }

  /** 构造完整 ActiveInstance（交互/生命周期/恢复三个管理器 + 宿主主代理 + 状态快照）。 */
  private buildActiveInstance(
    controller: AbortController,
    session: Session,
    hostAgent: Agent,
    definition: WorkflowDefinition,
    state: WorkflowTaskState,
  ): ActiveInstance {
    let active!: ActiveInstance;
    const interactions = new InteractionManager({
      hostAgent,
      userQuestions: () => this.ctx.get('userQuestions'),
      persist: (entries) => {
        active.state = { ...active.state, pendingInteractions: entries, updatedAt: now() };
        void this.persistState(active);
      },
      emitQuestion: (entry) => this.emitQuestion(session, active, entry),
      emitPermission: (entry) => this.emitPermission(session, active, entry),
      followup: async (childId, content) => {
        await this.ctx.subagents.followup(hostAgent, childId, content, {
          source: { kind: 'user' },
          signal: controller.signal,
        });
      },
    });
    const lifecycle = new LifecycleManager({
      hostAgent,
      initialPausedChildIds: state.pausedChildIds,
      interrupt: (childId, authority) => this.ctx.subagents.interrupt(childId, authority),
      followup: async (childId, content, signal) => {
        await this.ctx.subagents.followup(hostAgent, childId, content, {
          source: { kind: 'user' },
          signal,
        });
      },
      getAgent: (childId) => this.ctx.agents.get(childId) ?? undefined,
      signal: controller.signal,
      readState: () => active.state,
      commitState: (next) => {
        active.state = next;
        void this.persistState(active);
      },
      emitStepPaused: (stepId, childId, name, loopIteration) => this.emitStepPaused(session, active, stepId, childId, name, loopIteration),
      emitStepResumed: (stepId, childId, resumePrompt, name, loopIteration) => this.emitStepResumed(session, active, stepId, childId, resumePrompt, name, loopIteration),
    });
    const recovery = new RecoveryManager({
      signal: controller.signal,
      readState: () => active.state,
      commitState: (next) => {
        active.state = next;
        void this.persistState(active);
      },
      followup: async (childId, content, signal) => {
        await this.ctx.subagents.followup(hostAgent, childId, content, {
          source: { kind: 'user' },
          signal,
        });
      },
      createAgent: (options) => this.ctx.agents.create(options),
      getSession: (id) => {
        const child = this.ctx.sessions.get(SessionId(id));
        return child === undefined ? undefined : { events: child.events };
      },
      forkSession: (source, boundary) => {
        const child = this.ctx.sessions.fork(SessionId(source), boundary);
        return { events: child.events };
      },
      emitStepRetried: (stepId, mode, name, loopIteration) => this.emitStepRetried(session, active, stepId, mode, name, loopIteration),
      resumeExecution: () => this.resumeExecution(active),
    });
    active = {
      controller,
      session,
      hostAgent,
      definition,
      interactions,
      lifecycle,
      recovery,
      state,
      resumeRequested: false,
      resumeWaiters: [],
    };
    return active;
  }

  /** 快照是否含 paused Step（paused-only 实例等待手动 resume，不自动重跑）。 */
  private hasPausedStep(active: ActiveInstance): boolean {
    return active.state.executedSteps.some(step => step.status === 'paused');
  }

  /** 续跑执行位置的起始 Stage：running/interacting Step 所在 Stage，否则 currentStageId。 */
  private resumeStageId(active: ActiveInstance): string {
    const resumeStep = active.state.executedSteps.find(
      step => step.status === 'running' || step.status === 'interacting',
    );
    return resumeStep?.stageId ?? active.state.currentStageId;
  }

  /** 计算 Stage 续跑播种：跳过已完成 Step 并从 running/interacting 子代理 Step 续跑。 */
  private resumeInfo(active: ActiveInstance, stage: WorkflowStage): StageExecutorResume | undefined {
    const stageSteps = active.state.executedSteps.filter(step => step.stageId === stage.id);
    const resumeStep = stageSteps.find(step => step.status === 'running' || step.status === 'interacting');
    if (resumeStep === undefined) {
      return undefined;
    }
    const stepDef = stage.steps.find(step => step.id === (resumeStep.stepId ?? resumeStep.id));
    if (stepDef === undefined) {
      return undefined;
    }
    return {
      // 快照 executedSteps 为 schema 派生类型（可选字段 `| undefined`），此处收窄为
      // StageExecutor 内部的 browser-safe ExecutedStepDefault（与 onPersist 桥接一致）。
      completedSteps: stageSteps
        .filter(step => step.id !== resumeStep.id && step.status === 'completed') as unknown as ExecutedStepDefault[],
      resumeSubagent: {
        step: stepDef,
        executed: resumeStep as unknown as ExecutedStepDefault,
        childId: resumeStep.sessionMeta?.childId ?? resumeStep.id,
      },
    };
  }

  private persistence(): SandorePersistence | undefined {
    return this.ctx.get('sandorePersistence');
  }

  /** 取内存活跃实例；未命中抛 `NODE_NOT_FOUND`。 */
  private requireActive(instanceId: string): ActiveInstance {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    return active;
  }

  /**
   * 主循环 paused 时等待 resume 信号（与 `signal.aborted` 竞争）。
   *
   * 若 resume 已先行触发（竞态：resumeStep 先于主循环进入等待），立即消费标志返回；
   * 否则注册 waiter 并监听 abort：由 `notifyResume` 在 resumeStep/resumeAllSteps 时
   * resolve，或由 `abortInstance` 的 `controller.abort()` 触发 abort 监听 resolve——
   * 主循环恢复后经 `signal.aborted` 检查退出到 aborted 处理分支，避免 paused 期中止
   * 导致主循环永久悬挂。
   */
  private async waitForResume(active: ActiveInstance): Promise<void> {
    if (active.resumeRequested) {
      active.resumeRequested = false;
      return;
    }
    await new Promise<void>(resolve => {
      if (active.controller.signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => resolve();
      active.controller.signal.addEventListener('abort', onAbort, { once: true });
      active.resumeWaiters.push(() => {
        active.controller.signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  /** resumeStep/resumeAllSteps 成功后唤醒等待 resume 的主循环（无 waiter 时置标志）。 */
  private notifyResume(active: ActiveInstance): void {
    if (active.resumeWaiters.length > 0) {
      const waiters = active.resumeWaiters.splice(0);
      for (const resolve of waiters) {
        resolve();
      }
      return;
    }
    active.resumeRequested = true;
  }

  private async persistState(active: ActiveInstance): Promise<void> {
    const persistence = this.persistence();
    if (persistence === undefined) {
      return;
    }
    try {
      await persistence.saveWorkflowState(active.state);
    } catch (error) {
      this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`);
    }
  }

  // ── 事件双发 ─────────────────────────────────────────────────────────────

  private emitContained(name: string, args: unknown[]): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        const returned: unknown = callback(...args);
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`sandore: ${name} listener rejected: ${renderError(error)}`);
        });
      } catch (error) {
        this.ctx.logger.warn(`sandore: ${name} listener threw: ${renderError(error)}`);
      }
    }
  }

  private safeAppend(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.ctx.logger.warn(`sandore: session append failed: ${renderError(error)}`);
    }
  }

  private emitStart(session: Session, info: DagRunInfo): void {
    this.emitContained('sandore/start', [info]);
    this.safeAppend(() => session.append('sandore/start', { taskId: info.taskId, workflowId: info.workflowId, jobId: info.jobId }));
  }

  private emitStageStart(session: Session, info: DagRunInfo, stageId: string): void {
    this.emitContained('sandore/stage-start', [info, stageId]);
    this.safeAppend(() => session.append('sandore/stage-start', { taskId: info.taskId, stageId }));
  }

  private emitStageCompleted(session: Session, info: DagRunInfo, stageId: string, stageContract: StageContract): void {
    this.emitContained('sandore/stage-completed', [info, stageId, stageContract]);
    this.safeAppend(() => session.append('sandore/stage-completed', { taskId: info.taskId, stageId, stageContract }));
  }

  private emitStepStart(session: Session, info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-start', [info, stepId, childId, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => session.append('sandore/step-start', { stepId, childId, name, ...(loopIteration === undefined ? {} : { loopIteration }) }));
  }

  private emitStepCompleted(session: Session, info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[], name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-completed', [info, stepId, childId, output, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => session.append('sandore/step-completed', { stepId, childId, output, name, ...(loopIteration === undefined ? {} : { loopIteration }) }));
  }

  private emitStepFailed(session: Session, info: DagRunInfo, stepId: string, childId: string, error: string, name: string, loopIteration?: number[]): void {
    this.emitContained('sandore/step-failed', [info, stepId, childId, error, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => session.append('sandore/step-failed', { stepId, childId, error, name, ...(loopIteration === undefined ? {} : { loopIteration }) }));
  }

  private emitStepPaused(session: Session, active: ActiveInstance, stepId: string, childId: string, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };
    this.emitContained('sandore/step-paused', [info, stepId, childId, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => session.append('sandore/step-paused', { stepId, childId, name, ...(loopIteration === undefined ? {} : { loopIteration }) }));
  }

  private emitStepResumed(session: Session, active: ActiveInstance, stepId: string, childId: string, resumePrompt: string | undefined, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };
    this.emitContained('sandore/step-resumed', [info, stepId, childId, resumePrompt, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => session.append('sandore/step-resumed', { stepId, childId, ...(resumePrompt === undefined ? {} : { resumePrompt }), name, ...(loopIteration === undefined ? {} : { loopIteration }) }));
  }

  private emitStepRetried(session: Session, active: ActiveInstance, stepId: string, mode: RetryMode, name: string, loopIteration?: number[]): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };
    this.emitContained('sandore/step-retried', [info, stepId, mode, name, ...(loopIteration === undefined ? [] : [loopIteration])]);
    this.safeAppend(() => session.append('sandore/step-retried', { stepId, mode, name, ...(loopIteration === undefined ? {} : { loopIteration }) }));
  }

  private emitEnd(session: Session, info: DagRunInfo, result: DagResultInfo): void {
    this.emitContained('sandore/end', [info, result]);
    this.safeAppend(() => session.append('sandore/end', { taskId: info.taskId, jobId: info.jobId, result }));
  }

  private emitAborted(session: Session, info: DagRunInfo): void {
    this.emitContained('sandore/aborted', [info]);
    this.safeAppend(() => session.append('sandore/aborted', { taskId: info.taskId }));
  }

  private emitQuestion(session: Session, active: ActiveInstance, entry: PendingQuestionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };
    this.emitContained('sandore/question', [info, entry]);
    this.safeAppend(() => session.append('sandore/question', { question: entry }));
  }

  private emitPermission(session: Session, active: ActiveInstance, entry: PendingPermissionEntry): void {
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };
    this.emitContained('sandore/permission', [info, entry]);
    this.safeAppend(() => session.append('sandore/permission', { permission: entry }));
  }
}
