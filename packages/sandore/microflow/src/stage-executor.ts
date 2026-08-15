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
} from '../../workflow/src/types.ts';
import type { Gates, WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '../../workflow/src/schema.ts';
import type { ResolveNextNodesContext, ResolveNextNodesResult } from '../../workflow/src/dag-navigator.ts';

import { FinalizeManager } from './finalize-manager.ts';
import { describeError, textSummary } from './internal.ts';
import { LoopManager } from './loop-manager.ts';
import { StepRunner } from './step-runner.ts';
import type { StepRunnerConfig, PreviousStepOutput } from './step-runner.ts';

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

/** 收集 Stage 内全部 Step 定义的透传变量。 */
function collectPassThroughVars(stageDef: WorkflowStage): Record<string, PassThroughVarValue> {
  const result: Record<string, PassThroughVarValue> = {};
  for (const step of stageDef.steps) {
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
export class StageExecutor {
  private readonly runner: StepRunner;

  constructor(private readonly options: StageExecutorOptions) {
    this.runner = new StepRunner(options.ctx, options.runnerConfig);
  }

  /** 执行本 Stage 内全部 Step（DAG 调度循环）。 */
  async execute(): Promise<StageExecutionResult> {
    const { stageDef, input, sharedState, signal, hooks, loopManager, finalizeManager, resolveNextNodes, visitCounts } = this.options;
    const executedSteps: ExecutedStepDefault[] = [];
    const previousOutputs: PreviousStepOutput[] = [];
    const passThroughVars: Record<string, PassThroughVarValue> = {
      ...(input.passThroughVars as Record<string, PassThroughVarValue>),
      ...collectPassThroughVars(stageDef),
    };
    let status: StepStatus = 'completed';
    let errorDetail: string | undefined;

    const stepIndex = new Map<string, WorkflowStep>();
    for (const step of stageDef.steps) {
      stepIndex.set(step.id, step);
    }

    let batch: string[] = [];
    const firstStep = stageDef.steps[0];
    if (firstStep !== undefined) {
      batch.push(firstStep.id);
    }

    const buildContext = (): ResolveNextNodesContext => ({
      visitCounts,
      passThroughVars: toVarMap(passThroughVars),
      ...(signal === undefined ? {} : { signal }),
    });

    while (batch.length > 0) {
      const nextBatch: string[] = [];
      for (const nodeId of batch) {
        const step = stepIndex.get(nodeId);
        if (step === undefined) {
          // 跨阶段或 Stage 级目标：由引擎 tryAdvanceStage 承接。
          continue;
        }

        const isRoutingNode = step.command === undefined && (step.loop !== undefined || step.branches !== undefined);
        if (isRoutingNode) {
          const routed = await resolveNextNodes(nodeId, buildContext());
          // 分支决策点产出路由条目（记录 branchMeta）；循环控制点仅在 breakCondition
          // 评估跳出时回写 loopMeta 路由条目（循环体步骤记录迭代与 loopIteration）。
          if (step.branches !== undefined) {
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
              ...(routed.branchMeta === undefined ? {} : { branchMeta: routed.branchMeta }),
            };
            visitCounts[nodeId] = routingEntry.visitCount;
            executedSteps.push(routingEntry);
            await this.options.onPersist?.(routingEntry);
          } else if (step.loop !== undefined && routed.loopMeta !== undefined) {
            // 纯路由循环节点在 breakCondition 跳出时回写 loopMeta（checkLoopBreak 两阶段
            // 产出的 evaluating → completed 评估现场），持久化到 executedSteps。
            const routingEntry: ExecutedStepDefault = {
              type: 'default',
              id: synthesizeChildId(step.id),
              stepId: step.id,
              stageId: stageDef.id,
              name: step.name ?? step.id,
              status: 'completed',
              visitCount: visitCounts[nodeId] ?? 0,
              loopMeta: routed.loopMeta,
            };
            executedSteps.push(routingEntry);
            await this.options.onPersist?.(routingEntry);
          }
          nextBatch.push(...routed.nextNodeIds);
          continue;
        }

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

        if (command === undefined) {
          const message = `step '${step.id}' has no command`;
          executed.status = 'failed';
          executed.error = message;
          executedSteps.push(executed);
          hooks?.onStepFailed(step, childId, message);
          await this.options.onPersist?.(executed);
          return this.buildResult(stageDef, executedSteps, 'failed', passThroughVars, message);
        }

        try {
          const loopContext = loopManager.getLoopIterationContext();
          const result = await this.runner.run({
            step,
            workdir: sharedState.cwd,
            originalInput: input.originalInput,
            previousOutputs,
            passThroughVars: toVarMap(passThroughVars),
            loopTurn: loopContext.loopTurn,
            loopMaxIterations: loopContext.loopMaxIterations,
            ...(signal === undefined ? {} : { signal }),
          });
          executed.status = 'completed';
          executed.output = result.output;
          if (result.sessionMeta !== undefined) {
            executed.sessionMeta = {
              childId: result.sessionMeta.childId ?? childId,
              synthetic: result.sessionMeta.synthetic,
              command: result.sessionMeta.command,
            };
          }
          executedSteps.push(executed);
          previousOutputs.push(toPreviousOutput(executed));
          hooks?.onStepCompleted(step, result.sessionMeta?.childId ?? childId, result.output);

          const gates = mergeGates(this.options.workflowDef, stageDef, step);
          const finalizeOutcome = await finalizeManager.finalizeStep({
            step,
            executedStep: executed,
            ...(executed.sessionMeta?.childId === undefined ? {} : { stepSessionId: executed.sessionMeta.childId }),
            context: { input: input.originalInput, output: textSummary(executed.output) },
            ...(gates === undefined ? {} : { gates }),
            workdir: sharedState.cwd,
            passThroughVars,
            ...(signal === undefined ? {} : { signal }),
          });

          if (finalizeOutcome.type === 'ask') {
            // Task 4 接交互等待循环；Task 3 仅置 interacting 标记并中止 Stage。
            await this.options.onPersist?.(executed);
            return this.buildResult(stageDef, executedSteps, 'interacting', passThroughVars, undefined);
          }
          if (finalizeOutcome.type === 'error') {
            const message = finalizeOutcome.errorDetail;
            executed.status = 'failed';
            executed.error = message;
            hooks?.onStepFailed(step, result.sessionMeta?.childId ?? childId, message);
            await this.options.onPersist?.(executed);
            return this.buildResult(stageDef, executedSteps, 'failed', passThroughVars, message);
          }

          const routed = await resolveNextNodes(nodeId, buildContext());
          if (routed.branchMeta !== undefined) {
            executed.branchMeta = routed.branchMeta;
          }
          if (routed.loopMeta !== undefined) {
            executed.loopMeta = routed.loopMeta;
          }
          await this.options.onPersist?.(executed);
          nextBatch.push(...routed.nextNodeIds);
        } catch (error) {
          const message = describeError(error);
          executed.status = 'failed';
          executed.error = message;
          executedSteps.push(executed);
          hooks?.onStepFailed(step, childId, message);
          await this.options.onPersist?.(executed);
          return this.buildResult(stageDef, executedSteps, 'failed', passThroughVars, message);
        }
      }
      batch = [...new Set(nextBatch)];
    }

    return this.buildResult(stageDef, executedSteps, status, passThroughVars, errorDetail);
  }

  /** 组装 Stage 执行结果。 */
  private buildResult(
    stageDef: WorkflowStage,
    executedSteps: ExecutedStepDefault[],
    status: StepStatus,
    passThroughVars: Record<string, PassThroughVarValue>,
    errorDetail: string | undefined,
  ): StageExecutionResult {
    const stageContract = finalizeStageContract(stageDef, executedSteps, status, passThroughVars, errorDetail);
    return { stageContract, executedSteps, passThroughVars, status, ...(errorDetail === undefined ? {} : { errorDetail }) };
  }
}
