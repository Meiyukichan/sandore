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
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import type {
  ExecutedStepDefault,
  PassThroughVar,
  StageContract,
  StepStatus,
} from '@deepseek-ai/dsh-sandore-workflow/src/types';
import type { FinalizeAssessResult, DagBranch, Gates, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '@deepseek-ai/dsh-sandore-workflow/src/schema';
import type { ResolveNextNodesContext, ResolveNextNodesResult } from '@deepseek-ai/dsh-sandore-workflow/src/dag-navigator';

import { FinalizeManager } from './finalize-manager.ts';
import { describeError, isCancellationError, textSummary } from './internal.ts';
import { LoopManager } from './loop-manager.ts';
import { StepRunner } from './step-runner.ts';
import type { StepRunnerConfig, PreviousStepOutput, StepRunResult } from './step-runner.ts';

/** 分离式合并后的完整 Step：完整定义（command/映射等）+ 流控 branches。 */
export type MergedStep = WorkflowStep & { readonly branches?: DagBranch[] | undefined };

/** Stage 执行输入（原始需求 + 前置契约产物 + 透传变量）。 */
export interface StageExecutionInput {
  readonly originalInput: string;
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
  readonly jobId: string;
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
  /** 单个 Step 完成/失败后的持久化回调（由引擎注入，逐 Step 持久化状态快照）。 */
  readonly onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void;
  /** 循环管理器（引擎共享：ID 后缀 + 迭代路径）。 */
  readonly loopManager: LoopManager;
  /** 收尾管理器（透传变量提取 + 门禁审查）。 */
  readonly finalizeManager: FinalizeManager;
  /** Step 级调度单一入口（由引擎绑定 `WorkflowDagNavigator.resolveNextNodes`）。 */
  readonly resolveNextNodes: (nodeId: string, context: ResolveNextNodesContext) => Promise<ResolveNextNodesResult>;
  /** 节点访问计数（引擎共享，持久化于 `WorkflowTaskState.visitCounts`）。 */
  readonly visitCounts: Record<string, number>;
  /** 崩溃恢复/重试续跑播种：跳过已完成 Step 并从指定子代理 Step 续跑。 */
  readonly resumeFrom?: StageExecutorResume;
}

/** Stage 断点续跑播种（从快照重建执行位置，跳过已完成 Step 并续跑指定子代理 Step）。 */
export interface StageExecutorResume {
  /** 已完成 Step 快照（跳过不重跑，用于重建 previousOutputs 与 executedSteps）。 */
  readonly completedSteps: readonly ExecutedStepDefault[];
  /** 需续跑的子代理 Step（携带原 executed 条目，`finishCommandNode` 原地复用）。 */
  readonly resumeSubagent: {
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    readonly childId: string;
  };
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

/** 将已完成 Step 映射为 prompt 参考信息。 */
function toPreviousOutput(step: ExecutedStepDefault): PreviousStepOutput {
  return {
    name: step.name,
    id: step.stepId ?? step.id,
    returnPrompt: textSummary(step.output),
    files: [],
  };
}

/** 组装 Stage 产物契约。 */
function finalizeStageContract(
  stageDef: WorkflowStage,
  executedSteps: readonly ExecutedStepDefault[],
  status: StepStatus,
  passThroughVars: Record<string, PassThroughVarValue>,
  errorDetail: string | undefined,
): StageContract {
  const artifacts: StageContract['artifacts'] = [];
  for (const step of executedSteps) {
    for (const outputTo of step.outputTo ?? []) {
      const returnPrompt = textSummary(step.output);
      artifacts.push({
        stepId: step.stepId ?? step.id,
        outputToId: outputTo.id,
        files: [],
        ...(returnPrompt === '' ? {} : { returnPrompt }),
      });
    }
  }
  return {
    stageId: stageDef.id,
    stageName: stageDef.name,
    status,
    artifacts,
    passThroughVars,
    contractArtifacts: {},
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
  /** ask 断点：等待回复的 Step 及其收尾评估结果（resume 时重跑门禁 + 推进下一批）。 */
  pendingAsk: {
    readonly nodeId: string;
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    readonly assessResult: FinalizeAssessResult;
  } | undefined;
  /** paused 断点：被 interrupt 打断且命中暂停登记表的子代理 Step（resume 后重新收集输出续跑）。 */
  pendingPaused: {
    readonly nodeId: string;
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    readonly childId: string;
  } | undefined;
  /** resume 断点：崩溃恢复/重试续跑的子代理 Step（从快照播种，resumeSubagent 重新收集输出）。 */
  pendingResume: {
    readonly nodeId: string;
    readonly step: WorkflowStep;
    readonly executed: ExecutedStepDefault;
    readonly childId: string;
  } | undefined;
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
      onChildStarted: (stepId, childId) => {
        this.realChildIds.set(stepId, childId);
        onChildStarted(stepId, childId);
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
      state = this.initState();
      this.runState = state;
    }
    if (state.pendingPaused !== undefined) {
      const resumed = await this.resumePendingPaused(state);
      if (resumed !== 'ok') {
        // ask 中断（续跑收尾判定为 ask）或 failed：返回结果，交由引擎 ask/失败循环处理。
        return this.buildResult(state);
      }
    }
    if (state.pendingResume !== undefined) {
      const resumed = await this.resumePendingResume(state);
      if (resumed !== 'ok') {
        return this.buildResult(state);
      }
    }
    if (state.pendingAsk !== undefined) {
      const resumed = await this.resumePendingAsk(state);
      if (resumed === 'failed') {
        return this.buildResult(state);
      }
    }
    await this.runLoop(state);
    return this.buildResult(state);
  }

  /** 初始化断点续跑状态（首次调用 execute 时）。 */
  private initState(): StageRunState {
    const { input } = this.options;
    const stepIndex = new Map<string, MergedStep>();
    for (const step of this.steps) {
      stepIndex.set(step.id, step);
    }
    const passThroughVars: Record<string, PassThroughVarValue> = {
      ...(input.passThroughVars as Record<string, PassThroughVarValue>),
      ...collectPassThroughVars(this.steps),
    };
    // 崩溃恢复/重试续跑播种：跳过已完成 Step，续跑指定子代理 Step（原 executed 条目复用）。
    const resumeFrom = this.options.resumeFrom;
    if (resumeFrom !== undefined) {
      const { completedSteps, resumeSubagent } = resumeFrom;
      return {
        stepIndex,
        executedSteps: [...completedSteps],
        previousOutputs: completedSteps.map(toPreviousOutput),
        passThroughVars,
        batch: [],
        batchIndex: 0,
        nextBatch: [],
        status: 'running',
        errorDetail: undefined,
        pendingAsk: undefined,
        pendingPaused: undefined,
        pendingResume: {
          nodeId: resumeSubagent.step.id,
          step: resumeSubagent.step,
          executed: resumeSubagent.executed,
          childId: resumeSubagent.childId,
        },
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
      pendingResume: undefined,
    };
  }

  /** 组装调度上下文（透传变量字符串映射 + 访问计数 + 取消信号）。 */
  private buildContext(state: StageRunState): ResolveNextNodesContext {
    const { signal, visitCounts } = this.options;
    return {
      visitCounts,
      passThroughVars: toVarMap(state.passThroughVars),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  /** 主调度循环：逐批推进，遇到 ask/failed 停止（状态保留在 runState 供续跑）。 */
  private async runLoop(state: StageRunState): Promise<void> {
    // 崩溃恢复/重试续跑：resume 收尾已把剩余 Step 写入 nextBatch，而 batch 为空，
    // 需先晋升 nextBatch 为 batch 才能继续推进（正常首轮 batch 非空时此分支无副作用）。
    if (state.batch.length === 0) {
      state.batch = [...new Set(state.nextBatch)];
      state.nextBatch = [];
      state.batchIndex = 0;
    }
    while (state.batch.length > 0) {
      while (state.batchIndex < state.batch.length) {
        const nodeId = state.batch[state.batchIndex]!;
        state.batchIndex += 1;
        const step = state.stepIndex.get(nodeId);
        if (step === undefined) {
          // 跨阶段或 Stage 级目标：由引擎 tryAdvanceStage 承接。
          continue;
        }
        const isRoutingNode = step.command === undefined && step.branches !== undefined;
        if (isRoutingNode) {
          await this.processRoutingNode(nodeId, step, state);
          continue;
        }
        const outcome = await this.processCommandNode(nodeId, step, state);
        if (outcome === 'ask' || outcome === 'failed' || outcome === 'paused') {
          return;
        }
      }
      state.batch = [...new Set(state.nextBatch)];
      state.nextBatch = [];
      state.batchIndex = 0;
    }
  }

  /** 路由节点：resolveNextNodes 产出下一批，分支/循环评估现场回写路由条目。 */
  private async processRoutingNode(nodeId: string, step: MergedStep, state: StageRunState): Promise<void> {
    const { stageDef, loopManager, resolveNextNodes, visitCounts } = this.options;
    const routed = await resolveNextNodes(nodeId, this.buildContext(state));
    // 纯循环控制节点（无 command 且仅 loop 分支）平时不产生路由条目，仅在 breakCondition
    // 评估跳出（loopMeta）时回写；带 condition/并行分支的决策节点始终记录 branchMeta。
    const isLoopControl = step.command === undefined
      && (step.branches ?? []).every(branch => branch.loop !== undefined);
    const hasBranchMeta = routed.branchMeta !== undefined;
    const hasLoopMeta = routed.loopMeta !== undefined;
    if (!isLoopControl || hasBranchMeta || hasLoopMeta) {
      const inLoopRouting = loopManager.buildLoopIterationPath().length > 0;
      const routingChildId = inLoopRouting ? loopManager.getActualStepId(step.id) : synthesizeChildId(step.id);
      const routingEntry: ExecutedStepDefault = {
        type: 'default',
        id: routingChildId,
        stepId: step.id,
        stageId: stageDef.id,
        name: step.name ?? step.id,
        status: 'completed',
        visitCount: (visitCounts[nodeId] ?? 0) + 1,
        ...(inLoopRouting ? { loopIteration: loopManager.buildLoopIterationPath() } : {}),
        ...(hasBranchMeta ? { branchMeta: routed.branchMeta } : {}),
        ...(hasLoopMeta ? { loopMeta: routed.loopMeta } : {}),
      };
      visitCounts[nodeId] = routingEntry.visitCount;
      state.executedSteps.push(routingEntry);
      await this.options.onPersist?.(routingEntry);
    }
    state.nextBatch.push(...routed.nextNodeIds);
  }

  /** 命令节点：run + finalize + resolveNextNodes；ask 中断 / 失败 / 暂停时返回对应标记。 */
  private async processCommandNode(nodeId: string, step: WorkflowStep, state: StageRunState): Promise<'ok' | 'ask' | 'failed' | 'paused'> {
    const { stageDef, input, sharedState, signal, hooks, loopManager, visitCounts } = this.options;
    const command = step.command;
    const inLoop = loopManager.buildLoopIterationPath().length > 0;
    const childId = inLoop ? loopManager.getActualStepId(step.id) : synthesizeChildId(step.id);
    const executed: ExecutedStepDefault = {
      type: 'default',
      id: childId,
      stepId: step.id,
      stageId: stageDef.id,
      name: step.name ?? step.id,
      status: 'running',
      ...(command === undefined ? {} : { command }),
      ...(step.inputFrom === undefined ? {} : { inputFrom: step.inputFrom }),
      ...(step.outputTo === undefined ? {} : { outputTo: step.outputTo }),
      ...(step.passThroughVars === undefined ? {} : { passThroughVars: step.passThroughVars }),
      ...(command === undefined
        ? {}
        : { sessionMeta: { childId, synthetic: true, command: command.type } }),
      visitCount: (visitCounts[nodeId] ?? 0) + 1,
      ...(inLoop ? { loopIteration: loopManager.buildLoopIterationPath() } : {}),
    };
    visitCounts[nodeId] = executed.visitCount;

    hooks?.onStepStart(step, childId);
    // 持久化 running 快照（暂停定位与崩溃恢复需要 executedSteps 含运行中 Step）。
    await this.options.onPersist?.(executed);

    if (command === undefined) {
      const message = `step '${step.id}' has no command`;
      executed.status = 'failed';
      executed.error = message;
      state.executedSteps.push(executed);
      hooks?.onStepFailed(step, childId, message);
      await this.options.onPersist?.(executed);
      state.status = 'failed';
      state.errorDetail = message;
      return 'failed';
    }

    try {
      const loopContext = loopManager.getLoopIterationContext();
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
      });
      return await this.finishCommandNode(nodeId, step, childId, executed, result, state);
    } catch (error) {
      // 取消类错误：`interrupt` 打断 whenIdle/执行 Promise 时以取消结束。查暂停登记表
      // 命中 → Step 保持 paused（不落 failed、不发 step-failed）；未命中 → 按失败处理。
      if (isCancellationError(error) && this.isPausedStep(step.id)) {
        executed.status = 'paused';
        state.executedSteps.push(executed);
        state.status = 'paused';
        state.pendingPaused = { nodeId, step, executed, childId: this.realChildIds.get(step.id) ?? childId };
        return 'paused';
      }
      const message = describeError(error);
      executed.status = 'failed';
      executed.error = message;
      // 失败时同步真实子代理 childId（onChildStarted 已记录），供重试/暂停反查真实 child 续跑。
      const realChildId = this.realChildIds.get(step.id);
      if (executed.sessionMeta !== undefined && realChildId !== undefined) {
        executed.sessionMeta = { ...executed.sessionMeta, childId: realChildId, synthetic: false };
      }
      state.executedSteps.push(executed);
      hooks?.onStepFailed(step, realChildId ?? childId, message);
      await this.options.onPersist?.(executed);
      state.status = 'failed';
      state.errorDetail = message;
      return 'failed';
    }
  }

  /**
   * 命令节点执行成功后的公共收尾：回填输出/会话元数据 → 收尾（finalize）→ ask 中断 /
   * 失败 / 推进下一批。首次执行、暂停续跑与崩溃恢复/重试续跑共用：`executed` 仅在尚未
   * 进入 executedSteps 时纳入（按唯一执行 id 去重），暂停续跑已在列表中则原地复用。
   */
  private async finishCommandNode(
    nodeId: string,
    step: WorkflowStep,
    childId: string,
    executed: ExecutedStepDefault,
    result: StepRunResult,
    state: StageRunState,
  ): Promise<'ok' | 'ask' | 'failed'> {
    const { stageDef, input, sharedState, signal, hooks, finalizeManager, resolveNextNodes } = this.options;
    executed.status = 'completed';
    executed.output = result.output;
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
    state.previousOutputs.push(toPreviousOutput(executed));
    hooks?.onStepCompleted(step, result.sessionMeta?.childId ?? childId, result.output);

    const gates = mergeGates(this.options.workflowDef, stageDef, step);
    const finalizeOutcome = await finalizeManager.finalizeStep({
      step,
      executedStep: executed,
      ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
      context: { input: input.originalInput, output: textSummary(executed.output) },
      ...(gates === undefined ? {} : { gates }),
      workdir: sharedState.cwd,
      passThroughVars: state.passThroughVars,
      ...(signal === undefined ? {} : { signal }),
    });

    if (finalizeOutcome.type === 'ask') {
      // ask 中断：保留断点（剩余 Step 不丢失），等待引擎 ask 回复后续跑。
      await this.options.onPersist?.(executed);
      state.pendingAsk = { nodeId, step, executed, assessResult: finalizeOutcome.assessResult };
      state.status = 'interacting';
      return 'ask';
    }
    if (finalizeOutcome.type === 'error') {
      const message = finalizeOutcome.errorDetail;
      executed.status = 'failed';
      executed.error = message;
      hooks?.onStepFailed(step, result.sessionMeta?.childId ?? childId, message);
      await this.options.onPersist?.(executed);
      state.status = 'failed';
      state.errorDetail = message;
      return 'failed';
    }

    const routed = await resolveNextNodes(nodeId, this.buildContext(state));
    if (routed.branchMeta !== undefined) {
      executed.branchMeta = routed.branchMeta;
    }
    if (routed.loopMeta !== undefined) {
      executed.loopMeta = routed.loopMeta;
    }
    await this.options.onPersist?.(executed);
    state.nextBatch.push(...routed.nextNodeIds);
    state.status = 'completed';
    return 'ok';
  }

  /** pause 后从断点续跑：重新收集子代理输出（whenIdle + final output），随后走公共收尾。 */
  private async resumePendingPaused(state: StageRunState): Promise<'ok' | 'ask' | 'failed'> {
    const pending = state.pendingPaused!;
    state.pendingPaused = undefined;
    return this.resumeSubagentStep(state, pending.nodeId, pending.step, pending.executed, pending.childId);
  }

  /** 崩溃恢复/重试续跑：重新收集子代理输出（whenIdle + final output），随后走公共收尾。 */
  private async resumePendingResume(state: StageRunState): Promise<'ok' | 'ask' | 'failed'> {
    const pending = state.pendingResume!;
    state.pendingResume = undefined;
    return this.resumeSubagentStep(state, pending.nodeId, pending.step, pending.executed, pending.childId);
  }

  /** 续跑子代理 Step 的公共尾段：重新收集输出 + 公共收尾（finishCommandNode）。 */
  private async resumeSubagentStep(
    state: StageRunState,
    nodeId: string,
    step: WorkflowStep,
    executed: ExecutedStepDefault,
    childId: string,
  ): Promise<'ok' | 'ask' | 'failed'> {
    const command = step.command;
    if (command === undefined || (command.type !== 'agent' && command.type !== 'skill' && command.type !== 'mcp')) {
      // 理论不可达：续跑仅对子代理 Step 生效（shell/prompt 由 recovery/lifecycle 守卫拦截）。
      const message = `step '${step.id}' is not a resumable subagent step`;
      executed.status = 'failed';
      executed.error = message;
      await this.options.onPersist?.(executed);
      state.status = 'failed';
      state.errorDetail = message;
      return 'failed';
    }
    const result = await this.runner.resumeSubagent(command.type, childId, step.id, this.options.stageDef.id);
    return this.finishCommandNode(nodeId, step, childId, executed, result, state);
  }

  /** 取消类错误下，Step 是否命中暂停登记表（真实 childId 已暂停 → 保持 paused）。 */
  private isPausedStep(stepId: string): boolean {
    const childId = this.realChildIds.get(stepId);
    if (childId === undefined) {
      return false;
    }
    return this.options.runnerConfig.isPausedChild?.(childId) === true;
  }

  /** ask 回复后从断点续跑：重跑门禁审查，随后推进下一批节点。 */
  private async resumePendingAsk(state: StageRunState): Promise<'ok' | 'failed'> {
    const { stageDef, input, sharedState, signal, hooks, finalizeManager, resolveNextNodes } = this.options;
    const pending = state.pendingAsk!;
    state.pendingAsk = undefined;
    const { nodeId, step, executed, assessResult } = pending;

    const gates = mergeGates(this.options.workflowDef, stageDef, step);
    const finalizeOutcome = await finalizeManager.finalizeStepAfterAsk({
      step,
      executedStep: executed,
      ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
      context: { input: input.originalInput, output: textSummary(executed.output) },
      ...(gates === undefined ? {} : { gates }),
      workdir: sharedState.cwd,
      passThroughVars: state.passThroughVars,
      ...(signal === undefined ? {} : { signal }),
    }, assessResult);

    if (finalizeOutcome.type === 'error') {
      const message = finalizeOutcome.errorDetail;
      executed.status = 'failed';
      executed.error = message;
      hooks?.onStepFailed(step, executed.sessionMeta?.childId ?? executed.id, message);
      await this.options.onPersist?.(executed);
      state.status = 'failed';
      state.errorDetail = message;
      return 'failed';
    }

    // 门禁通过：状态回到 completed，resolveNextNodes 推进下一批。
    state.status = 'completed';
    const routed = await resolveNextNodes(nodeId, this.buildContext(state));
    if (routed.branchMeta !== undefined) {
      executed.branchMeta = routed.branchMeta;
    }
    if (routed.loopMeta !== undefined) {
      executed.loopMeta = routed.loopMeta;
    }
    await this.options.onPersist?.(executed);
    state.nextBatch.push(...routed.nextNodeIds);
    return 'ok';
  }

  /** 组装 Stage 执行结果。 */
  private buildResult(state: StageRunState): StageExecutionResult {
    const stageContract = finalizeStageContract(this.options.stageDef, state.executedSteps, state.status, state.passThroughVars, state.errorDetail);
    return {
      stageContract,
      executedSteps: state.executedSteps,
      passThroughVars: state.passThroughVars,
      status: state.status,
      ...(state.errorDetail === undefined ? {} : { errorDetail: state.errorDetail }),
    };
  }
}
