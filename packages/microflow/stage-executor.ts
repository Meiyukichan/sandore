/**
 * Stage 内部执行器（Task 3：`resolveNextNodes` 驱动的 DAG 调度循环）。
 *
 * 以批量工作队列逐节点执行：路由节点（带 `loop`/`branches` 且无 `command`）直接解析
 * 下一批；命令节点经 {@link StepRunner} 执行后经 {@link FinalizeManager} 收尾（透传
 * 变量提取 + 门禁审查），再经 `resolveNextNodes` 解析下一批。循环节点经
 * {@link LoopManager} 生成带后缀 id、`loopIteration` 与 `visitCount`；agent/skill/mcp
 * 的真实子代理 `sessionMeta`（`synthetic:false`）透传到 `ExecutedStepDefault`。
 * 每个 Step 完成后经 `onPersist` 钩子通知引擎逐 Step 持久化。
 * @module dsh-sandore/microflow/src/stage-executor
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import type {
  ExecutedStepDefault,
  PassThroughVar,
  StageContract,
  StepStatus,
} from '../workflow/types';
import type { FinalizeAssessResult, DagBranch, FinalizePhase, FinalizeAskResult, GateEvalResult, Gates, RoutingResult, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '../workflow/schema';
import type { ResolveNextNodesContext, ResolveNextNodesResult, StepNavigator } from './step-navigator.ts';

import type { ConcurrencyLimiter } from './concurrency-limiter.ts';
import { collectStepArtifacts } from './file-utils.ts';
import type { FileSystem } from './file-utils.ts';
import { SandoreError } from './errors.ts';
import { FinalizeManager, hasEnabledGates, hasUnresolvedPassThroughVars } from './finalize-manager.ts';
import type { FinalizeStepContext, FinalizeStepRequest } from './finalize-manager.ts';
import { describeError, textSummary } from './internal.ts';
import { LoopManager } from './loop-manager.ts';
import { resolveStepRules } from './rules-resolver.ts';
import { StepRunner } from './step-runner.ts';
import type { StepRunnerConfig, PreviousStepOutput, StepRunResult } from './step-runner.ts';

/** 分离式合并后的完整 Step：完整定义（command/映射等）+ 流控 branches。 */
export type MergedStep = WorkflowStep & { readonly branches?: DagBranch[] | undefined };

/** Stage 执行输入（原始需求 + 前置契约产物 + 透传变量）。 */
export interface StageExecutionInput {
  readonly originalInput: string;
  /**
   * 前置 Stage 的契约产物（由 `navigator.getContractArtifacts()` 聚合注入，
   * workflow-engine.ts L683）。
   *
   * 缺陷 16 TODO（跨 Stage 引用，更大增量，本次未接入消费端）：
   * - 当前 finalizeStageContract 已按 `outputTo.id` 聚合本 Stage 产物到
   *   `StageContract.contractArtifacts`，`navigator.getContractArtifacts()` 也已
   *   合并前置 Stage 契约注入本字段，但本字段在 StageExecutor 内零消费点；
   * - 待接入：支持 `${stage.stg-xxx.artifact-name}` 语法（artifact-name = outputTo.id），
   *   在 step-runner `replacePassThroughVars` 或专用解析器把引用替换为实际文件列表，
   *   使后续 Step 的提示词/命令可见前置 Stage 的产物文件。
   */
  readonly contractArtifacts: Record<string, string[]>;
  readonly passThroughVars: WorkflowTaskState['passThroughVars'];
}

/** 透传变量运行时值。 */
export interface PassThroughVarValue {
  value: string;
  description: string;
  refresh?: boolean;
}

/** Stage 共享状态。 */
export interface StageSharedState {
  readonly cwd: string;
  readonly taskId: string;
}

/** Step 生命周期钩子（由引擎注入，用于发射 `sandore/step-*` 事件）。 */
export interface StageStepHooks {
  readonly onStepStart: (step: WorkflowStep, childId: string) => void;
  readonly onStepCompleted: (step: WorkflowStep, childId: string, output: ContentBlock[]) => void;
  readonly onStepFailed: (step: WorkflowStep, childId: string, error: string) => void;
  /**
   * 收尾阶段流转钩子（`commitFinalize(currentPhase)` 写入 finalizeMeta 后触发，
   * 由引擎注入并双发 `sandore/step-phase` 事件）。`childId` 取执行段
   * `sessionMeta.childId`（shell 等无真实会话时为合成占位/undefined，引擎侧回退）。
   */
  readonly onPhaseChange?: (step: WorkflowStep, childId: string | undefined, phase: FinalizePhase) => void;
}

/** StageExecutor 构造参数。 */
export interface StageExecutorOptions {
  readonly ctx: Context;
  readonly stageDef: WorkflowStage;
  readonly workflowDef: WorkflowDefinition;
  readonly input: StageExecutionInput;
  readonly sharedState: StageSharedState;
  readonly runnerConfig: StepRunnerConfig;
  readonly signal?: AbortSignal;
  readonly hooks?: StageStepHooks;
  /** 单个 Step 完成/失败后的持久化回调（由引擎注入，逐 Step 持久化状态快照 +
   * pendingQueue 快照）。pendingQueue 为当前 ready/processing Step IDs（单队列快照）。 */
  readonly onPersist?: (executedStep: ExecutedStepDefault, pendingQueue?: readonly string[]) => Promise<void> | void;
  /** 循环管理器（引擎共享：ID 后缀 + 迭代路径；由 `stepNavigator` 创建并注入）。 */
  readonly loopManager: LoopManager;
  /** 收尾管理器（透传变量提取 + 门禁审查）。 */
  readonly finalizeManager: FinalizeManager;
  /**
   * Step 级 DAG 导航器（microflow 自有：Step 级路由 `resolveNextNodes` + 循环管理器）。
   *
   * 由引擎每 Stage 创建并注入——Step 生命周期（路由 + 执行 + 判断 + 收尾 + 循环计数）全归
   * microflow；StageExecutor 不再经 options 注入 `resolveNextNodes`，改调本导航器。
   * `loopManager` 字段为同一实例（引擎从 `stepNavigator.loopManagerInstance` 取后注入）。
   */
  readonly stepNavigator: StepNavigator;
  /** 节点访问计数（引擎共享，持久化于 `WorkflowTaskState.visitCounts`）。 */
  readonly visitCounts: Record<string, number>;
  /**
   * 全局 Step 级并发上限器（缺陷 10 队列驱动真并发改造）。
   *
   * workflow 读 maxConcurrentSteps 配置 → 创建 limiter → 注入每个 StageExecutor。
   * runLoop 在 processCommandNode 前 `await limiter.acquire()`，finally `limiter.release()`。
   * processRoutingNode 不 acquire（路由节点轻量不跑 subagent，不占槽）。多个并行
   * StageExecutor 共享同一个 limiter → 全局 Step 并发 ≤ maxConcurrentSteps。省略时无上限。
   */
  readonly concurrencyLimiter?: ConcurrencyLimiter;
  /** 崩溃恢复/重试续跑播种：跳过已完成 Step 并从指定子代理 Step 续跑 + pendingQueue re-queue。 */
  readonly resumeFrom?: StageExecutorResume;
  /** 响应式持久化桥接：把 stage-executor 内部 status/errorDetail 变更桥接回引擎 active.state，
   * 触发 ReactiveState 持久化调度。由引擎注入。status 使用引擎级实例状态窄类型。 */
  readonly commitState?: (patch: { status?: 'running' | 'interacting' | 'completed' | 'failed' | 'paused' | 'aborted'; errorDetail?: string }) => void;
}

/** Stage 断点续跑播种（从快照重建执行位置，跳过已完成 Step 并续跑指定子代理 Step +
 * pendingQueue re-queue）。 */
export interface StageExecutorResume {
  /** 已完成 Step 快照（跳过不重跑，用于重建 previousOutputs 与 executedSteps）。 */
  readonly completedSteps: readonly ExecutedStepDefault[];
  /** 需续跑的子代理 Step 列表（多路恢复：并发崩溃时多个 running/interacting 段各自续跑）。
   * 省略时表示无活跃段（between-steps 崩溃窗口，见 {@link resumeBetweenSteps}）。 */
  readonly resumeSubagents?: ReadonlyArray<{
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    readonly childId: string;
  }>;
  /**
   * between-steps 崩溃续跑（缺陷 9 G）：无活跃段但有已完成 Step。省略 `resumeSubagents`
   * 时由执行器从最后完成 Step 反推 DAG next 播种 batch，避免从 Stage 首步重跑已完成
   * Step（非恰好一次语义）。mid-step 崩溃（有 `resumeSubagents`）时不设此标志。
   */
  readonly resumeBetweenSteps?: boolean;
  /**
   * pendingQueue re-queue（缺陷 10 恢复可靠性增强）：崩溃时已落盘的 ready Step IDs。
   * 直接播种为 runLoop 初始 batch，无需从 executedSteps 反推 DAG next（精确重放）。
   * 为空时 fallback 到 resumeBetweenSteps 反推逻辑。
   */
  readonly pendingQueue?: readonly string[];
}

/** Stage 执行结果。 */
export interface StageExecutionResult {
  readonly stageContract: StageContract;
  readonly executedSteps: ExecutedStepDefault[];
  readonly passThroughVars: Record<string, PassThroughVarValue>;
  readonly status: StepStatus;
  readonly errorDetail?: string;
}

/** 为单个 Step 合成占位 childId（纯 UUID 格式）。 */
function synthesizeChildId(_stepId: string): string {
  return globalThis.crypto.randomUUID();
}

/** 生成执行段唯一 id（纯 UUID；每次执行段一个新 id，与 childId 解耦）。 */
function newExecId(): string {
  return globalThis.crypto.randomUUID();
}

/** ask 收尾闭环的最大轮次（防子代理基于回答反复产出未完成结果导致无限重问）。 */
const MAX_FINALIZE_ASK_ROUNDS = 3;

/**
 * 理论不可达兜底评估结果（门禁启用但评估结果缺失时用于满足类型；实际门禁启用
 * ⇒ 评估必已运行——runPhaseA 跳过条件为「无未解析透传变量且无门禁」）。
 */
const EMPTY_ASSESS_RESULT: FinalizeAssessResult = {
  passThroughVars: {},
  forkSessionId: '',
  assessmentRaw: '',
};

/** runPhaseA 的返回（'ask' = ask 保底中断；ok = 携带评估结果与合并后的门禁配置）。 */
type PhaseAResult =
  | { readonly kind: 'ask' }
  | { readonly kind: 'ok'; readonly assessResult: FinalizeAskResult | undefined; readonly gates: Gates | undefined };

/** runPhaseC 的返回（'failed' = 门禁未通过；ok = 携带门禁结果）。 */
type PhaseCResult =
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ok'; readonly gateResult: GateEvalResult | undefined };

/** runLoop 节点处理结果（命令节点产出 + resume 分流 + limiter 跳过）。 */
type Outcome = 'ok' | 'ask' | 'failed' | 'paused' | 'skipped';
/** runLoop 终态优先级聚合（failed > paused > interacting/ask）。 */
type TerminalKind = 'failed' | 'paused' | 'interacting';

/** 当前时间 ISO 串（供 executedStep 的 startedAt/updatedAt 写入）。 */
function now(): string {
  return new Date().toISOString();
}

/** 收集 Stage 内全部 Step 定义的透传变量（steps 为合并后的完整 Step）。 */
function collectPassThroughVars(steps: readonly WorkflowStep[]): Record<string, PassThroughVarValue> {
  const result: Record<string, PassThroughVarValue> = {};
  for (const step of steps) {
    for (const passThroughVar of step.passThroughVars ?? []) {
      result[passThroughVar.name] = toPassThroughValue(passThroughVar);
    }
  }
  return result;
}

/** 将 Step 定义的透传变量转换为运行时值。 */
function toPassThroughValue(passThroughVar: PassThroughVar): PassThroughVarValue {
  return {
    value: passThroughVar.value,
    description: passThroughVar.description,
    ...(passThroughVar.refresh === undefined ? {} : { refresh: passThroughVar.refresh }),
  };
}

/** 透传变量运行时值 → 字符串映射（供 shell/prompt 注入）。 */
function toVarMap(vars: Record<string, PassThroughVarValue>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    result[name] = value.value;
  }
  return result;
}

/**
 * 将已完成 Step 映射为 prompt 参考信息。
 *
 * `files` 缺省为空数组（向后兼容）；缺陷 16 修复后由调用方先经
 * {@link collectStepArtifacts} 收集实际产物文件列表后传入，填充 step-runner
 * `renderPreviousOutputs` 渲染的「## 前置Steps输出与产物」`<artifacts>` 块。
 */
function toPreviousOutput(step: ExecutedStepDefault, files: readonly string[] = []): PreviousStepOutput {
  return {
    name: step.name,
    id: step.stepId ?? step.id,
    returnPrompt: textSummary(step.output),
    files: [...files],
  };
}

/**
 * 组装 Stage 产物契约。
 *
 * 缺陷 16 修复：`artifacts[].files` 与 `contractArtifacts` 不再硬编码空值——
 * 对每个 executedStep 经 {@link collectStepArtifacts} 收集 outputTo 实际命中文件，
 * 填入对应 `artifacts[].files`；并按 `outputTo.id` 聚合到 `contractArtifacts`
 * （key = outputTo.id，value = 同 id 项的文件合并），供后续 Stage 经
 * `navigator.getContractArtifacts()` 跨 Stage 引用。
 *
 * 跨 Stage 引用语法 `${stage.stg-xxx.artifact-name}` 的消费端接入见
 * {@link StageExecutionInput.contractArtifacts}（TODO：当前仅注入未消费）。
 */
async function finalizeStageContract(
  fs: FileSystem,
  workdir: string,
  stageDef: WorkflowStage,
  executedSteps: readonly ExecutedStepDefault[],
  status: StepStatus,
  passThroughVars: Record<string, PassThroughVarValue>,
  errorDetail: string | undefined,
): Promise<StageContract> {
  const artifacts: StageContract['artifacts'] = [];
  const contractArtifacts: Record<string, string[]> = {};
  for (const step of executedSteps) {
    if (step.outputTo === undefined || step.outputTo.length === 0) continue;
    // 缺陷 34：outputTo path/regex 含 ${xxx} 透传变量时先替换（用引擎累加器值）。
    const stepArtifacts = await collectStepArtifacts(fs, step, workdir, toVarMap(passThroughVars));
    const filesById = new Map(stepArtifacts.map(a => [a.id, a.value] as const));
    const returnPrompt = textSummary(step.output);
    for (const outputTo of step.outputTo) {
      const files = filesById.get(outputTo.id) ?? [];
      artifacts.push({
        stepId: step.stepId ?? step.id,
        outputToId: outputTo.id,
        files,
        ...(returnPrompt === '' ? {} : { returnPrompt }),
      });
      // 按 outputTo.id 聚合 contractArtifacts（跨 Stage 引用载体）。
      contractArtifacts[outputTo.id] = [...(contractArtifacts[outputTo.id] ?? []), ...files];
    }
  }
  return {
    stageId: stageDef.id,
    stageName: stageDef.name,
    status,
    artifacts,
    passThroughVars,
    contractArtifacts,
    completedAt: new Date().toISOString(),
    ...(errorDetail === undefined ? {} : { errorDetail }),
  };
}

/** 三级门禁浅合并（workflow → stage → step，后者覆盖前者）。 */
function mergeGates(workflowDef: WorkflowDefinition, stageDef: WorkflowStage, step: WorkflowStep): Gates | undefined {
  const workflowGates = workflowDef.gates;
  const stageGates = stageDef.gates;
  const stepGates = step.gates;
  if (workflowGates === undefined && stageGates === undefined && stepGates === undefined) {
    return undefined;
  }
  return {
    ...(workflowGates ?? {}),
    ...(stageGates ?? {}),
    ...(stepGates ?? {}),
  };
}

/**
 * Stage 内部执行器。
 *
 * 构造时绑定 Stage 定义、共享状态、StepRunner 配置与调度依赖（LoopManager /
 * FinalizeManager / resolveNextNodes）；`execute()` 以批量队列执行 Step DAG，遇到
 * 失败即中止，最终返回 StageContract 与执行结果。
 */
/** Stage 断点续跑状态（ask 中断时保留，回复后 `execute()` 再次调用从断点续跑）。 */
interface StageRunState {
  readonly stepIndex: Map<string, MergedStep>;
  readonly executedSteps: ExecutedStepDefault[];
  readonly previousOutputs: PreviousStepOutput[];
  readonly passThroughVars: Record<string, PassThroughVarValue>;
  /** ready 节点队列（FIFO；去重由 enqueue 保证）。取代 batch/batchIndex/nextBatch。 */
  pendingQueue: string[];
  status: StepStatus;
  errorDetail: string | undefined;
  /** ask 断点：等待回复的 Step（resume 时重收集输出 + 重跑完整 finalize）。 */
  pendingAsk: {
    readonly nodeId: string;
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    /** 已发生的 ask 轮次数（防无限重问；达到上限后按普通输出推进）。 */
    readonly rounds: number;
  } | undefined;
  /** paused 断点：被 interrupt 打断且命中暂停登记表的子代理 Step（resume 后重新收集输出续跑）。 */
  pendingPaused: {
    readonly nodeId: string;
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    readonly childId: string;
  } | undefined;
  /**
   * resume 分流表：nodeId → 续跑 Step 定义 + 既有执行段 + childId（initState 从
   * resumeSubagents 播种）。取代 pendingResumes。startNode 入口查表分流——命中走
   * resumeSubagentStep 续跑（**不 acquire limiter**；step 取 resumeFrom 携带的定义，
   * 而非 stepIndex 合并视图——崩溃恢复时二者可能不一致，续跑须以 resumeFrom 的
   * command 为准，对齐旧 resumePendingResumes 直传 pending.step 的语义）。
   */
  resumeSegments: Map<string, { step: WorkflowStep; executed: ExecutedStepDefault; childId: string }>;
  /**
   * between-steps 崩溃续跑标志（缺陷 9 G）：无活跃段但有已完成 Step。execute() 入口
   * 据此从最后完成 Step 反推 DAG next 播种 pendingQueue（跳过已完成 Step），避免从
   * Stage 首步重跑。仅 {@link initState} 的 resumeFrom 分支（`resumeBetweenSteps`）置 true。
   */
  pendingBetweenSteps: boolean;
}

export class StageExecutor {
  private readonly runner: StepRunner;
  private runState: StageRunState | undefined;
  /** step.id → 真实子代理 SessionId（经 onChildStarted 记录，取消类错误判定暂停用）。 */
  private readonly realChildIds = new Map<string, string>();
  /** 本 Stage 的完整 Step（按 id 合并 stages[].steps 流控 + 顶层 steps 完整定义，含 branches）。 */
  private readonly steps: MergedStep[];

  constructor(private readonly options: StageExecutorOptions) {
    this.runner = new StepRunner(options.ctx, this.trackChildStarted(options.runnerConfig));
    // 分离式合并：stage.steps 提供 id + 流控（branches），definition.steps 提供完整定义
    // （command/映射/gates 等），按 id 合并成执行用的完整 WorkflowStep。
    const definitions = new Map((options.workflowDef.steps ?? []).map(step => [step.id, step] as const));
    this.steps = options.stageDef.steps.map(flowStep => {
      const definition = definitions.get(flowStep.id);
      return definition === undefined
        ? flowStep as MergedStep
        : { ...definition, ...(flowStep.branches === undefined ? {} : { branches: flowStep.branches }) } as MergedStep;
    });
  }

  /** 包装 onChildStarted：记录真实 childId（供取消类错误查暂停登记表），再透传原回调。 */
  private trackChildStarted(runnerConfig: StepRunnerConfig): StepRunnerConfig {
    const onChildStarted = runnerConfig.onChildStarted;
    if (onChildStarted === undefined) {
      return runnerConfig;
    }
    return {
      ...runnerConfig,
      onChildStarted: async (stepId, childId) => {
        this.realChildIds.set(stepId, childId);
        await onChildStarted(stepId, childId);
      },
    };
  }

  /**
   * 执行本 Stage 内全部 Step（DAG 调度循环）。
   *
   * 首次调用初始化断点续跑状态；ask 中断返回 `interacting` 后，引擎回复用户再次调用
   * 本方法即从断点续跑（重跑门禁 + 推进剩余 Step），直至 completed/failed。
   */
  async execute(): Promise<StageExecutionResult> {
    let state = this.runState;
    if (state === undefined) {
      state = await this.initState();
      this.runState = state;
    }
    // 续跑入口重置（审查第 5 项）：pendingPaused/pendingAsk 挂起时 state.status 为
    // paused/interacting 终态，条件 completed 写会被 isTerminalState 拦截 → 先重置
    // 'running' + commitState，续跑完成后条件写才可落 completed（ask/pause 断点续跑语义）。
    if (state.pendingPaused !== undefined) {
      state.status = 'running';
      this.options.commitState?.({ status: 'running' });
      const resumed = await this.resumePendingPaused(state);
      if (resumed !== 'ok') {
        // ask 中断（续跑收尾判定为 ask）或 failed：返回结果，交由引擎 ask/失败循环处理。
        return await this.buildResult(state);
      }
    }
    if (state.pendingAsk !== undefined) {
      state.status = 'running';
      this.options.commitState?.({ status: 'running' });
      const resumed = await this.resumePendingAsk(state);
      if (resumed !== 'ok') {
        // 'ask'：新 output 再次判定需提问（断点已重新挂回），引擎 ask 循环再走一轮；
        // 'failed'：收尾失败。两者均返回 buildResult 交引擎处理。
        return await this.buildResult(state);
      }
    }
    // between-steps 崩溃续跑（缺陷 9 G）：无活跃段但有已完成 Step → 从最后完成 Step
    // 反推 DAG next 播种 pendingQueue，避免从 Stage 首步重跑已完成 Step（非恰好一次语义）。
    // resumeFrom 播种的 completedSteps 已进 executedSteps/previousOutputs；此处仅决定
    // 本轮队列起始位置（剩余未执行 Step）。primary 覆盖线性/分支命令链；循环回边
    // 等边角由保留的循环栈 + StepNavigator 路由承接（超出文档化 gap 的边界场景）。
    // （resumePendingResumes 已并入 runLoop：resume 段经 startNode 的 resumeSegments 分流。）
    if (state.pendingBetweenSteps) {
      state.pendingBetweenSteps = false;
      const lastSeeded = state.executedSteps[state.executedSteps.length - 1];
      const lastNodeId = lastSeeded?.stepId;
      if (lastNodeId !== undefined) {
        const routed = await this.options.stepNavigator.resolveNextNodes(lastNodeId, this.buildContext(state));
        this.enqueue(routed.nextNodeIds, state);
        if (state.pendingQueue.length === 0) {
          // 该 Stage 已无未执行 Step（崩溃发生在末步完成与 Stage 收尾之间）：标完成交引擎推进。
          state.status = 'completed';
        }
      }
    }
    await this.runLoop(state);
    return await this.buildResult(state);
  }

  /**
   * 初始化断点续跑状态（首次调用 execute 时）。
   *
   * 缺陷 16 修复：resumeFrom 播种的 completedSteps 在重建 previousOutputs 时，逐
   * Step 经 {@link collectStepArtifacts} 收集实际产物文件列表填入 `files`（填充
   * step-runner `renderPreviousOutputs` 的 `<artifacts>` 块），不再硬编码 `[]`。
   */
  private async initState(): Promise<StageRunState> {
    const { input } = this.options;
    const stepIndex = new Map<string, MergedStep>();
    for (const step of this.steps) {
      stepIndex.set(step.id, step);
    }
    // 合并语义：定义默认值（collectPassThroughVars）补种 input 已持久化值——**保持 input
    // 引用**（就地补缺失项，不 spread 拷贝）：stage 内 writeBack 就地更新该对象 → 引擎
    // active.state.passThroughVars（input 同引用）同步可见 → onPersist 的 persistState
    // 持久化新值（多 step 长流程/崩溃恢复不丢变量）。原 spread 拷贝方案导致 stage 写回
    // 只落内部拷贝、引擎侧保持旧值——「stage 执行中 persist 旧值、跨 step 变量丢失、
    // 产物收集空（outputTo 引用 ${xxx}）」根因（2026-08-25 e2e 定位）。
    // 语义不变：input 已提取值优先于定义默认值（缺陷 15 残余差异二：跨 Stage 同名变量
    // 场景下后置 Stage 的定义默认值不覆盖前置 Stage 已提取值——已有 key 跳过补种）。
    const passThroughVars = input.passThroughVars as Record<string, PassThroughVarValue>;
    for (const [name, value] of Object.entries(collectPassThroughVars(this.steps))) {
      if (passThroughVars[name] === undefined) {
        passThroughVars[name] = value;
      }
    }
    // 崩溃恢复/重试续跑播种：跳过已完成 Step，续跑指定子代理 Step 列表 + pendingQueue re-queue。
    const resumeFrom = this.options.resumeFrom;
    if (resumeFrom !== undefined) {
      const { completedSteps, resumeSubagents, resumeBetweenSteps, pendingQueue } = resumeFrom;
      // 逐 Step 收集产物文件（填 previousOutputs.files → 前置产物 <artifacts> 块）。
      const artifactsPerStep = await Promise.all(
        completedSteps.map(s => collectStepArtifacts(this.options.ctx.fs, s, this.options.sharedState.cwd, toVarMap(passThroughVars))),
      );
      // resume 分流表（方案 3.5）：resumeSubagents 各自入 segments（nodeId → 既有段 +
      // childId），并把 resume 段 nodeId 优先入队 pendingQueue——startNode 查表分流走
      // resumeSubagentStep（不 acquire limiter，对齐旧 resumePendingResumes 语义）；
      // 快照 pendingQueue 去重追加入队（命中 segments 的 nodeId 跳过——旧快照 batch
      // 可能同时含 running 节点，防重复拉起）。
      const segments = new Map<string, { step: WorkflowStep; executed: ExecutedStepDefault; childId: string }>();
      const initialQueue: string[] = [];
      for (const rs of resumeSubagents ?? []) {
        segments.set(rs.step.id, { step: rs.step, executed: rs.executed, childId: rs.childId });
        initialQueue.push(rs.step.id);
      }
      const seen = new Set(initialQueue);
      for (const id of pendingQueue ?? []) {
        if (!segments.has(id) && !seen.has(id)) {
          seen.add(id);
          initialQueue.push(id);
        }
      }
      return {
        stepIndex,
        executedSteps: [...completedSteps],
        previousOutputs: completedSteps.map((s, i) =>
          toPreviousOutput(s, artifactsPerStep[i]!.flatMap(a => a.value)),
        ),
        passThroughVars,
        pendingQueue: initialQueue,
        status: 'running',
        errorDetail: undefined,
        pendingAsk: undefined,
        pendingPaused: undefined,
        resumeSegments: segments,
        // pendingQueue 非空时直接播种（精确重放），pendingBetweenSteps 留 false；
        // pendingQueue 空且有 completedSteps 时 fallback 到 between-steps 反推（缺陷 9 G）。
        pendingBetweenSteps: resumeBetweenSteps === true && (pendingQueue === undefined || pendingQueue.length === 0) && segments.size === 0,
      };
    }
    const firstStep = this.steps[0];
    return {
      stepIndex,
      executedSteps: [],
      previousOutputs: [],
      passThroughVars,
      pendingQueue: firstStep === undefined ? [] : [firstStep.id],
      status: 'completed',
      errorDetail: undefined,
      pendingAsk: undefined,
      pendingPaused: undefined,
      resumeSegments: new Map(),
      pendingBetweenSteps: false,
    };
  }

  /** 组装调度上下文（透传变量 + 访问计数 + 取消信号 + fork 源会话 id）。 */
  private buildContext(state: StageRunState): ResolveNextNodesContext {
    const { signal, visitCounts } = this.options;
    const recentStepSessionId = this.recentStepSessionId(state);
    return {
      visitCounts,
      passThroughVars: toVarMap(state.passThroughVars),
      ...(signal === undefined ? {} : { signal }),
      ...(recentStepSessionId === undefined ? {} : { recentStepSessionId }),
    };
  }

  /**
   * 取最近命令节点的真实子代理会话 id（fork-based 判断源：缺陷 2/4 改造）。
   *
   * 倒序遍历 executedSteps，取首个 `sessionMeta.synthetic === false` 且有 `childId` 的
   * 命令节点——该会话 fork 后注入全量历史，判断 AI 即可见当前 step 的完整 I/O
   * （替代旧 `buildLoopBreakContext` 的手动 I/O 拼装）。合成 session（prompt/shell）或
   * 无已执行命令节点时返回 undefined（判断降级为临时会话）。
   */
  private recentStepSessionId(state: StageRunState): string | undefined {
    for (let i = state.executedSteps.length - 1; i >= 0; i -= 1) {
      const executed = state.executedSteps[i]!;
      const meta = executed.sessionMeta;
      if (meta !== undefined && meta.synthetic === false && meta.childId !== undefined) {
        return meta.childId;
      }
    }
    return undefined;
  }

  /**
   * 主调度循环：pendingQueue + Promise.race 真并发驱动（bugfix round22：batch+Promise.all
   * 重构为 pendingQueue+Promise.race，对齐基准并发模型）。
   *
   * **并发模型**：
   * - 单一 ready 队列 `pendingQueue`（FIFO；enqueue 去重），命令节点**即出队即拉起**
   *   （eager spawn，线性链不必等兄弟完成——重构的核心收益）；路由节点串行处理
   *   （preserve loopManager activeLoopStack state consistency）。
   * - **quiescent routing barrier（G10/审查第 6 项）**：路由节点仅在 `running.size === 0`
   *   （无命令在飞）时 shift + await 串行处理，否则 peek-and-stop 留队——路由
   *   `resolveNextNodes` 永不与命令 Phase D 重叠（loopManager 栈不被破坏），循环门只在
   *   当前迭代全部命令落地后路由（迭代语义与旧批模型一致，不提前 break）。
   * - 命令节点在 startNode 内 acquire limiter（全局 Step 并发度），finally release；
   *   maxConcurrentSteps=0 时无上限（UnlimitedLimiter）。resume 分流段不 acquire。
   * - `Promise.race` 等待任一在飞节点 settle（running 非空才 race；race 空集永不 settle）。
   *
   * **计数模型并发安全**（缺陷 3 不改语义）：处理节点**之前**对每个节点 visitCount +1
   * （单一递增点，路由门与命令门一致，peek-and-stop + running 去重保证不重复）。
   * recordScopeVisit 把节点记入活跃循环作用域集。回边/checkLoopBreak 只读不递增。
   *
   * **终止语义**：任何命令节点产出 failed/paused/ask 时停止推进（剩余未启动节点跳过）；
   * 终止态写（failed/paused/interacting）无条件 last-write-wins，completed 写条件化
   * （!isTerminalState），循环末按 terminalPriority 重断言（failed > paused > ask，G11）
   * 后落终态；非终止态兜底 completed（覆盖空队列 resume 等边缘）。
   *
   * @param state - Stage 运行时状态（pendingQueue 驱动循环）。
   */
  private async runLoop(state: StageRunState): Promise<void> {
    const { visitCounts, loopManager } = this.options;
    const running = new Map<string, Promise<Outcome>>();
    let terminalPriority: TerminalKind | undefined;

    while (true) {
      if (this.isTerminalState(state)) break;

      // drain：拉起 pendingQueue；路由节点仅 quiescent（running.size===0）时串行处理。
      while (state.pendingQueue.length > 0) {
        const nodeId = state.pendingQueue[0]!;              // peek，不 shift（peek-and-stop）
        const step = state.stepIndex.get(nodeId);
        if (step === undefined) {
          // 跨 Stage 目标：引擎 tryAdvanceStage 承接（同旧模型 L613-615）。
          state.pendingQueue.shift();
          continue;
        }
        const isRoutingNode = step.command === undefined && step.branches !== undefined;
        if (isRoutingNode && running.size > 0) break;        // ← quiescent barrier（G10/第6项）
        state.pendingQueue.shift();
        if (running.has(nodeId)) {
          // 共享后继去重（偏离 3.2 补充，审查第 7 项延伸）：同一 nodeId 已在飞（eager
          // enqueue 下两个并行分支可能先后路由到同一后继）时跳过重复拉起，避免重复执行
          // 与 visitCount 双计（旧批模型由 nextBatch 批量去重保证，新模型需在出队点补
          // running 去重——串行用例实证：b1 完成后 step-end 已出队在飞，b2 完成再入队
          // 若不跳过会二次执行）。已在飞节点 settle 后其 nexts 正常入队，不丢节点。
          continue;
        }
        // 单一递增点。**resume 节点（resumeSegments 命中，崩溃恢复续跑同一执行段）出队
        // 不 +1**——initState 把 resumeSubagents 重新入队（initialQueue），若出队再加 1
        // 会导致 visitCount 虚高（如 sce1 执行 1 次却计数 2）→ loop 的 `maxIterations`
        // 判定提前命中 → 循环体少跑（2026-08-25 e2e 定位：配置 3 次实际只跑 2 次）。
        // resume 节点执行前的 visitCount 快照已含其首次出队 +1，续跑不应重复计数。
        if (!state.resumeSegments.has(nodeId)) {
          visitCounts[nodeId] = (visitCounts[nodeId] ?? 0) + 1;
        }
        loopManager.recordScopeVisit(nodeId);
        if (isRoutingNode) {
          await this.processRoutingNode(nodeId, step, state); // 串行（barrier 满足时）
          if (this.isTerminalState(state)) break;
        } else {
          const p = this.startNode(nodeId, step, state);      // limiter 在 startNode 内
          running.set(nodeId, p.then(outcome => {
            running.delete(nodeId);
            terminalPriority = this.recordTerminal(terminalPriority, outcome);
            return outcome;
          }));
        }
      }

      if (running.size === 0) {
        if (state.pendingQueue.length === 0) break;
        continue;   // 仅剩路由节点且无在飞命令 → 下轮直接路由（drain 已先执行，不丢节点）
      }
      await Promise.race(running.values());   // running 非空才 race（race 空集永不 settle）
    }

    // 终止态收尾：等全部在飞节点落地（P3/failed persist 完成，executedSteps 完整），
    // 再按 terminalPriority 断言终态（G11，修复并发 failed+paused 时 paused 覆盖 failed）。
    await Promise.allSettled(running.values());
    if (terminalPriority !== undefined) {
      if (state.status !== terminalPriority) {
        state.status = terminalPriority;
        this.options.commitState?.({ status: terminalPriority });
      }
    } else if (!this.isTerminalState(state)) {
      // 循环末兜底（覆盖空队列 resume 等边缘）：**仅设内部状态，不 commit 引擎级
      // completed**（Round 23）——引擎级 completed 只在工作流真正完成时统一设置
      // （workflow-engine L1480）；中途 commit 会命中 ask 工具注入 gate 的
      // TERMINAL_STATUSES（completed ∈ 终态集）→ 后续 ask step 子代理用全局版
      // ask 工具 → headless 挂起（真实 e2e 2026-08-25 根因）。
      state.status = 'completed';
    }
  }

  /** 按优先级聚合节点产出为终态（failed > paused > ask；ok/skipped 不改变优先级）。 */
  private recordTerminal(priority: TerminalKind | undefined, outcome: Outcome): TerminalKind | undefined {
    const kind = outcome === 'failed' ? 'failed' : outcome === 'paused' ? 'paused' : outcome === 'ask' ? 'interacting' : undefined;
    if (kind === undefined) return priority;
    const order: Record<TerminalKind, number> = { failed: 0, paused: 1, interacting: 2 };
    return priority === undefined || order[kind] < order[priority] ? kind : priority;
  }

  /**
   * 命令节点处理入口（取代 processCommandNodeWithLimiter；bugfix round22）。
   *
   * **resume 分流（审查第 3 项）**：resumeSegments 命中 → delete + resumeSubagentStep
   * 续跑（**不 acquire limiter**——对齐旧 resumePendingResumes 不经 limiter 的语义，
   * 避免 maxConcurrentSteps=1 时多路恢复被串行化；行为变更已文档化）。
   * 未命中 → acquire limiter → acquire 后 isTerminalState 检查（limiter 等待窗口内
   * 可能已有终态发生，对齐旧 L695）→ processCommandNode → finally release。
   * 路由节点不 acquire（轻量不跑 subagent，不占槽）。maxConcurrentSteps=0 时
   * UnlimitedLimiter 立即返回（无上限）。
   */
  private async startNode(nodeId: string, step: WorkflowStep, state: StageRunState): Promise<Outcome> {
    const resume = state.resumeSegments.get(nodeId);
    if (resume !== undefined) {
      state.resumeSegments.delete(nodeId);
      return this.resumeSubagentStep(state, nodeId, resume.step, resume.executed, resume.childId);
    }
    const limiter = this.options.concurrencyLimiter;
    if (limiter !== undefined) {
      await limiter.acquire();
    }
    try {
      // acquire 后再次检查（等待 limiter 期间可能已有终止态发生）。
      if (this.isTerminalState(state)) {
        return 'skipped';
      }
      return await this.processCommandNode(nodeId, step, state);
    } finally {
      if (limiter !== undefined) {
        limiter.release();
      }
    }
  }

  /** 检查 state 是否已进入终止态（failed/paused/interacting）。 */
  private isTerminalState(state: StageRunState): boolean {
    return state.status === 'failed' || state.status === 'paused' || state.status === 'interacting';
  }

  /** 路由节点：resolveNextNodes 产出下一批，分支/循环评估现场回写路由条目。 */
  private async processRoutingNode(nodeId: string, step: MergedStep, state: StageRunState): Promise<void> {
    const { stageDef, loopManager, stepNavigator, visitCounts } = this.options;
    const routed = await stepNavigator.resolveNextNodes(nodeId, this.buildContext(state));
    // 纯循环控制节点（无 command 且仅 loop 分支）平时不产生路由条目，仅在 breakCondition
    // 评估跳出（loopMeta）时回写；带 condition/并行分支的决策节点始终记录 branchMeta。
    const isLoopControl = step.command === undefined
      && (step.branches ?? []).every(branch => branch.loop !== undefined);
    const hasBranchMeta = routed.branchMeta !== undefined;
    const hasLoopMeta = routed.loopMeta !== undefined;
    if (!isLoopControl || hasBranchMeta || hasLoopMeta) {
      const inLoopRouting = loopManager.buildLoopIterationPath().length > 0;
      // 新模型下路由门 visitCount 由 runLoop 单一递增（处理节点前 +1），路由条目仅快照
      // 当前值，不再 +1、不回写 visitCounts（回边/checkLoopBreak 只读）。等价基准
      // processNode L93-94 递增 + L496 快照。根治缺陷 3：混合分支门每趟回边建条目并
      // 递增叠加回边计数的双重计数。
      const entryVisitCount = visitCounts[nodeId] ?? 0;
      const routingEntry: ExecutedStepDefault = {
        id: newExecId(),
        stepId: step.id,
        stageId: stageDef.id,
        name: step.name ?? step.id,
        status: 'completed',
        createdAt: now(),
        attemptIndex: 0,
        startedAt: now(),
        updatedAt: now(),
        visitCount: entryVisitCount,
        ...(inLoopRouting ? { loopIteration: loopManager.buildLoopIterationPath() } : {}),
        ...(hasBranchMeta ? { branchMeta: routed.branchMeta } : {}),
        ...(hasLoopMeta ? { loopMeta: routed.loopMeta } : {}),
      };
      state.executedSteps.push(routingEntry);
      // 先入队再 persist（崩溃窗口闭合：单次 persist 快照即含新 nexts——审查第 4/7 项）。
      this.enqueue(routed.nextNodeIds, state);
      await this.persist(routingEntry, state);
    } else {
      // 纯循环控制节点（无 command 且仅 loop 分支）不产路由条目：nexts 仍需入队
      // （等价旧 `state.nextBatch.push(...)` 的无条件分支）。
      this.enqueue(routed.nextNodeIds, state);
    }
  }

  /** 命令节点：run + finalize + resolveNextNodes；ask 中断 / 失败 / 暂停时返回对应标记。 */
  private async processCommandNode(nodeId: string, step: WorkflowStep, state: StageRunState): Promise<'ok' | 'ask' | 'failed' | 'paused'> {
    const { stageDef, input, sharedState, signal, hooks, loopManager, visitCounts } = this.options;
    const command = step.command;
    const inLoop = loopManager.buildLoopIterationPath().length > 0;
    // executed.id = 执行段唯一 id（纯 UUID）；childId = sessionMeta 子代理占位/真实会话
    // id（两者解耦：同一 Step 多次执行段各自新 id，子代理会话 id 可复用/由 onChildStarted 更新）。
    const childId = inLoop ? loopManager.getActualStepId(step.id) : synthesizeChildId(step.id);
    // 新模型下 visitCount 由 runLoop 单一递增（处理节点前 +1），这里只快照当前值进 entry
    // （等价基准 processNode L93-94 递增 + L496 快照），不再 +1、不回写 visitCounts。
    // 根治命令门双重计数（缺陷 3 case ①）：命令门自回边再递增与 processCommandNode 递增叠加。
    const executed: ExecutedStepDefault = {
      id: newExecId(),
      stepId: step.id,
      stageId: stageDef.id,
      name: step.name ?? step.id,
      status: 'running',
      createdAt: now(),
      attemptIndex: 0,
      startedAt: now(),
      ...(command === undefined ? {} : { command }),
      ...(step.inputFrom === undefined ? {} : { inputFrom: step.inputFrom }),
      ...(step.outputTo === undefined ? {} : { outputTo: step.outputTo }),
      ...(step.passThroughVars === undefined ? {} : { passThroughVars: step.passThroughVars }),
      ...(command === undefined
        ? {}
        : { sessionMeta: { childId, synthetic: true, command: command.type } }),
      visitCount: visitCounts[nodeId] ?? 0,
      ...(inLoop ? { loopIteration: loopManager.buildLoopIterationPath() } : {}),
    };

    hooks?.onStepStart(step, childId);
    // 持久化 running 快照（暂停定位与崩溃恢复需要 executedSteps 含运行中 Step）。
    await this.persist(executed, state);

    if (command === undefined) {
      const message = `step '${step.id}' has no command`;
      executed.status = 'failed';
      executed.error = message;
      executed.updatedAt = now();
      state.executedSteps.push(executed);
      hooks?.onStepFailed(step, childId, message);
      await this.persist(executed, state);
      state.status = 'failed';
      state.errorDetail = message;
      this.options.commitState?.({ status: 'failed', errorDetail: message });
      return 'failed';
    }

    try {
      const loopContext = loopManager.getLoopIterationContext();
      // 缺陷 7 修复：3 级合并解析任务规则（step ∪ stage → workflow.rules 查内容），
      // 非空时注入 StepRunRequest.resolvedRules → buildPromptText 渲染 `## 任务规则` 节。
      // 仅命令节点计算（路由节点无 AI 提示词）；shell Step 无 AI 提示词，resolvedRules
      // 经 request 传递但 runShell 不消费（与基准 shell 不适用规则一致）。
      const resolvedRules = resolveStepRules(this.options.workflowDef, stageDef, step);
      const result = await this.runner.run({
        step,
        executedId: executed.id,
        workdir: sharedState.cwd,
        originalInput: input.originalInput,
        previousOutputs: state.previousOutputs,
        passThroughVars: toVarMap(state.passThroughVars),
        stageId: stageDef.id,
        loopTurn: loopContext.loopTurn,
        loopMaxIterations: loopContext.loopMaxIterations,
        ...(signal === undefined ? {} : { signal }),
        ...(Object.keys(resolvedRules).length === 0 ? {} : { resolvedRules }),
      });
      return await this.finishCommandNode(nodeId, step, childId, executed, result, state);
    } catch (error) {
      // 暂停判定：**以 settle stopReason 为权威**（对齐 DSH `subagent/end`）。
      //
      // `collectSubagentOutput` 在 settle(stopReason=`aborted`) 时抛 `STEP_PAUSED`
      // sentinel（`fatal: false`）——interrupt 打断后 DSH continuation manager 销毁子代理
      // 并 emit `subagent/end`(`aborted`)，经 `sandore/subagent-settled` 路由到这里。命中即
      // Step 保持 paused（不落 failed、不发 step-failed）；未命中（`STEP_EXECUTION`/模型失败/
      // 真正取消类错误）落 failed。**不再依赖暂停登记表兜底**：settle stopReason 自然区分
      // aborted（暂停）与 error（失败）。暂停登记表仍由 lifecycle-manager 维护（持久化/实例
      // status），但不再是 step 完成判定的决策源。
      if (error instanceof SandoreError && error.code === 'STEP_PAUSED') {
        executed.status = 'paused';
        executed.updatedAt = now();
        state.executedSteps.push(executed);
        state.status = 'paused';
        state.pendingPaused = { nodeId, step, executed, childId: this.realChildIds.get(step.id) ?? childId };
        this.options.commitState?.({ status: 'paused' });
        return 'paused';
      }
      const message = describeError(error);
      executed.status = 'failed';
      executed.error = message;
      executed.updatedAt = now();
      // 失败时同步真实子代理 childId（onChildStarted 已记录），供重试/暂停反查真实 child 续跑。
      const realChildId = this.realChildIds.get(step.id);
      if (executed.sessionMeta !== undefined && realChildId !== undefined) {
        executed.sessionMeta = { ...executed.sessionMeta, childId: realChildId, synthetic: false };
      }
      state.executedSteps.push(executed);
      hooks?.onStepFailed(step, realChildId ?? childId, message);
      await this.persist(executed, state);
      state.status = 'failed';
      state.errorDetail = message;
      this.options.commitState?.({ status: 'failed', errorDetail: message });
      return 'failed';
    }
  }

  /**
   * 命令节点执行成功后的公共收尾（5 阶段重构）：回填输出/会话元数据 →
   * **Phase A**（评估，ask 保底判断）→ **Phase B**（收尾：透传变量回写 + finalizeMeta）
   * → **Phase C**（门禁：primary 纯代码产物校验 + secondary AI 审查）→ 压缩输出 →
   * 事件 → 推进下一批。
   * 首次执行、暂停续跑与崩溃恢复/重试续跑共用：`executed` 仅在尚未进入
   * executedSteps 时纳入（按唯一执行 id 去重），暂停续跑已在列表中则原地复用。
   *
   * **persist 时序（4.12）**：P1 running 段创建（processCommandNode）→ P2 failed
   * （本方法/runPhaseC 失败路径）→ P3 completed（completeAfterFinalize 末段）→
   * P4 running 段创建（resumePendingPaused）。
   */
  private async finishCommandNode(
    nodeId: string,
    step: WorkflowStep,
    childId: string,
    executed: ExecutedStepDefault,
    result: StepRunResult,
    state: StageRunState,
  ): Promise<'ok' | 'ask' | 'failed'> {
    const { stageDef, hooks } = this.options;
    // 偏离 1：入口**不设 completed**——段保持 running 走完全部收尾阶段（Phase A/B/C），
    // 由 completeAfterFinalize 末段统一置 completed（status 流：
    // running → [interacting（仅 state.status）] → running → completed）。
    executed.updatedAt = now();
    executed.output = result.output;
    // §3.8A：真实子代理会话消息随结果带出，写入段快照（onPersist 持久化定格；
    // shell 无该字段 → 前端走 fallback）。
    if (result.sessionMessages !== undefined) {
      executed.sessionMessages = result.sessionMessages;
    }
    if (result.sessionMeta !== undefined) {
      executed.sessionMeta = {
        childId: result.sessionMeta.childId ?? childId,
        synthetic: result.sessionMeta.synthetic,
        command: result.sessionMeta.command,
      };
    }
    if (!state.executedSteps.some(item => item.id === executed.id)) {
      state.executedSteps.push(executed);
    }
    // step-completed 事件保持原位（首次完成即发一次；ask/gate 后不重发，resume 路径不再触发）。
    hooks?.onStepCompleted(step, result.sessionMeta?.childId ?? childId, result.output);

    const gates = mergeGates(this.options.workflowDef, stageDef, step);
    const context = await this.buildFinalizeContext(step, executed, state);

    // Phase A：评估（ask 保底判断）。shell 步骤跳过（Round 20：shell 无收尾压缩、
    // 命令输出直接展示，跳过评估/ask 通道）→ 直接进 Phase B/C。
    const isShellStep = step.command?.type === 'shell';
    if (!isShellStep) {
      const phaseA = await this.runPhaseA(nodeId, step, executed, context, gates, state);
      if (phaseA.kind === 'ask') {
        return 'ask';
      }
    }

    // Phase B：收尾（真 fork 子代理重新评估）→ Phase C：门禁（primary 纯代码产物校验
    // + secondary AI 审查）→ 尾段。
    return await this.runPhasesBC(nodeId, step, childId, executed, context, gates, state);
  }

  /** 组装收尾上下文（input + output 文本 + 产物文件；缺陷 16/34：artifacts 直接收集）。 */
  private async buildFinalizeContext(
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    state: StageRunState,
  ): Promise<FinalizeStepContext> {
    // 缺陷 16：<artifacts> 块由 collectStepArtifacts 直接收集产物文件（compress 已移至
    // Phase C 后、completed 前——4.11——不再先于收尾提供 files）；executed.outputTo 自
    // processCommandNode 从 step.outputTo 拷贝，故 executed 收集即 step 收集。
    // 缺陷 34：传引擎累加器 vars（pre-finalize 快照，自引用变量此时未提取→deferred）。
    const artifacts = (await collectStepArtifacts(this.options.ctx.fs, step, this.options.sharedState.cwd, toVarMap(state.passThroughVars))).flatMap(a => a.value);
    // Round 26：把该步实际产物写入段快照（onPersist 持久化）——运行中（stage 未完成、
    // stageContracts 为空）导航树也能展示该步产物；stage 契约仍是 stage 级权威汇总。
    if (artifacts.length > 0) {
      executed.artifacts = artifacts;
    }
    return {
      input: this.options.input.originalInput,
      output: textSummary(executed.output),
      artifacts,
    };
  }

  /** Phase B → Phase C → Phase D（routing）→ 尾段（finishCommandNode 与 resumePendingAsk 共用）。 */
  private async runPhasesBC(
    nodeId: string,
    step: WorkflowStep,
    childId: string,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    state: StageRunState,
  ): Promise<'ok' | 'failed'> {
    // Phase B：**真 fork 子代理收尾处理**（偏离 2：不复用 Phase A 结果——ask 轮次后
    // 子代理会话已有新消息，必须从最新事件重建评估；一个 LLM 调用返回合并 JSON
    // passThroughVars + compressedOutput；透传变量回写 + finalizeMeta
    // currentPhase='finalizing'）。
    const phaseBResult = await this.runPhaseB(step, executed, context, gates, state);
    // Phase C：门禁（primary 纯代码产物校验 + secondary AI 审查；secondaryEnabled 时
    // 才单独建宿主子代理跑审查）。
    const phaseC = await this.runPhaseC(step, childId, executed, context, gates, phaseBResult, state);
    if (phaseC.kind === 'failed') {
      return 'failed';
    }
    // Phase C 通过后：Phase D（routing 落盘 + 路由判断）→ previousOutputs（Phase B 压缩
    // 摘要）→ finalizeMeta 终态 → 推进下一批。门禁失败不执行 Phase D（上方已短路）。
    await this.completeAfterFinalize(nodeId, step, childId, executed, context, gates, phaseBResult, phaseC.gateResult, state);
    return 'ok';
  }

  /**
   * Phase A：评估（ask 判定 + 透传变量提取 + ask 保底判断，**不判完成度**）。
   *
   * 跳过检查（无未解析透传变量且无门禁 → 零 AI 调用直接 ok）；否则 `assessOnly` 只跑
   * 评估器——**临时会话**（`llm.stream` 直调，不 fork、不维持），输入 = `<stepContext>`
   * （`buildFinalizeContext` 已含当前 step 子代理返回结果 output 文本），结果
   * （hasAsk/askQuestion）落 finalizeMeta 持久化，**不写回透传变量**（透传变量只在
   * Phase B 写回）。`hasAsk` + askQuestion 载荷 → Step 置 interacting（finalizeMeta
   * currentPhase='ask-detect'，**不记录顶层 assessSessionId**）+ persist + 挂回
   * pendingAsk + 返回 'ask'（引擎级 ask 闭环）。`rounds` 为已发生的 ask 轮次（首次 0）；
   * 达到 {@link MAX_FINALIZE_ASK_ROUNDS} 后不再续问，把最后 output 视为完成（hasAsk
   * 保留在结果中，按普通输出推进 Phase B/C）。
   *
   * **Phase A 评估不 fork 会话（收尾真 fork 改造）**：DSH 子代理 settle 后 live store
   * 已移除，`sessions.fork(childId)` 必然 SESSION_NOT_FOUND（评估曾降级为无上下文的
   * 临时会话）——现直接临时会话直调（评估输入已含 output 文本），无 fork 会话可回收。
   */
  private async runPhaseA(
    nodeId: string,
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    state: StageRunState,
    rounds = 0,
  ): Promise<PhaseAResult> {
    const needsAssess = hasUnresolvedPassThroughVars(step);
    const hasGates = hasEnabledGates(gates);
    // 零 AI 调用跳过：无未解析透传变量 + 无门禁 → 直接跳过评估（不写 finalizeMeta）。
    if (!needsAssess && !hasGates) {
      return { kind: 'ok', assessResult: undefined, gates };
    }
    const finalizeManager = this.options.finalizeManager;
    const assessResult = await finalizeManager.assessOnly(
      this.buildFinalizeRequest(step, executed, context, gates, state),
    );
    if (assessResult.hasAsk && rounds < MAX_FINALIZE_ASK_ROUNDS) {
      // ask 保底通道：评估判定需向用户提问 → Step 保持 running（偏离 8：interacting
      // 只设 state.status，executed.status 在 ask 中断 persist 时仍为 running），
      // finalizeMeta currentPhase='ask-detect'（引擎 findAskStep 依 ask-detect 标记
      // 而非 interacting status 定位 ask Step）。
      const askResult: FinalizeAskResult = {
        status: 'done',
        hasAsk: assessResult.hasAsk,
        passThroughVars: assessResult.passThroughVars,
        forkSessionId: assessResult.forkSessionId,
        assessmentRaw: assessResult.assessmentRaw,
        ...(assessResult.askQuestion !== undefined ? { askQuestion: assessResult.askQuestion } : {}),
        ...(assessResult.compressedOutput !== undefined ? { compressedOutput: assessResult.compressedOutput } : {}),
      };
      await finalizeManager.commitFinalize(
        this.buildFinalizeRequest(step, executed, context, gates, state),
        undefined,
        undefined,
        'ask-detect',
        { askResult },
      );
      // ask 中断点持久化（崩溃恢复需要 running Step 快照含 finalizeMeta currentPhase='ask-detect'）。
      await this.persist(executed, state);
      state.pendingAsk = { nodeId, step, executed, rounds: rounds + 1 };
      state.status = 'interacting';
      this.options.commitState?.({ status: 'interacting' });
      return { kind: 'ask' };
    }
    if (assessResult.hasAsk) {
      // 达到轮次上限：不再续问，最后 output 视为完成（hasAsk 保留在结果中）。
      this.options.ctx.logger.warn(
        `sandore: step ${step.id} finalize ask exceeded ${MAX_FINALIZE_ASK_ROUNDS} rounds; treating last output as completed`,
      );
    }
    return { kind: 'ok', assessResult, gates };
  }

  /**
   * Phase B：收尾——**真 fork 子代理收尾处理**（偏离 2 修复 + 收尾真 fork 改造）。
   *
   * 不复用 Phase A 的评估结果：ask 轮次后真实子代理会话已基于回答产生新消息，
   * Phase B 必须从最新会话状态重新评估（透传变量提取 + 输出压缩合并），以该结果为
   * 权威（Phase C 门禁与 completed finalizeMeta 均以它为准）。**不再 `sessions.fork`**——
   * DSH 子代理 settle 后 live store 已移除，`sessions.fork(childId)` 必然
   * SESSION_NOT_FOUND；改经 `FinalizeManager.assessForked`（`forkStepSubagent`）从
   * step 子代理完整事件（live → 持久化 inspect）截到闭合 turn 作 seed，
   * `ctx.agents.create` 重建宿主主代理的子代理（meta `parentSession: hostAgent.id` +
   * `origin:'subagent'`），**一个 LLM 调用返回合并 JSON `{"passThroughVars": {...},
   * "compressedOutput": "..."}`**（透传变量提取 + compress 输出压缩合并，替代原
   * compressStepOutput 的 returnPrompt 产物，落入 previousOutputs）；JSON 解析不满足 →
   * 给同一个 fork 子代理 followup 错误提示重新返回，上限 3 次，超限报错（Step 落
   * failed）；fork/驱动失败降级临时会话并记 errorDetail（不失败）。评估完 `dispose()`。
   * 返回 Phase B 的结果（含 compressedOutput）；跳过检查与 Phase A 同谓词
   * （无未解析透传变量且无门禁 → Phase A 未评估，Phase B 亦不重评估，保持零 AI
   * 调用），此时返回 undefined。
   *
   * `commitFinalize('finalizing')` 把 Phase B 的 `forkSessionId` 持久化为顶层
   * `assessSessionId`（偏离 3：Phase A 评估用完即删、不持久化；自 Phase B 起才落
   * state）。**透传变量写回仅在本阶段执行**（commitFinalize 按 currentPhase 门控）。
   *
   * **Round 20（shell 跳过）**：shell 步骤直接返回 undefined（跳过 assess）——
   * shell 无收尾压缩、命令输出直接展示，且 shell 的 passThroughVars refresh 提取
   * 另行设计；Phase C 门禁对 shell 不跳过（primary 纯代码产物校验仍生效）。
   */
  private async runPhaseB(
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    state: StageRunState,
  ): Promise<FinalizeAssessResult | undefined> {
    // shell 步骤跳过 Phase B assess（Round 20）；非 shell 与旧谓词一致
    // （无未解析透传变量且无门禁 → 不重评估）。
    const isShellStep = step.command?.type === 'shell';
    if (isShellStep || (!hasUnresolvedPassThroughVars(step) && !hasEnabledGates(gates))) {
      return undefined;
    }
    // 预置 currentPhase='finalizing'（评估耗时期间 UI 展示「收尾中」；commitFinalize 落终态）。
    executed.finalizeMeta = { ...executed.finalizeMeta, currentPhase: 'finalizing' };
    const request = this.buildFinalizeRequest(step, executed, context, gates, state);
    // Round 17：onForkCreated 回调——fork 子代理创建后立即 commit running 快照（含真实 forkSessionId）。
    // 替代原空快照 commit（原 assessResult=undefined 注入空 forkSessionId），使 UI「收尾中」badge 可点击。
    const phaseBResult = await this.options.finalizeManager.assessForked({
      ...request,
      onForkCreated: (forkSessionId: string) => {
        const runningResult: FinalizeAssessResult = {
          status: 'running',
          passThroughVars: {},
          forkSessionId,
          assessmentRaw: '',
        };
        void this.options.finalizeManager.commitFinalize(request, runningResult, undefined, 'finalizing');
      },
    });
    await this.options.finalizeManager.commitFinalize(request, phaseBResult, undefined, 'finalizing');
    return phaseBResult;
  }

  /**
   * Phase C：门禁（primary 纯代码产物校验 + secondary AI 门禁审查）。
   *
   * 门禁启用才运行（hasEnabledGates）；primary 为纯代码产物校验（零 AI、不建子代理），
   * secondary 显式启用才单独 `agents.create` 建宿主主代理的子代理（无 seed，prompt
   * 携带 stepContext）跑 AI 门禁审查（gateSessionId = 子代理 id，持久化到 state）。
   * 未通过 → Step failed（finalizeMeta currentPhase='gating' + gateResult + errorDetail）
   * + P2 持久化 + onStepFailed。门禁禁用 → ok 无结果。
   */
  private async runPhaseC(
    step: WorkflowStep,
    childId: string,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    assessResult: FinalizeAssessResult | undefined,
    state: StageRunState,
  ): Promise<PhaseCResult> {
    if (!hasEnabledGates(gates)) {
      return { kind: 'ok', gateResult: undefined };
    }
    const finalizeManager = this.options.finalizeManager;
    const request = this.buildFinalizeRequest(step, executed, context, gates, state);
    // Round 11：门禁评估前先 commit running 快照（evaluateGates 耗时期间 UI 显示「门禁中」）。
    await finalizeManager.commitFinalize(request, assessResult, undefined, 'gating');
    // 门禁启用 ⇒ 评估必已运行（runPhaseA 跳过条件为无变量且无门禁）；兜底空评估仅供类型。
    const gateResult = await finalizeManager.evaluateGates(request, assessResult ?? EMPTY_ASSESS_RESULT);
    if (!gateResult.gatesPassed) {
      const message = gateResult.errorDetail ?? 'gate evaluation failed';
      executed.status = 'failed';
      executed.error = message;
      executed.updatedAt = now();
      await finalizeManager.commitFinalize(request, assessResult, gateResult, 'gating');
      this.options.hooks?.onStepFailed(step, executed.sessionMeta?.childId ?? childId, message);
      await this.persist(executed, state);
      state.status = 'failed';
      state.errorDetail = message;
      this.options.commitState?.({ status: 'failed', errorDetail: message });
      return { kind: 'failed', message };
    }
    // 门禁通过：也落 gating（记录门禁通过事实，UI 显示「已门禁」badge）。
    // commitFinalize 幂等（buildFinalizeMeta 的 phaseHistory 去重相邻相同值），
    // gating 不写回透传变量（透传变量只在 Phase B 'finalizing' 写回，commitFinalize
    // 已按 currentPhase 门控）。
    await finalizeManager.commitFinalize(request, assessResult, gateResult, 'gating');
    return { kind: 'ok', gateResult };
  }

  /**
   * 收尾公共尾段（Phase C 通过后、completed 前，定稿四阶段）：
   * **Phase D（routing）**：门禁通过后落 `currentPhase='routing'`，再做循环/条件路由
   * 判断（resolveNextNodes，内部 AI 判断走 fork 子代理机制）→ previousOutputs（Phase B
   * JSON 的 compressedOutput 压缩摘要，替代原 compressStepOutput）→ finalizeMeta 终态
   * （currentPhase='completed'）→ P3 持久化 → 推进下一批。**门禁失败不执行 Phase D**
   * （runPhasesBC 已短路，路由结果不应用）。finishCommandNode 与 resumePendingAsk 共用。
   */
  private async completeAfterFinalize(
    nodeId: string,
    step: WorkflowStep,
    childId: string,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    phaseBResult: FinalizeAssessResult | undefined,
    gateResult: GateEvalResult | undefined,
    state: StageRunState,
  ): Promise<'ok'> {
    const buildRequest = () => this.buildFinalizeRequest(step, executed, context, gates, state);
    const hasFinalize = phaseBResult !== undefined || gateResult !== undefined;
    // Phase D（routing）：门禁通过后、completed 前，落 currentPhase='routing' 再做循环/
    // 条件路由判断（UI 展示「路由中」；commitFinalize('completed') 落终态）。
    if (hasFinalize) {
      await this.options.finalizeManager.commitFinalize(buildRequest(), phaseBResult, gateResult, 'routing');
    }
    const routed = await this.options.stepNavigator.resolveNextNodes(nodeId, this.buildContext(state));
    // Phase D 路由结果写入 finalizeMeta.routingResult（不再写入 executed 顶层 branchMeta/loopMeta）。
    const routingResult: RoutingResult | undefined = routed.branchMeta !== undefined || routed.loopMeta !== undefined
      ? {
          status: 'done',
          ...(routed.branchMeta !== undefined ? { branchMeta: routed.branchMeta } : {}),
          ...(routed.loopMeta !== undefined ? { loopMeta: routed.loopMeta } : {}),
          routingSessionId: routed.branchMeta?.sessionId ?? routed.loopMeta?.sessionId,
        }
      : undefined;
    // previousOutputs：Phase B JSON 的 compressedOutput（压缩摘要，替代原
    // compressStepOutput 的 returnPrompt 产物）；无 Phase B 结果/空摘要时兜底
    // textSummary(output)（缺陷 16 内收集产物文件填 base.files）。
    const previousOutput = await this.buildPhaseBPreviousOutput(executed, phaseBResult?.compressedOutput, state);    state.previousOutputs.push(previousOutput);
    // finalizeMeta 终态（currentPhase='completed'；含 gateResult；vars 已由 Phase B 回写，
    // 此处幂等重写）。
    if (hasFinalize) {
      await this.options.finalizeManager.commitFinalize(buildRequest(), phaseBResult, gateResult, 'completed', routingResult !== undefined ? { routingResult } : undefined);
    }
    // 偏离 1：收尾全流程保持 running，**最后才置 completed**（P3 completed 持久化携带
    // 终态 status；无中间 completed 脏状态）。
    executed.status = 'completed';
    executed.updatedAt = now();
    // 先入队再 P3 persist（崩溃窗口闭合：单次 persist 快照即含新 nexts——审查第 4/7 项；
    // enqueue 保持无条件——ask/paused 续跑必须重拉这些 next）。
    this.enqueue(routed.nextNodeIds, state);
    await this.persist(executed, state);
    // Round 23：**不 commit 引擎级 completed**——引擎级 status='completed' 只在工作流
    // 真正完成时统一设置（workflow-engine L1480 唯一设点）。中途 commit 会把 ask 工具
    // 注入 gate 的 TERMINAL_STATUSES（completed ∈ 终态集）命中 → 循环回跳/后续 ask
    // step 的子代理不再注入 sandore 版 ask 工具 → 全局版工具 headless 挂起（真实 e2e
    // 2026-08-25 根因）。终态（failed/paused/interacting）仍由各失败路径无条件写。
    return 'ok';
  }

  /**
   * 组装 previousOutputs 条目（Phase B 压缩摘要 → returnPrompt）。
   *
   * 定稿：Phase B JSON 的 `compressedOutput` 即压缩摘要（替代原 compressStepOutput 的
   * fork 压缩），无 Phase B 结果/空摘要时兜底 `textSummary(output)`（对齐原
   * compressStepOutput 降级路径）。产物文件收集（缺陷 16）保持：`toPreviousOutput`
   * 的 `files` 填实际命中文件（`<artifacts>` 块）。
   */
  private async buildPhaseBPreviousOutput(
    executed: ExecutedStepDefault,
    compressedOutput: string | undefined,
    state: StageRunState,
  ): Promise<PreviousStepOutput> {
    // 缺陷 16/34：用引擎累加器值替换 outputTo 中的 ${xxx}（自引用变量此时已由
    // Phase B commitFinalize('finalizing') 写回 state.passThroughVars——与
    // buildFinalizeContext 的 pre-finalize 快照不同，能解析自引用变量）。
    const artifacts = (await collectStepArtifacts(this.options.ctx.fs, executed, this.options.sharedState.cwd, toVarMap(state.passThroughVars))).flatMap(a => a.value);
    // 2026-08-25（导航产物缺失修复）：Phase B 后的收集结果**写回段快照**——buildFinalizeContext
    // 的早期收集用 pre-finalize vars，自引用变量（outputTo 引用本 step 提取的 ${xxx}）
    // 解析不了会收集空 → 导航无产物；而门禁用合并 vars 能通过（「门禁过但导航无产物」根因）。
    // 此处用写回后的 vars 重收集并覆盖段快照，保证最终产物与门禁一致。
    if (artifacts.length > 0) {
      executed.artifacts = artifacts;
    }
    const base = toPreviousOutput(executed, artifacts);
    return compressedOutput === undefined || compressedOutput === '' ? base : { ...base, returnPrompt: compressedOutput };
  }

  /** 组装收尾请求（stepSessionId = 真实子代理会话 id，供 Phase A/C fork）。 */
  private buildFinalizeRequest(
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    state: StageRunState,
  ): FinalizeStepRequest {
    return {
      step,
      executedStep: executed,
      ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
      context,
      ...(gates === undefined ? {} : { gates }),
      workdir: this.options.sharedState.cwd,
      passThroughVars: state.passThroughVars,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      // 收尾阶段流转钩子透传（commitFinalize 写入 currentPhase 后触发；引擎侧双发事件）。
      ...(this.options.hooks?.onPhaseChange === undefined
        ? {}
        : { onPhaseChange: this.options.hooks.onPhaseChange }),
      // Round 7 修复：注入 onPersist，使 commitFinalize 内可触发逐阶段持久化。
      // 引擎侧 onPersist（workflow-engine.ts）将 executedStep upsert 进
      // active.state.executedSteps 并 persistState，保证事件发出前 active.state 已含
      // 最新 finalizeMeta（中间态立即可见）。
      ...(this.options.onPersist === undefined
        ? {}
        : { onPersist: (executedStep: ExecutedStepDefault) => this.options.onPersist!(executedStep) }),
    };
  }

  /**
   * pause 后从断点续跑：基于被暂停段**新建执行段**（新 id + attemptIndex+1 + createdAt，
   * sessionMeta 保持原 childId）后重新收集子代理输出 + 公共收尾。
   *
   * 段创建权归执行器（§3.5 定夺）：lifecycle 的 resumeStep 只负责 followup/登记表/消息/事件，
   * 新段由这里创建——旧 paused 段保持定格快照，新段以新 id 走 finishCommandNode 追加。
   */
  private async resumePendingPaused(state: StageRunState): Promise<'ok' | 'ask' | 'failed' | 'paused'> {
    const pending = state.pendingPaused!;
    state.pendingPaused = undefined;
    const base = pending.executed;
    // 新段继承旧段快照但清除暂停/失败细节（exactOptionalPropertyTypes 下不能赋 undefined，
    // 用解构剔除字段；sessionMeta 保持原 childId，仅清暂停细节）。
    const { pausedAt: _pausedAt, error: _error, ...rest } = base;
    const segment: ExecutedStepDefault = {
      ...rest,
      id: newExecId(),
      attemptIndex: (base.attemptIndex ?? 0) + 1,
      createdAt: now(),
      startedAt: now(),
      status: 'running',
      ...(base.sessionMeta === undefined ? {} : { sessionMeta: { ...base.sessionMeta, childId: pending.childId } }),
    };
    // running 新段先持久化（崩溃恢复/暂停定位需要 executedSteps 含运行中 Step）。
    await this.persist(segment, state);
    return this.resumeSubagentStep(state, pending.nodeId, pending.step, segment, pending.childId);
  }

  /** 续跑子代理 Step 的公共尾段：重新收集输出 + 公共收尾（finishCommandNode）。 */
  private async resumeSubagentStep(
    state: StageRunState,
    nodeId: string,
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    childId: string,
  ): Promise<'ok' | 'ask' | 'failed' | 'paused'> {
    const command = step.command;
    if (command === undefined || (command.type !== 'agent' && command.type !== 'skill' && command.type !== 'mcp' && command.type !== 'prompt')) {
      // 理论不可达：续跑仅对子代理 Step 生效（shell 由 recovery/lifecycle 守卫拦截）。
      const message = `step '${step.id}' is not a resumable subagent step`;
      executed.status = 'failed';
      executed.error = message;
      executed.updatedAt = now();
      await this.persist(executed, state);
      state.status = 'failed';
      state.errorDetail = message;
      this.options.commitState?.({ status: 'failed', errorDetail: message });
      return 'failed';
    }
    try {
      const result = await this.runner.resumeSubagent(command.type, childId, step.id, this.options.stageDef.id, this.options.signal);
      return await this.finishCommandNode(nodeId, step, childId, executed, result, state);
    } catch (error) {
      // 续跑重收集输出失败（子代理无输出/模型错误等）：与首次执行一致落 failed。
      // e2e 确认（2026-08）：此前异常直接冒泡，新段停在 running 造成「实例 failed +
      // 段 running」不一致（retry 场景显式暴露）。续跑路径若再次被 interrupt（settle
      // aborted）则抛 STEP_PAUSED——续跑期间用户可再次暂停，此时落回 paused（pendingPaused）。
      if (error instanceof SandoreError && error.code === 'STEP_PAUSED') {
        executed.status = 'paused';
        executed.updatedAt = now();
        state.executedSteps.push(executed);
        state.status = 'paused';
        state.pendingPaused = { nodeId, step, executed, childId: this.realChildIds.get(step.id) ?? childId };
        this.options.commitState?.({ status: 'paused' });
        return 'paused';
      }
      const message = describeError(error);
      executed.status = 'failed';
      executed.error = message;
      executed.updatedAt = now();
      const realChildId = this.realChildIds.get(step.id);
      if (executed.sessionMeta !== undefined && realChildId !== undefined) {
        executed.sessionMeta = { ...executed.sessionMeta, childId: realChildId, synthetic: false };
      }
      this.options.hooks?.onStepFailed(step, realChildId ?? childId, message);
      await this.persist(executed, state);
      state.status = 'failed';
      state.errorDetail = message;
      return 'failed';
    }
  }

  /**
   * ask 回复后从断点续跑（4.7 简化）：真实子代理先重收集新 output，随后统一走
   * 3 阶段收尾（Phase A 重评估 → Phase B 重新 fork + 重新 assess → Phase C 门禁
   * [primary 纯代码校验 + secondary AI]）→ 压缩 → 推进。
   *
   * 简化点（对比旧双路径实现）：
   * - 真实子代理（synthetic === false）重收集新 output 后与首次执行**共用**
   *   runPhaseA/B/C + completeAfterFinalize（不再重复 finalizeStep/finalizeStepAfterAsk
   *   两套近乎相同的代码路径）；
   * - 无真实会话（shell 等合成 session）无新 output——Phase A 的重评估已消费回答，
   *   直接跑 Phase B/C（Phase B 重新 fork + 重新 assess；Phase B 不处理 hasAsk，
   *   同输出不会重复触发引擎级 ask 闭环）；
   * - 轮次上限（{@link MAX_FINALIZE_ASK_ROUNDS}）由 runPhaseA 内部守卫（rounds 入参），
   *   达到后把最后 output 视为完成（不再续问）。
   */
  private async resumePendingAsk(state: StageRunState): Promise<'ok' | 'ask' | 'failed'> {
    const pending = state.pendingAsk!;
    state.pendingAsk = undefined;
    const { nodeId, step, executed, rounds } = pending;

    const childId = executed.sessionMeta?.childId;
    const commandType = step.command?.type;
    const isRealSubagent = childId !== undefined
      && executed.sessionMeta?.synthetic === false
      && (commandType === 'agent' || commandType === 'skill' || commandType === 'mcp' || commandType === 'prompt');
    // 事件/失败兜底的会话 id（shell 无真实会话时回退执行段 id）。
    const resumeChildId = childId ?? executed.id;

    if (isRealSubagent) {
      // §3.6A：回答已被引擎 followup 注回，重收集子代理基于回答产生的新 output。
      const result = await this.runner.resumeSubagent(commandType!, childId!, step.id, this.options.stageDef.id, this.options.signal);
      executed.output = result.output;
      executed.updatedAt = now();
      // 偏离 1/8：首次 ask 时 executed.status 保持 running（interacting 只设
      // state.status）——重收集输出后置回 running（若重评估再 ask 仅 state.status
      // 置 interacting；error 则置 failed），最终由 completeAfterFinalize 置 completed。
      executed.status = 'running';
      // §3.8A：回答注回后子代理新产出 → 消息行随新输出更新。
      if (result.sessionMessages !== undefined) {
        executed.sessionMessages = result.sessionMessages;
      }
      await this.persist(executed, state);
      // 重新评估（可能再次 ask → 挂回断点续问，受 MAX_FINALIZE_ASK_ROUNDS 保护）。
      const context = await this.buildFinalizeContext(step, executed, state);
      const gates = mergeGates(this.options.workflowDef, this.options.stageDef, step);
      const phaseA = await this.runPhaseA(nodeId, step, executed, context, gates, state, rounds);
      if (phaseA.kind === 'ask') {
        return 'ask';
      }
      return await this.runPhasesBC(nodeId, step, childId, executed, context, gates, state);
    }

    // 无真实会话（shell）：无新 output，直接跑 Phase B/C + 尾段（Phase B 重新
    // fork + 重新 assess——同输出不会重复触发引擎级 ask，Phase B 不处理 hasAsk）。
    // 首次 ask 时 executed.status 保持 running（偏离 1/8）——最终由
    // completeAfterFinalize 置 completed。
    executed.status = 'running';
    executed.updatedAt = now();
    const context = await this.buildFinalizeContext(step, executed, state);
    const gates = mergeGates(this.options.workflowDef, this.options.stageDef, step);
    return await this.runPhasesBC(nodeId, step, resumeChildId, executed, context, gates, state);
  }

  /** 组装 Stage 执行结果（含 Stage 产物契约的异步产物收集）。 */
  private async buildResult(state: StageRunState): Promise<StageExecutionResult> {
    const stageContract = await finalizeStageContract(
      this.options.ctx.fs,
      this.options.sharedState.cwd,
      this.options.stageDef,
      state.executedSteps,
      state.status,
      state.passThroughVars,
      state.errorDetail,
    );
    return {
      stageContract,
      executedSteps: state.executedSteps,
      passThroughVars: state.passThroughVars,
      status: state.status,
      ...(state.errorDetail === undefined ? {} : { errorDetail: state.errorDetail }),
    };
  }

  /**
   * 去重入队（bugfix round22）：纯 push + includes 去重（O(n)，队列小；量大可加 Set 镜像）。
   * 完成节点/路由节点的 nexts 先入队再 persist（崩溃窗口闭合，审查第 4/7 项）；重复路由到
   * 同一后继时只保留一个队列条目（出队点另有 running 去重防重复执行）。
   */
  private enqueue(ids: readonly string[], state: StageRunState): void {
    for (const id of ids) {
      if (!state.pendingQueue.includes(id)) {
        state.pendingQueue.push(id);
      }
    }
  }

  /**
   * 持久化回调封装（缺陷 10 恢复可靠性增强）：snapshot pendingQueue 随 executed 一起
   * 传入 onPersist → 引擎写入 WorkflowTaskState.pendingQueue。崩溃恢复时直接读回
   * pendingQueue → re-queue ready Steps（精确重放，不再反推 DAG next）。
   */
  private async persist(executed: ExecutedStepDefault, state: StageRunState): Promise<void> {
    const pendingQueue = [...state.pendingQueue];
    await this.options.onPersist?.(executed, pendingQueue);
  }
}
