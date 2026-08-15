/**
 * sandore 工作流引擎运行时（Stage 级线性主循环）。
 *
 * `SandoreEngineRuntime` 继承 {@link SandoreEngine}：`startInstance` 同步完成
 * 读定义 → parse → 生成 instanceId → 初始化 pending 快照 → fire-and-forget
 * `execute`；`execute` 以 Stage 级线性主循环编排（StageExecutor 执行 Stage 内
 * Step → 收集 StageContract → `tryAdvanceStage` 跟随 `Stage.next`）。每次状态
 * 变化 `persistState` 并双发 `sandore/*` 事件（`ctx.emit` + 宿主 Session
 * `append`）；每个 Step 完成后经 `onPersist` 钩子立即追加到
 * `state.executedSteps` 并持久化；`childId = step-{stepId}-{execId 前 8 位}`
 * 合成 sessionMeta。
 * @module @deepseek-ai/dsh-sandore-workflow/src/workflow-engine
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';

import { WorkflowDagNavigator } from './dag-navigator.ts';
import { SandoreError } from './errors.ts';
import type { SandorePersistence } from './persistence.ts';
import type { WorkflowDefinition, WorkflowTaskState } from './schema.ts';
import { SandoreEngine } from './seam.ts';
import type { SandoreConfig } from './seam.ts';
import type {
  DagResultInfo,
  DagRun,
  DagRunInfo,
  DagStartRequest,
  DagInstanceState,
  StageContract,
  StepStatus,
} from './types.ts';
import { parseWorkflowYaml } from './yaml-parser.ts';

import { StageExecutor } from '../../microflow/src/stage-executor.ts';
import type { StageStepHooks } from '../../microflow/src/stage-executor.ts';
import type { StepRunnerConfig } from '../../microflow/src/step-runner.ts';

/** 运行中的实例（控制器 + 宿主 Session + 定义 + 状态快照）。 */
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly definition: WorkflowDefinition;
  state: WorkflowTaskState;
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
    pausedStepIds: [],
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
 * 作为 workflow 包默认导出：实现 `startInstance`/`getState`/`abortInstance`，
 * 其余 8 个实例级方法抛 `SandoreError('INVALID_OPERATION')`（`not implemented`）。
 */
export default class SandoreEngineRuntime extends SandoreEngine {
  static Config: z<SandoreConfig> = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    maxConcurrentSteps: z.natural().default(0),
    defaultProvider: z.string(),
    defaultModel: z.string(),
  });

  static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain'];

  private readonly instances = new Map<string, ActiveInstance>();

  constructor(ctx: Context, private readonly config: SandoreConfig) {
    super(ctx);
  }

  /** 启动实例：读定义 → parse → 初始化 pending 快照 → fire-and-forget 执行。 */
  startInstance(request: DagStartRequest): DagRun {
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
    const session = this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } });
    const active: ActiveInstance = { controller, session, definition, state };
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

  /** 中止运行中的实例（设置 AbortSignal → 主循环退出 → aborted 终态）。 */
  async abortInstance(instanceId: string): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
    }
    if (TERMINAL_STATUSES.has(active.state.status)) {
      throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, 'INVALID_OPERATION');
    }
    active.controller.abort();
  }

  async recoverInstance(instanceId: string): Promise<DagRun> {
    throw new SandoreError('SandoreEngineRuntime.recoverInstance is not implemented', 'INVALID_OPERATION');
  }

  async replyQuestion(instanceId: string, requestId: string, answers: unknown): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.replyQuestion is not implemented', 'INVALID_OPERATION');
  }

  async replyPermission(instanceId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.replyPermission is not implemented', 'INVALID_OPERATION');
  }

  async pauseStep(instanceId: string, stepId: string): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.pauseStep is not implemented', 'INVALID_OPERATION');
  }

  async resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.resumeStep is not implemented', 'INVALID_OPERATION');
  }

  async pauseAllSteps(instanceId: string): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.pauseAllSteps is not implemented', 'INVALID_OPERATION');
  }

  async resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.resumeAllSteps is not implemented', 'INVALID_OPERATION');
  }

  async retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.retryStep is not implemented', 'INVALID_OPERATION');
  }

  // ── 执行主体 ─────────────────────────────────────────────────────────────

  private async execute(instanceId: string): Promise<void> {
    const active = this.instances.get(instanceId);
    if (active === undefined) {
      return;
    }
    try {
      await this.runInstance(active);
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

  private async runInstance(active: ActiveInstance): Promise<void> {
    const { controller, session, definition } = active;
    const signal = controller.signal;
    const info: DagRunInfo = {
      taskId: active.state.taskId,
      workflowId: active.state.workflowId,
      jobId: active.state.jobId,
    };

    active.state = { ...active.state, status: 'running', updatedAt: now() };
    await this.persistState(active);
    this.emitStart(session, info);

    const navigator = new WorkflowDagNavigator(definition);
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
        onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId),
        onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output),
        onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error),
      };

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
        runnerConfig: this.runnerConfig(),
        signal,
        hooks,
        onPersist: async (executed) => {
          // 逐 Step 持久化：每个 Step 完成后立即追加到 executedSteps 并落盘，
          // 崩溃恢复时无需等待 Stage 结束即可读到已完成的 Step 快照。
          active.state = {
            ...active.state,
            executedSteps: [
              ...active.state.executedSteps,
              executed as unknown as WorkflowTaskState['executedSteps'][number],
            ],
            updatedAt: now(),
          };
          await this.persistState(active);
        },
      });

      const result = await executor.execute();

      // executedSteps 已通过 onPersist 逐 Step 追加并持久化，此处仅合并透传变量。
      active.state = {
        ...active.state,
        passThroughVars: { ...active.state.passThroughVars, ...result.passThroughVars },
        updatedAt: now(),
      };

      if (result.status === 'failed') {
        this.markStageStatus(active, stageId, 'failed');
        if (signal.aborted) {
          active.state = { ...active.state, status: 'aborted', updatedAt: now() };
          await this.persistState(active);
          this.emitAborted(session, info);
        } else {
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
        }
        return;
      }

      this.markStageStatus(active, stageId, 'completed');
      navigator.setStageContract(stageId, result.stageContract);
      active.state = {
        ...active.state,
        currentStageId: stageId,
        stageContracts: { ...active.state.stageContracts, [stageId]: result.stageContract },
        updatedAt: now(),
      };
      await this.persistState(active);
      this.emitStageCompleted(session, info, stageId, result.stageContract);

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

  private runnerConfig(): StepRunnerConfig {
    return {
      defaultTimeoutMs: this.config.defaultTimeoutMs ?? 7200000,
      ...(this.config.defaultProvider === undefined ? {} : { defaultProvider: this.config.defaultProvider }),
      ...(this.config.defaultModel === undefined ? {} : { defaultModel: this.config.defaultModel }),
    };
  }

  private persistence(): SandorePersistence | undefined {
    return this.ctx.get('sandorePersistence');
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

  private emitStepStart(session: Session, info: DagRunInfo, stepId: string, childId: string): void {
    this.emitContained('sandore/step-start', [info, stepId, childId]);
    this.safeAppend(() => session.append('sandore/step-start', { stepId, childId }));
  }

  private emitStepCompleted(session: Session, info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[]): void {
    this.emitContained('sandore/step-completed', [info, stepId, childId, output]);
    this.safeAppend(() => session.append('sandore/step-completed', { stepId, childId, output }));
  }

  private emitStepFailed(session: Session, info: DagRunInfo, stepId: string, childId: string, error: string): void {
    this.emitContained('sandore/step-failed', [info, stepId, childId, error]);
    this.safeAppend(() => session.append('sandore/step-failed', { stepId, childId, error }));
  }

  private emitEnd(session: Session, info: DagRunInfo, result: DagResultInfo): void {
    this.emitContained('sandore/end', [info, result]);
    this.safeAppend(() => session.append('sandore/end', { taskId: info.taskId, jobId: info.jobId, result }));
  }

  private emitAborted(session: Session, info: DagRunInfo): void {
    this.emitContained('sandore/aborted', [info]);
    this.safeAppend(() => session.append('sandore/aborted', { taskId: info.taskId }));
  }
}
