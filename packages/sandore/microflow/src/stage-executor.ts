/**
 * Stage 内部执行器（Task 3：`resolveNextNodes` 驱动的 DAG 调度循环）。
 *
 * 以批量工作队列逐节点执行：路由节点（带 `loop`/`branches` 且无 `command`）直接解析
 * 下一批；命令节点经 {@link StepRunner} 执行后经 {@link FinalizeManager} 收尾（透传
 * 变量提取 + 门禁审查），再经 `resolveNextNodes` 解析下一批。循环节点经
 * {@link LoopManager} 生成带后缀 id、`loopIteration` 与 `visitCount`；agent/skill/mcp
 * 的真实子代理 `sessionMeta`（`synthetic:false`）透传到 `ExecutedStepDefault`。
 * 每个 Step 完成后经 `onPersist` 钩子通知引擎逐 Step 持久化。
 * @module @deepseek-ai/dsh-sandore-microflow/src/stage-executor
 */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';

import type {
  ExecutedStepDefault,
  PassThroughVar,
  StageContract,
  StepStatus,
} from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type { FinalizeAssessResult, DagBranch, GateEvalResult, Gates, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import type { ResolveNextNodesContext, ResolveNextNodesResult, StepNavigator } from './step-navigator.ts';

import type { ConcurrencyLimiter } from './concurrency-limiter.ts';
import { collectStepArtifacts } from './file-utils.ts';
import type { FileSystem } from './file-utils.ts';
import { SandoreError } from './errors.ts';
import { FinalizeManager, hasEnabledGates, hasUnresolvedPassThroughVars } from './finalize-manager.ts';
import type { FinalizeStepContext, FinalizeStepRequest } from './finalize-manager.ts';
import { forkStepSessionMessages } from './fork-session.ts';
import { describeError, resolveProviderModel, textSummary } from './internal.ts';
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
   * pendingQueue 快照）。pendingQueue 为当前 ready/processing Step IDs（batch + nextBatch）。 */
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

/** 为单个 Step 合成占位 childId（`step-{stepId}-{execId 前 8 位}`）。 */
function synthesizeChildId(stepId: string): string {
  const execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `step-${stepId}-${execId}`;
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
  hasAsk: false,
  passThroughVars: {},
  forkSessionId: '',
  assessmentRaw: '',
};

/** runPhaseA 的返回（'ask' = ask 保底中断；ok = 携带评估结果与合并后的门禁配置）。 */
type PhaseAResult =
  | { readonly kind: 'ask' }
  | { readonly kind: 'ok'; readonly assessResult: FinalizeAssessResult | undefined; readonly gates: Gates | undefined };

/** runPhaseC 的返回（'failed' = 门禁未通过；ok = 携带门禁结果）。 */
type PhaseCResult =
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ok'; readonly gateResult: GateEvalResult | undefined };

/**
 * fork 类压缩提示词（补充 36）。
 *
 * fork 当前 step 会话注入全量历史后，要求 LLM 总结关键产出供下一 step 参考——轻量类压缩，
 * 保留关键信息（结果/产物/决策/状态），省略冗余细节，替代原始 textSummary 全量传递。
 */
const COMPRESS_PROMPT =
  '你是严谨的Step输出总结Agent。请基于上方会话历史，总结当前 Step 的关键产出（执行结果、产物、关键决策与状态），供后续 Step 参考使用。只返回总结文本，保留关键信息，省略冗余细节，不要包含无关内容。';

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
  batch: string[];
  batchIndex: number;
  nextBatch: string[];
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
   * resume 断点：崩溃恢复/重试续跑的子代理 Step 列表（多路恢复，缺陷 10）。
   * 从快照播种，resumeSubagents 各自重新收集输出。并发恢复时多个 running/interacting
   * Step 全部入列，execute() 用 Promise.all 并发续跑。
   */
  pendingResumes: ReadonlyArray<{
    readonly nodeId: string;
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    readonly childId: string;
  }>;
  /**
   * between-steps 崩溃续跑标志（缺陷 9 G）：无活跃段但有已完成 Step。execute() 入口
   * 据此从最后完成 Step 反推 DAG next 播种 batch（跳过已完成 Step），避免从 Stage
   * 首步重跑。仅 {@link initState} 的 resumeFrom 分支（`resumeBetweenSteps`）置 true。
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
    if (state.pendingPaused !== undefined) {
      const resumed = await this.resumePendingPaused(state);
      if (resumed !== 'ok') {
        // ask 中断（续跑收尾判定为 ask）或 failed：返回结果，交由引擎 ask/失败循环处理。
        return await this.buildResult(state);
      }
    }
    if (state.pendingResumes.length > 0) {
      const resumed = await this.resumePendingResumes(state);
      if (resumed !== 'ok') {
        return await this.buildResult(state);
      }
    }
    if (state.pendingAsk !== undefined) {
      const resumed = await this.resumePendingAsk(state);
      if (resumed !== 'ok') {
        // 'ask'：新 output 再次判定需提问（断点已重新挂回），引擎 ask 循环再走一轮；
        // 'failed'：收尾失败。两者均返回 buildResult 交引擎处理。
        return await this.buildResult(state);
      }
    }
    // between-steps 崩溃续跑（缺陷 9 G）：无活跃段但有已完成 Step → 从最后完成 Step
    // 反推 DAG next 播种 batch，避免从 Stage 首步重跑已完成 Step（非恰好一次语义）。
    // resumeFrom 播种的 completedSteps 已进 executedSteps/previousOutputs；此处仅决定
    // 本轮 batch 起始位置（剩余未执行 Step）。primary 覆盖线性/分支命令链；循环回边
    // 等边角由保留的循环栈 + StepNavigator 路由承接（超出文档化 gap 的边界场景）。
    if (state.pendingBetweenSteps) {
      state.pendingBetweenSteps = false;
      const lastSeeded = state.executedSteps[state.executedSteps.length - 1];
      const lastNodeId = lastSeeded?.stepId;
      if (lastNodeId !== undefined) {
        const routed = await this.options.stepNavigator.resolveNextNodes(lastNodeId, this.buildContext(state));
        state.batch = [...new Set(routed.nextNodeIds)];
        state.batchIndex = 0;
        if (state.batch.length === 0) {
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
    // 合并顺序：定义默认值（collectPassThroughVars）在前、input 已提取/已持久化值
    // 在后——已提取值覆盖定义默认值，对齐基准「first-wins + 非空提取值优先于定义
    // 默认值」语义（缺陷 15 残余差异二）。消除跨 Stage 同名变量场景下后置 Stage 的
    // 定义默认值覆盖前置 Stage 已提取值的 bug（A 提取 projectName、B 声明同名默认
    // 值 → B 不再覆盖 A 的提取值）。input 为空（首次执行）时退化为纯定义默认值。
    const passThroughVars: Record<string, PassThroughVarValue> = {
      ...collectPassThroughVars(this.steps),
      ...(input.passThroughVars as Record<string, PassThroughVarValue>),
    };
    // 崩溃恢复/重试续跑播种：跳过已完成 Step，续跑指定子代理 Step 列表 + pendingQueue re-queue。
    const resumeFrom = this.options.resumeFrom;
    if (resumeFrom !== undefined) {
      const { completedSteps, resumeSubagents, resumeBetweenSteps, pendingQueue } = resumeFrom;
      // 逐 Step 收集产物文件（填 previousOutputs.files → 前置产物 <artifacts> 块）。
      const artifactsPerStep = await Promise.all(
        completedSteps.map(s => collectStepArtifacts(this.options.ctx.fs, s, this.options.sharedState.cwd, toVarMap(passThroughVars))),
      );
      // pendingQueue 直接播种为初始 batch（精确重放，缺陷 10 恢复可靠性增强）。
      const initialBatch = pendingQueue !== undefined && pendingQueue.length > 0
        ? [...pendingQueue]
        : [];
      return {
        stepIndex,
        executedSteps: [...completedSteps],
        previousOutputs: completedSteps.map((s, i) =>
          toPreviousOutput(s, artifactsPerStep[i]!.flatMap(a => a.value)),
        ),
        passThroughVars,
        batch: initialBatch,
        batchIndex: 0,
        nextBatch: [],
        status: 'running',
        errorDetail: undefined,
        pendingAsk: undefined,
        pendingPaused: undefined,
        // 多路恢复：并发崩溃时多个 running/interacting 段各自续跑（缺陷 10）。
        // pendingQueue 非空时直接播种 batch（精确重放），pendingBetweenSteps 留 false。
        // pendingQueue 空且有 completedSteps 时 fallback 到 between-steps 反推。
        pendingResumes: resumeSubagents === undefined
          ? []
          : resumeSubagents.map(rs => ({
            nodeId: rs.step.id,
            step: rs.step,
            executed: rs.executed,
            childId: rs.childId,
          })),
        pendingBetweenSteps: resumeBetweenSteps === true && (pendingQueue === undefined || pendingQueue.length === 0),
      };
    }
    const batch: string[] = [];
    const firstStep = this.steps[0];
    if (firstStep !== undefined) {
      batch.push(firstStep.id);
    }
    return {
      stepIndex,
      executedSteps: [],
      previousOutputs: [],
      passThroughVars,
      batch,
      batchIndex: 0,
      nextBatch: [],
      status: 'completed',
      errorDetail: undefined,
      pendingAsk: undefined,
      pendingPaused: undefined,
      pendingResumes: [],
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
   * fork 类压缩下一 step 上下文摘要（补充 36）。
   *
   * fork 当前 step 会话 → `deriveMessages` 全量历史 → 用压缩 prompt 跑 `llm.stream` →
   * 产出摘要作为该 step 的「输出」（`returnPrompt`）传给下一 step（**替代全量 textSummary**）。
   * fork 失败（合成 session/非 live）或压缩失败降级为全量 `textSummary`（保留兼容）。
   * 仅 agent/skill/mcp 真实子代理走压缩；prompt/shell 合成 session 直接降级全量。
   */
  private async compressStepOutput(
    executed: ExecutedStepDefault,
    vars: Readonly<Record<string, string>>,
  ): Promise<PreviousStepOutput> {
    // 缺陷 16：收集产物文件填 base.files（前置产物 <artifacts> 块）。压缩逻辑
    // （fork/llm.stream/降级，补充 36）保持不动——仅在 base 构造处接入产物收集。
    // 缺陷 34：用引擎累加器值替换 outputTo 中的 ${xxx}（自引用变量此时未提取→deferred）。
    const stepArtifacts = await collectStepArtifacts(this.options.ctx.fs, executed, this.options.sharedState.cwd, vars);
    const base = toPreviousOutput(executed, stepArtifacts.flatMap(a => a.value));
    const meta = executed.sessionMeta;
    const childId = meta !== undefined && meta.synthetic === false ? meta.childId : undefined;
    const fork = forkStepSessionMessages(this.options.ctx, childId);
    if (fork === undefined) {
      return base;
    }
    const route = await resolveProviderModel({}, this.options.runnerConfig, this.options.ctx.llm);
    const messages: Message[] = [...fork.messages, createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: COMPRESS_PROMPT }],
    })];
    try {
      const assembler = new BlockAssembler();
      const stream = this.options.ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      });
      for await (const chunk of stream) {
        assembler.push(chunk);
      }
      const finish = assembler.finish;
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        this.options.ctx.logger.warn('sandore: step output compression degraded to full text');
        return base;
      }
      const summary = textSummary(assembler.blocks());
      return summary === '' ? base : { ...base, returnPrompt: summary };
    } catch (error) {
      this.options.ctx.logger.warn(`sandore: step output compression failed: ${describeError(error)}`);
      return base;
    }
  }

  /**
   * 主调度循环：批量工作队列真并发驱动（缺陷 10 队列驱动真并发改造）。
   *
   * **并发模型**（对齐基准 Promise.race + pendingQueue）：
   * - batch 内节点分两批处理：路由节点串行（preserve loopManager state consistency），
   *   命令节点并发（limiter 控制全局 Step 并发度）。
   * - 路由节点（resolveNextNodes/分支评估）轻量不跑 subagent，不 acquire limiter。
   * - 命令节点（subagent/shell/prompt）在 processCommandNode 前 acquire limiter，
   *   finally release。maxConcurrentSteps=0 时无上限（UnlimitedLimiter）。
   * - 并行分支（multiple nextNodeIds）真并发执行（Promise.all，不再逐个串行）。
   *
   * **计数模型并发安全**（缺陷 3 不改语义）：处理节点**之前**对每个节点
   * visitCount +1（串行递增，DAG 结构保证同 nodeId 在一个 batch 内不重复）。
   * recordScopeVisit 把节点记入活跃循环作用域集。回边/checkLoopBreak 只读不递增。
   *
   * **终止语义**：任何命令节点产出 failed/paused/ask 时停止推进（剩余未启动节点跳过）。
   * 多个命令节点并发产出不同终止态时按优先级 failed > paused > ask 取最终状态。
   *
   * @param state - Stage 运行时状态（batch/nextBatch 驱动循环）。
   */
  private async runLoop(state: StageRunState): Promise<void> {
    const { visitCounts, loopManager } = this.options;
    // 崩溃恢复/重试续跑：resume 收尾已把剩余 Step 写入 nextBatch，而 batch 为空，
    // 需先晋升 nextBatch 为 batch 才能继续推进（正常首轮 batch 非空时此分支无副作用）。
    if (state.batch.length === 0) {
      state.batch = [...new Set(state.nextBatch)];
      state.nextBatch = [];
      state.batchIndex = 0;
    }
    while (state.batch.length > 0) {
      // 单一递增点（对齐基准 processNode L93-94）：处理节点**之前**对每个节点
      // visitCount +1，路由门与命令门一致。回边/checkLoopBreak 只读不递增，
      // 根治命令门双重计数（缺陷 3 case ①）。recordScopeVisit 把节点记入活跃
      // 循环作用域集，供跳出时 resetLoopVisitCounts 归零。
      //
      // 串行递增（此 for 循环内同步执行）：DAG dedupe 保证同 nodeId 在一个 batch 内
      // 不重复 → 并发下不同 nodeId 各自递增互不冲突（计数模型并发安全确认）。
      const routingNodes: Array<{ nodeId: string; step: MergedStep }> = [];
      const commandNodes: Array<{ nodeId: string; step: WorkflowStep }> = [];
      for (const nodeId of state.batch) {
        const step = state.stepIndex.get(nodeId);
        if (step === undefined) {
          // 跨阶段或 Stage 级目标：由引擎 tryAdvanceStage 承接。
          continue;
        }
        visitCounts[nodeId] = (visitCounts[nodeId] ?? 0) + 1;
        loopManager.recordScopeVisit(nodeId);
        const isRoutingNode = step.command === undefined && step.branches !== undefined;
        if (isRoutingNode) {
          routingNodes.push({ nodeId, step });
        } else {
          commandNodes.push({ nodeId, step });
        }
      }
      state.batch = [];
      state.batchIndex = 0;

      // 路由节点串行处理（preserve loopManager activeLoopStack state consistency —
      // 两个不同循环节点并发处理会破坏栈状态；路由节点轻量不跑 subagent，串行无吞吐损失）。
      for (const { nodeId, step } of routingNodes) {
        await this.processRoutingNode(nodeId, step, state);
      }

      // 命令节点并发处理（limiter 控制全局 Step 并发度，路由节点不占槽）。
      // Promise.all 等待全部命令节点完成；任一产出终止态时剩余未 acquire 的节点跳过。
      const outcomes = await Promise.all(
        commandNodes.map(({ nodeId, step }) =>
          this.processCommandNodeWithLimiter(nodeId, step, state),
        ),
      );

      // 聚合终止态：failed > paused > ask > completed（processCommandNode 各自已设
      // state.status + pending 状态，此处按优先级确定最终状态）。
      // 注：并发下多个命令节点同时产出 ask/paused 时仅保留最后一个的 pending 状态
      // （last-write-wins 限制）；failed 优先级最高，任一 failed 即整 Stage failed。
      let finalStatus: StepStatus = 'completed';
      for (const outcome of outcomes) {
        if (outcome === 'failed') {
          finalStatus = 'failed';
          break;
        }
        if (outcome === 'paused' && finalStatus === 'completed') {
          finalStatus = 'paused';
        }
        if (outcome === 'ask' && finalStatus === 'completed') {
          finalStatus = 'interacting';
        }
      }
      if (finalStatus !== 'completed') {
        state.status = finalStatus;
        return;
      }
      state.status = 'completed';

      // 晋升 nextBatch 为下一轮 batch（dedupe 保证同 nodeId 不重复）。
      state.batch = [...new Set(state.nextBatch)];
      state.nextBatch = [];
    }
  }

  /**
   * 带 limiter 的命令节点处理（缺陷 10 队列驱动真并发改造）。
   *
   * acquire limiter → processCommandNode → finally release。
   * 路由节点不 acquire（轻量不跑 subagent，不占槽）。maxConcurrentSteps=0 时
   * UnlimitedLimiter 立即返回（无上限）。终止态已发生时跳过（不 acquire）。
   */
  private async processCommandNodeWithLimiter(
    nodeId: string,
    step: WorkflowStep,
    state: StageRunState,
  ): Promise<'ok' | 'ask' | 'failed' | 'paused' | 'skipped'> {
    // 终止态已发生（其他并发节点先产出 failed/paused/ask）：跳过不 acquire。
    // 用方法调用避免 TS 控制流收窄（await 后 state.status 可能已变，但 TS 不会 un-narrow）。
    if (this.isTerminalState(state)) {
      return 'skipped';
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
      await this.persist(routingEntry, state);
    }
    state.nextBatch.push(...routed.nextNodeIds);
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
      return 'failed';
    }
  }

  /**
   * 命令节点执行成功后的公共收尾（5 阶段重构）：回填输出/会话元数据 →
   * **Phase A**（评估，ask 保底判断）→ **Phase B**（收尾：透传变量回写 + finalizeMeta）
   * → **Phase C**（门禁：真实 fork 会话）→ 压缩输出 → 事件 → 推进下一批。
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

    // Phase A：评估（ask 保底判断）。
    const phaseA = await this.runPhaseA(nodeId, step, executed, context, gates, state);
    if (phaseA.kind === 'ask') {
      return 'ask';
    }

    // Phase B：收尾（重新 fork + 重新 assess）→ Phase C：门禁（真实 fork 会话）→ 尾段。
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
    return {
      input: this.options.input.originalInput,
      output: textSummary(executed.output),
      artifacts,
    };
  }

  /** Phase B → Phase C → 尾段（finishCommandNode 与 resumePendingAsk 共用）。 */
  private async runPhasesBC(
    nodeId: string,
    step: WorkflowStep,
    childId: string,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    state: StageRunState,
  ): Promise<'ok' | 'failed'> {
    // Phase B：**重新 fork + 重新 assess**（偏离 2：不复用 Phase A 结果——ask 轮次后
    // 子代理会话已有新消息，必须从最新消息重新 fork 评估；透传变量回写 + finalizeMeta
    // currentPhase='finalizing'）。
    const phaseBAssessResult = await this.runPhaseB(step, executed, context, gates, state);
    // Phase C：门禁（真实 fork 会话）。
    const phaseC = await this.runPhaseC(step, childId, executed, context, gates, phaseBAssessResult, state);
    if (phaseC.kind === 'failed') {
      return 'failed';
    }
    // Phase C 后、completed 前：压缩输出 + finalizeMeta 终态 + 推进下一批。
    await this.completeAfterFinalize(nodeId, step, childId, executed, context, gates, phaseBAssessResult, phaseC.gateResult, state);
    return 'ok';
  }

  /**
   * Phase A：评估（完成判定 + 透传变量提取 + ask 保底判断）。
   *
   * 跳过检查（无未解析透传变量且无门禁 → 零 AI 调用直接 ok）；否则 `assessOnly` 只跑
   * 评估器。`hasAsk` + askQuestion 载荷 → Step 置 interacting（finalizeMeta
   * currentPhase='ask-detect'，**不记录顶层 assessSessionId**）+ persist + 挂回
   * pendingAsk + 返回 'ask'（引擎级 ask 闭环）。`rounds` 为已发生的 ask 轮次（首次 0）；
   * 达到 {@link MAX_FINALIZE_ASK_ROUNDS} 后不再续问，把最后 output 视为完成（hasAsk
   * 保留在结果中，按普通输出推进 Phase B/C）。
   *
   * **fork 会话持久化规则（对齐计划）**：Phase A 评估 fork 会话**用完即删**——live
   * 引用在评估返回后即释放（不常驻、不持久化到 state）；`assessSessionId` 自 Phase B
   * （收尾）起才经 finalizeMeta 持久化到 state（assessResult.forkSessionId 因 schema
   * 强约束随结果落 state）。
   *
   * **fork 会话回收（偏离 3，DSH API 查证）**：`ctx.sessions`（SessionStore）**无公共
   * `delete` 方法**（公共 API：create/prepare/enter/fork/get/list），fork 返回的
   * `Session` handle 亦无 `dispose()`——DSH 的会话清理是 **fiber 作用域生命周期**：
   * `create`/`fork` 内部经 `ctx.effect` 把会话 detach 绑定到调用 fiber，fiber 卸载时
   * 自动从 store 移除（emit `session/disposed`，持久化 coordinator 随之 retire）。
   * 故 Phase A 临时评估 fork 会话的等价清理 = **不持久化、不保留引用 + 随执行 fiber
   * 卸载自动回收**（本方法不做任何 `delete` 调用；见偏离 3 报告）。
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
      await finalizeManager.commitFinalize(
        this.buildFinalizeRequest(step, executed, context, gates, state),
        assessResult,
        undefined,
        'ask-detect',
        { recordAssessSession: false },
      );
      // ask 中断点持久化（崩溃恢复需要 running Step 快照含 finalizeMeta currentPhase='ask-detect'）。
      await this.persist(executed, state);
      state.pendingAsk = { nodeId, step, executed, rounds: rounds + 1 };
      state.status = 'interacting';
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
   * Phase B：收尾——**重新 fork + 重新 assess**（偏离 2 修复）。
   *
   * 不复用 Phase A 的评估结果：ask 轮次后真实子代理会话已基于回答产生新消息，
   * Phase B 必须从最新会话状态重新 fork 并跑 `assessOnly`（提取透传变量 + 总结），
   * 以该结果为权威（Phase C 门禁与 completed finalizeMeta 均以它为准）。返回
   * Phase B 的评估结果；跳过检查与 Phase A 同谓词（无未解析透传变量且无门禁 →
   * Phase A 未评估，Phase B 亦不重评估，保持零 AI 调用），此时返回 undefined。
   *
   * `commitFinalize('finalizing')` 把 Phase B 的 `forkSessionId` 持久化为顶层
   * `assessSessionId`（偏离 3：Phase A 评估 fork 用完即删、不持久化；自 Phase B 起
   * 才落 state）。
   */
  private async runPhaseB(
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    state: StageRunState,
  ): Promise<FinalizeAssessResult | undefined> {
    if (!hasUnresolvedPassThroughVars(step) && !hasEnabledGates(gates)) {
      return undefined;
    }
    // 预置 currentPhase='finalizing'（评估耗时期间 UI 展示「收尾中」；commitFinalize 落终态）。
    executed.finalizeMeta = { ...executed.finalizeMeta, currentPhase: 'finalizing' };
    const request = this.buildFinalizeRequest(step, executed, context, gates, state);
    const phaseBAssessResult = await this.options.finalizeManager.assessOnly(request);
    await this.options.finalizeManager.commitFinalize(request, phaseBAssessResult, undefined, 'finalizing');
    return phaseBAssessResult;
  }

  /**
   * Phase C：门禁审查（GateEvaluator，真实 fork 会话，gateSessionId 持久化到 state）。
   *
   * 门禁启用才运行；未通过 → Step failed（finalizeMeta currentPhase='gating' +
   * gateResult + errorDetail）+ P2 持久化 + onStepFailed。门禁禁用 → ok 无结果。
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
      return { kind: 'failed', message };
    }
    return { kind: 'ok', gateResult };
  }

  /**
   * 收尾公共尾段（Phase C 通过后、completed 前，4.11/4.12）：
   * **compressStepOutput**（fork 压缩，位置从收尾前移至门禁后）→ previousOutputs →
   * finalizeMeta 终态（currentPhase='completed'）→ resolveNextNodes → P3 持久化 →
   * 推进下一批。finishCommandNode 与 resumePendingAsk 共用。
   */
  private async completeAfterFinalize(
    nodeId: string,
    step: WorkflowStep,
    childId: string,
    executed: ExecutedStepDefault,
    context: FinalizeStepContext,
    gates: Gates | undefined,
    assessResult: FinalizeAssessResult | undefined,
    gateResult: GateEvalResult | undefined,
    state: StageRunState,
  ): Promise<'ok'> {
    // Phase C 后、completed 前：compressStepOutput（缺陷 16 内收集产物文件填 base.files）。
    const previousOutput = await this.compressStepOutput(executed, toVarMap(state.passThroughVars));
    state.previousOutputs.push(previousOutput);
    // finalizeMeta 终态（currentPhase='completed'；含 gateResult；vars 已由 Phase B 回写，
    // 此处幂等重写）。
    if (assessResult !== undefined || gateResult !== undefined) {
      await this.options.finalizeManager.commitFinalize(
        this.buildFinalizeRequest(step, executed, context, gates, state),
        assessResult,
        gateResult,
        'completed',
      );
    }
    const routed = await this.options.stepNavigator.resolveNextNodes(nodeId, this.buildContext(state));
    if (routed.branchMeta !== undefined) {
      executed.branchMeta = routed.branchMeta;
    }
    if (routed.loopMeta !== undefined) {
      executed.loopMeta = routed.loopMeta;
    }
    // 偏离 1：收尾全流程保持 running，**最后才置 completed**（P3 completed 持久化携带
    // 终态 status；无中间 completed 脏状态）。
    executed.status = 'completed';
    executed.updatedAt = now();
    // P3 completed 持久化（含 branchMeta/loopMeta 与终态 finalizeMeta）。
    await this.persist(executed, state);
    state.nextBatch.push(...routed.nextNodeIds);
    state.status = 'completed';
    return 'ok';
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

  /**
   * 多路崩溃恢复续跑（缺陷 10）：并发崩溃时多个 running/interacting 段各自续跑。
   *
   * 用 Promise.all 并发续跑全部 pendingResumes（各调 resumeSubagentStep → finishCommandNode）。
   * 终止态聚合：任一 failed/ask 即返回（对齐 runLoop 聚合语义）。pendingResumes 各自
   * 的 finishCommandNode → resolveNextNodes → nextBatch.push（synchronous push，并发安全）。
   */
  private async resumePendingResumes(state: StageRunState): Promise<'ok' | 'ask' | 'failed' | 'paused'> {
    const resumes = [...state.pendingResumes];
    state.pendingResumes = [];
    const outcomes = await Promise.all(
      resumes.map(pending =>
        this.resumeSubagentStep(state, pending.nodeId, pending.step, pending.executed, pending.childId),
      ),
    );
    // 聚合终止态：failed > paused > ask > ok（re-pause 期间用户可再次暂停 → settle aborted）。
    let finalStatus: 'ok' | 'ask' | 'failed' | 'paused' = 'ok';
    for (const outcome of outcomes) {
      if (outcome === 'failed') {
        finalStatus = 'failed';
        break;
      }
      if (outcome === 'paused' && finalStatus === 'ok') {
        finalStatus = 'paused';
      }
      if (outcome === 'ask' && finalStatus === 'ok') {
        finalStatus = 'ask';
      }
    }
    return finalStatus;
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
   * 3 阶段收尾（Phase A 重评估 → Phase B 重新 fork + 重新 assess → Phase C 门禁）
   * → 压缩 → 推进。
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
   * 持久化回调封装（缺陷 10 恢复可靠性增强）：snapshot pendingQueue（batch + nextBatch
   * 的 Step IDs）随 executed 一起传入 onPersist → 引擎写入 WorkflowTaskState.pendingQueue。
   * 崩溃恢复时直接读回 pendingQueue → re-queue ready Steps（精确重放，不再反推 DAG next）。
   */
  private async persist(executed: ExecutedStepDefault, state: StageRunState): Promise<void> {
    const pendingQueue = [...new Set([...state.batch, ...state.nextBatch])];
    await this.options.onPersist?.(executed, pendingQueue);
  }
}
