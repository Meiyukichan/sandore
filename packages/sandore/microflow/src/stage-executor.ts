/**
 * Stage 内部执行器（Task 2 简化：按 `steps` 数组顺序线性执行）。
 *
 * 逐个调用 {@link StepRunner} 执行 Stage 内 Step，收集 `ExecutedStepDefault[]`，
 * 组装 `StageContract`（stageId/stageName/status/artifacts/passThroughVars/
 * contractArtifacts/completedAt），并透传 `passThroughVars`。失败即中止后续
 * Step，返回整体 `status` 与 `errorDetail`。每个 Step 完成后经 `onPersist`
 * 钩子通知引擎逐 Step 持久化。
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
import type { WorkflowDefinition, WorkflowStage, WorkflowStep, WorkflowTaskState } from '../../workflow/src/schema.ts';

import { describeError, textSummary } from './internal.ts';
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

/**
 * Stage 内部执行器。
 *
 * 构造时绑定 Stage 定义、共享状态与 StepRunner 配置；`execute()` 按 `steps`
 * 数组顺序执行，遇到失败即中止，最终返回 StageContract 与执行结果。
 */
export class StageExecutor {
  private readonly runner: StepRunner;

  constructor(private readonly options: StageExecutorOptions) {
    this.runner = new StepRunner(options.ctx, options.runnerConfig);
  }

  /** 执行本 Stage 内全部 Step。 */
  async execute(): Promise<StageExecutionResult> {
    const { stageDef, input, sharedState, signal, hooks } = this.options;
    const executedSteps: ExecutedStepDefault[] = [];
    const previousOutputs: PreviousStepOutput[] = [];
    let status: StepStatus = 'completed';
    let errorDetail: string | undefined;

    for (const step of stageDef.steps) {
      const childId = synthesizeChildId(step.id);
      const command = step.command;
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
        visitCount: 1,
      };

      hooks?.onStepStart(step, childId);

      if (command === undefined) {
        const message = `step '${step.id}' has no command`;
        executed.status = 'failed';
        executed.error = message;
        executedSteps.push(executed);
        hooks?.onStepFailed(step, childId, message);
        await this.options.onPersist?.(executed);
        status = 'failed';
        errorDetail = message;
        break;
      }

      try {
        const result = await this.runner.run({
          step,
          workdir: sharedState.cwd,
          originalInput: input.originalInput,
          previousOutputs,
          ...(signal === undefined ? {} : { signal }),
        });
        executed.status = 'completed';
        executed.output = result.output;
        executedSteps.push(executed);
        previousOutputs.push(toPreviousOutput(executed));
        hooks?.onStepCompleted(step, childId, result.output);
        await this.options.onPersist?.(executed);
      } catch (error) {
        const message = describeError(error);
        executed.status = 'failed';
        executed.error = message;
        executedSteps.push(executed);
        hooks?.onStepFailed(step, childId, message);
        await this.options.onPersist?.(executed);
        status = 'failed';
        errorDetail = message;
        break;
      }
    }

    const passThroughVars = collectPassThroughVars(stageDef);
    const stageContract = finalizeStageContract(stageDef, executedSteps, status, passThroughVars, errorDetail);
    return { stageContract, executedSteps, passThroughVars, status, ...(errorDetail === undefined ? {} : { errorDetail }) };
  }
}
